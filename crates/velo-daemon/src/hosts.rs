use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHostNode {
    pub id: String,
    pub label: String,
    /// SSH target (e.g. `s13`, `dmit`, `root@1.2.3.4`)
    pub ssh_target: String,
    /// Default remote project directory (e.g. `~/code` or `/root`)
    #[serde(default = "default_remote_cwd")]
    pub default_cwd: String,
    /// Automatically prefer `hush ssh <target> --` if available on Mac
    #[serde(default = "default_true")]
    pub prefer_hush: bool,
    #[serde(default)]
    pub status: String, // "online" | "offline" | "unknown"
    #[serde(default)]
    pub os_info: String,
    #[serde(default)]
    pub detected_agents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<DateTime<Utc>>,
}

fn default_remote_cwd() -> String {
    "~".to_string()
}

fn default_true() -> bool {
    true
}

pub fn load_remote_hosts(path: &Path) -> Vec<RemoteHostNode> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RemoteHostNode>>(&s).ok())
        .unwrap_or_default()
}

pub fn save_remote_hosts(path: &Path, list: &[RemoteHostNode]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(list) {
        let _ = fs::write(path, s);
    }
}

fn find_hush_binary() -> Option<String> {
    if let Some(home) = std::env::var_os("HOME") {
        let local_hush = Path::new(&home).join(".local/bin/hush");
        if local_hush.is_file() {
            return Some(local_hush.to_string_lossy().to_string());
        }
    }
    velo_agent::resolve_cli_binary("hush").map(|p| p.to_string_lossy().to_string())
}

pub fn build_ssh_command(host: &RemoteHostNode, remote_shell_cmd: &str) -> Command {
    if host.prefer_hush {
        if let Some(hush_bin) = find_hush_binary() {
            let mut c = Command::new(hush_bin);
            c.args(["ssh", &host.ssh_target, "--", remote_shell_cmd]);
            return c;
        }
    }
    let mut c = Command::new("ssh");
    c.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=6",
        &host.ssh_target,
        remote_shell_cmd,
    ]);
    c
}

/// Probes an SSH host for reachability, OS/CPU summary, and installed coding agent CLIs.
pub async fn probe_ssh_host(mut host: RemoteHostNode) -> RemoteHostNode {
    let probe_script = "uname -srm; for b in claude codex agy cursor-agent git docker; do command -v $b >/dev/null 2>&1 && echo \"AGENT:$b\"; done";
    let mut cmd = build_ssh_command(&host, probe_script);
    let res = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await;
    host.last_checked_at = Some(Utc::now());

    match res {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut os_line = String::new();
            let mut agents = Vec::new();
            for line in stdout.lines() {
                let t = line.trim();
                if let Some(ag) = t.strip_prefix("AGENT:") {
                    agents.push(ag.to_string());
                } else if os_line.is_empty() && !t.is_empty() {
                    os_line = t.to_string();
                }
            }
            host.status = "online".to_string();
            host.os_info = os_line;
            host.detected_agents = agents;
        }
        _ => {
            host.status = "offline".to_string();
        }
    }
    host
}

pub fn create_host_node(
    label: &str,
    ssh_target: &str,
    default_cwd: Option<&str>,
    prefer_hush: bool,
) -> RemoteHostNode {
    let clean_target = ssh_target.trim().to_string();
    let clean_label = if label.trim().is_empty() {
        clean_target.clone()
    } else {
        label.trim().to_string()
    };
    RemoteHostNode {
        id: format!("host-{}", &Uuid::new_v4().simple().to_string()[..10]),
        label: clean_label,
        ssh_target: clean_target,
        default_cwd: default_cwd
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("~")
            .to_string(),
        prefer_hush,
        status: "unknown".to_string(),
        os_info: String::new(),
        detected_agents: Vec::new(),
        last_checked_at: None,
    }
}

pub fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

pub fn local_host_summary_json() -> Value {
    let hostname = std::process::Command::new("scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".to_string());
    json!({
        "id": "local",
        "label": format!("{} (本机)", hostname),
        "ssh_target": "127.0.0.1",
        "default_cwd": "~",
        "is_local": true,
        "status": "online",
        "os_info": format!("macOS {}", std::env::consts::ARCH),
    })
}
