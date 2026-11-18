use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use tracing::warn;
use velo_protocol::SessionInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Bark key (e.g. `AbCdEf123456`) or full Bark endpoint (`https://api.day.app/AbCdEf123456`)
    #[serde(default)]
    pub bark_target: String,
    /// Optional generic webhook URL (Slack / Feishu / Discord / ntfy / custom APNs bridge)
    #[serde(default)]
    pub webhook_url: String,
    /// Zero-plaintext blind push: never includes prompt/code/title in push body
    #[serde(default = "default_true")]
    pub blind_mode: bool,
    #[serde(default = "default_true")]
    pub notify_on_permission: bool,
    #[serde(default = "default_true")]
    pub notify_on_complete: bool,
    #[serde(default = "default_true")]
    pub notify_on_error: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PushConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bark_target: String::new(),
            webhook_url: String::new(),
            blind_mode: true,
            notify_on_permission: true,
            notify_on_complete: true,
            notify_on_error: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushTriggerKind {
    PermissionRequired,
    QuestionRequired,
    TurnCompleted,
    TurnFailed,
    TestPing,
}

pub async fn load_push_config(path: &Path) -> PushConfig {
    if let Ok(raw) = tokio::fs::read_to_string(path).await {
        if let Ok(cfg) = serde_json::from_str::<PushConfig>(&raw) {
            return cfg;
        }
    }
    PushConfig::default()
}

pub async fn save_push_config(path: &Path, cfg: &PushConfig) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let s = serde_json::to_string_pretty(cfg)?;
    tokio::fs::write(path, s).await?;
    Ok(())
}

fn normalize_bark_endpoint(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("https://api.day.app/{}", trimmed))
    }
}

pub async fn send_push_notification(
    cfg: &PushConfig,
    kind: PushTriggerKind,
    session: Option<&SessionInfo>,
    extra_detail: Option<&str>,
) -> Value {
    if kind != PushTriggerKind::TestPing && !cfg.enabled {
        return json!({ "ok": false, "skipped": true, "reason": "disabled" });
    }
    match kind {
        PushTriggerKind::PermissionRequired | PushTriggerKind::QuestionRequired
            if !cfg.notify_on_permission =>
        {
            return json!({ "ok": false, "skipped": true, "reason": "permission_disabled" });
        }
        PushTriggerKind::TurnCompleted if !cfg.notify_on_complete => {
            return json!({ "ok": false, "skipped": true, "reason": "complete_disabled" });
        }
        PushTriggerKind::TurnFailed if !cfg.notify_on_error => {
            return json!({ "ok": false, "skipped": true, "reason": "error_disabled" });
        }
        _ => {}
    }

    let deep_link = session
        .map(|s| format!("velo://session/{}", s.id))
        .unwrap_or_else(|| "velo://open".to_string());

    let (title, body, level) = match (kind, cfg.blind_mode) {
        (PushTriggerKind::PermissionRequired, true) => (
            "🔐 Velo · 等待权限审批".to_string(),
            "Agent 正在等待你的授权确认（端到端零明文唤醒）".to_string(),
            "timeSensitive",
        ),
        (PushTriggerKind::PermissionRequired, false) => (
            format!(
                "🔐 等待审批 · {}",
                session.map(|s| s.name.as_str()).unwrap_or("Velo")
            ),
            extra_detail
                .unwrap_or("请打开 Velo 批准或拒绝当前操作")
                .to_string(),
            "timeSensitive",
        ),
        (PushTriggerKind::QuestionRequired, _) => (
            "💬 Velo · 等待你的确认回答".to_string(),
            "Agent 提出了澄清问题，点此打开会话回复".to_string(),
            "timeSensitive",
        ),
        (PushTriggerKind::TurnCompleted, true) => (
            "⚡ Velo · 会话执行完成".to_string(),
            "后台任务已完成，点击进入加密通道查看结果".to_string(),
            "active",
        ),
        (PushTriggerKind::TurnCompleted, false) => (
            format!(
                "✅ 已完成 · {}",
                session.map(|s| s.name.as_str()).unwrap_or("Velo")
            ),
            extra_detail.unwrap_or("任务已完成").to_string(),
            "active",
        ),
        (PushTriggerKind::TurnFailed, true) => (
            "⚠️ Velo · 会话执行中断".to_string(),
            "后台任务遇到异常停止，点击打开 Velo 查看".to_string(),
            "timeSensitive",
        ),
        (PushTriggerKind::TurnFailed, false) => (
            format!(
                "⚠️ 执行异常 · {}",
                session.map(|s| s.name.as_str()).unwrap_or("Velo")
            ),
            extra_detail.unwrap_or("点击查看错误详情").to_string(),
            "timeSensitive",
        ),
        (PushTriggerKind::TestPing, _) => (
            "🔔 Velo 远程锁屏推送已连通".to_string(),
            if cfg.blind_mode {
                "当前已开启零明文盲推送保护（不经过第三方暴露任何代码与 Prompt）".to_string()
            } else {
                "测试推送成功，点击可直达 Velo Mobile".to_string()
            },
            "timeSensitive",
        ),
    };

    let mut delivered = false;
    let mut last_err: Option<String> = None;

    if let Some(bark_url) = normalize_bark_endpoint(&cfg.bark_target) {
        let payload = json!({
            "title": title,
            "body": body,
            "group": "Velo",
            "level": level,
            "url": deep_link,
            "isArchive": 1,
        });
        match Command::new("curl")
            .args([
                "-sS",
                "--max-time",
                "6",
                "-X",
                "POST",
                &bark_url,
                "-H",
                "Content-Type: application/json; charset=utf-8",
                "-d",
                &payload.to_string(),
            ])
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                delivered = true;
            }
            Ok(out) => {
                let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
                warn!("Bark push failed: {}", e);
                last_err = Some(e);
            }
            Err(err) => {
                last_err = Some(err.to_string());
            }
        }
    }

    let wh = cfg.webhook_url.trim();
    if !wh.is_empty() && (wh.starts_with("http://") || wh.starts_with("https://")) {
        let payload = json!({
            "event": format!("{:?}", kind),
            "title": title,
            "body": body,
            "text": format!("{}\n{}", title, body),
            "content": format!("{}\n{}", title, body),
            "url": deep_link,
            "session_id": session.map(|s| s.id),
            "blind_mode": cfg.blind_mode,
            "timestamp": Utc::now().to_rfc3339(),
        });
        match Command::new("curl")
            .args([
                "-sS",
                "--max-time",
                "6",
                "-X",
                "POST",
                wh,
                "-H",
                "Content-Type: application/json; charset=utf-8",
                "-d",
                &payload.to_string(),
            ])
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                delivered = true;
            }
            Ok(out) => {
                let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
                warn!("Webhook push failed: {}", e);
                last_err = Some(e);
            }
            Err(err) => {
                last_err = Some(err.to_string());
            }
        }
    }

    if !delivered && cfg.bark_target.trim().is_empty() && wh.is_empty() {
        return json!({
            "ok": false,
            "error": "请先填写 Bark 推送 Key/地址 或 Webhook URL",
        });
    }

    json!({
        "ok": delivered,
        "error": last_err,
    })
}
