use chrono::{DateTime, Datelike, Timelike, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;
use velo_protocol::AgentProvider;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRule {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    /// `"cron"` | `"github_webhook"` | `"generic_webhook"`
    pub trigger_type: String,
    #[serde(default)]
    pub cron_expr: Option<String>,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default)]
    pub github_events: Vec<String>,
    pub repo_path: String,
    #[serde(default = "default_branch_prefix")]
    pub branch_prefix: String,
    pub provider: AgentProvider,
    #[serde(default)]
    pub model: Option<String>,
    pub prompt_template: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_session_id: Option<Uuid>,
    #[serde(default)]
    pub run_count: u64,
}

fn default_branch_prefix() -> String {
    "auto/hub".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateAutomationRequest {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub trigger_type: String,
    pub cron_expr: Option<String>,
    pub webhook_secret: Option<String>,
    #[serde(default)]
    pub github_events: Vec<String>,
    pub repo_path: String,
    pub branch_prefix: Option<String>,
    pub provider: AgentProvider,
    pub model: Option<String>,
    pub prompt_template: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAutomationRequest {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub cron_expr: Option<String>,
    pub prompt_template: Option<String>,
}

/// Evaluates a standard 5-field cron expression (`min hour dom month dow`) against `dt` (UTC).
pub fn matches_cron_minute(expr: &str, dt: &DateTime<Utc>) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let min = dt.minute();
    let hour = dt.hour();
    let dom = dt.day();
    let month = dt.month();
    let dow = dt.weekday().num_days_from_sunday(); // 0 = Sun .. 6 = Sat

    match_field(fields[0], min, 0, 59)
        && match_field(fields[1], hour, 0, 23)
        && match_field(fields[2], dom, 1, 31)
        && match_field(fields[3], month, 1, 12)
        && (match_field(fields[4], dow, 0, 7) || (dow == 0 && match_field(fields[4], 7, 0, 7)))
}

fn match_field(spec: &str, val: u32, min: u32, max: u32) -> bool {
    for part in spec.split(',') {
        let part = part.trim();
        if part == "*" {
            return true;
        }
        if let Some(step_str) = part.strip_prefix("*/") {
            if let Ok(step) = step_str.parse::<u32>() {
                if step > 0 && (val.saturating_sub(min)) % step == 0 {
                    return true;
                }
            }
            continue;
        }
        if let Some((start_s, end_s)) = part.split_once('-') {
            if let (Ok(s), Ok(e)) = (start_s.parse::<u32>(), end_s.parse::<u32>()) {
                if val >= s.max(min) && val <= e.min(max) {
                    return true;
                }
            }
            continue;
        }
        if let Ok(exact) = part.parse::<u32>() {
            if exact == val {
                return true;
            }
        }
    }
    false
}

/// Verifies GitHub Webhook `X-Hub-Signature-256` (`sha256=<hex>`) using constant-time HMAC-SHA256.
pub fn verify_github_signature(secret: &str, body: &[u8], signature_header: Option<&str>) -> bool {
    if secret.trim().is_empty() {
        return true;
    }
    let Some(sig) = signature_header.and_then(|h| h.trim().strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(sig) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&sig_bytes).is_ok()
}

/// Interpolates webhook JSON fields (`{{event}}`, `{{action}}`, `{{title}}`, `{{body}}`, `{{url}}`, `{{sender}}`) into `template`.
pub fn render_webhook_prompt(template: &str, event_name: &str, payload: &Value) -> String {
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("triggered");
    let title = payload
        .pointer("/issue/title")
        .or_else(|| payload.pointer("/pull_request/title"))
        .or_else(|| payload.pointer("/check_run/name"))
        .or_else(|| payload.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("Webhook Task");
    let body = payload
        .pointer("/comment/body")
        .or_else(|| payload.pointer("/issue/body"))
        .or_else(|| payload.pointer("/pull_request/body"))
        .or_else(|| payload.pointer("/check_run/output/summary"))
        .or_else(|| payload.get("body"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = payload
        .pointer("/comment/html_url")
        .or_else(|| payload.pointer("/issue/html_url"))
        .or_else(|| payload.pointer("/pull_request/html_url"))
        .or_else(|| payload.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sender = payload
        .pointer("/sender/login")
        .and_then(|v| v.as_str())
        .unwrap_or("external");

    template
        .replace("{{event}}", event_name)
        .replace("{{action}}", action)
        .replace("{{title}}", title)
        .replace("{{body}}", body)
        .replace("{{url}}", url)
        .replace("{{sender}}", sender)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_cron_matcher_and_hmac() {
        let dt = Utc.with_ymd_and_hms(2026, 11, 11, 9, 30, 0).unwrap();
        assert!(matches_cron_minute("30 9 * * *", &dt));
        assert!(matches_cron_minute("*/15 9-18 * * 1-5", &dt));
        assert!(!matches_cron_minute("0 9 * * *", &dt));

        let body = b"{\"action\":\"opened\",\"issue\":{\"title\":\"Fix login\"}}";
        let mut mac = HmacSha256::new_from_slice(b"mysecret").unwrap();
        mac.update(body);
        let sig_hdr = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        assert!(verify_github_signature("mysecret", body, Some(&sig_hdr)));
        assert!(!verify_github_signature("wrong", body, Some(&sig_hdr)));
    }
}
