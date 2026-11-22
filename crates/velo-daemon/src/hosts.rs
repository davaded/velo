use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::time::Instant;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostIdentity {
    pub host_id: String,
    pub label: String,
    pub os_info: String,
    pub arch: String,
    pub created_at: DateTime<Utc>,
}

pub fn load_or_create_host_identity(path: &Path) -> HostIdentity {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(existing) = serde_json::from_str::<HostIdentity>(&raw) {
            if !existing.host_id.trim().is_empty() {
                return existing;
            }
        }
    }
    let hostname = std::process::Command::new("scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Velo-Host".to_string());

    let short_id = &Uuid::new_v4().simple().to_string()[..10];
    let os_tag = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "node"
    };
    let ident = HostIdentity {
        host_id: format!("{}-{}", os_tag, short_id),
        label: hostname,
        os_info: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        arch: std::env::consts::ARCH.to_string(),
        created_at: Utc::now(),
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&ident) {
        let _ = fs::write(path, s);
    }
    ident
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHostNode {
    pub id: String,
    pub label: String,
    /// `"daemon"` (full federated Velo Daemon node) or `"ssh"` (agentless SSH compute host)
    #[serde(default = "default_node_kind")]
    pub node_kind: String,
    /// SSH target (e.g. `s13`, `dmit`, `root@1.2.3.4`) — used when `node_kind == "ssh"`
    #[serde(default)]
    pub ssh_target: String,
    /// Direct LAN / Tailscale daemon base URL (e.g. `http://100.64.0.5:6767`) — used when `node_kind == "daemon"`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_url: Option<String>,
    /// Optional E2EE Relay pairing URI (`velo://pair?...`) fallback for remote WAN access
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing_uri: Option<String>,
    /// Authoritative machine UUID reported by peer daemon `/api/host/info`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_host_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub running_count: usize,
    #[serde(default)]
    pub waiting_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<DateTime<Utc>>,
}

fn default_node_kind() -> String {
    "ssh".to_string()
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

/// Probes either a federated Velo Daemon node (HTTP `/api/host/info`) or an SSH compute host.
pub async fn probe_host_node(mut host: RemoteHostNode) -> RemoteHostNode {
    if host.node_kind == "daemon" {
        if let Some(raw_url) = host.daemon_url.clone().filter(|u| !u.trim().is_empty()) {
            let base = raw_url.trim().trim_end_matches('/');
            let endpoint = format!("{}/api/host/info", base);
            let started = Instant::now();
            let mut cmd = Command::new("curl");
            cmd.args(["-sS", "--max-time", "4", &endpoint]);
            let res = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await;
            host.last_checked_at = Some(Utc::now());
            match res {
                Ok(Ok(out)) if out.status.success() => {
                    let elapsed = started.elapsed().as_millis() as u64;
                    if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                        host.status = "online".to_string();
                        host.latency_ms = Some(elapsed);
                        if let Some(hid) = v.get("host_id").and_then(|x| x.as_str()) {
                            host.remote_host_id = Some(hid.to_string());
                        }
                        if let Some(os) = v.get("os_info").and_then(|x| x.as_str()) {
                            host.os_info = os.to_string();
                        }
                        if let Some(provs) = v.get("available_providers").and_then(|x| x.as_array())
                        {
                            host.detected_agents = provs
                                .iter()
                                .filter_map(|p| p.as_str().map(str::to_string))
                                .collect();
                        }
                        host.running_count = v
                            .get("running_count")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0) as usize;
                        host.waiting_count = v
                            .get("waiting_count")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0) as usize;
                        return host;
                    }
                }
                _ => {}
            }
            // Fallback check `/api/health` for older Velo daemon versions
            let health_ep = format!("{}/api/health", base);
            let mut cmd2 = Command::new("curl");
            cmd2.args(["-sS", "--max-time", "3", &health_ep]);
            let res2 = tokio::time::timeout(std::time::Duration::from_secs(4), cmd2.output()).await;
            if let Ok(Ok(out2)) = res2 {
                if out2.status.success() && !out2.stdout.is_empty() {
                    host.status = "online".to_string();
                    host.latency_ms = Some(started.elapsed().as_millis() as u64);
                    return host;
                }
            }
            host.status = "offline".to_string();
            host.latency_ms = None;
            return host;
        }
    }
    probe_ssh_host(host).await
}

/// Probes an SSH host for reachability, OS/CPU summary, and installed coding agent CLIs.
pub async fn probe_ssh_host(mut host: RemoteHostNode) -> RemoteHostNode {
    let probe_script = "uname -srm; for b in claude codex agy cursor-agent git docker; do command -v $b >/dev/null 2>&1 && echo \"AGENT:$b\"; done";
    let started = Instant::now();
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
            host.latency_ms = Some(started.elapsed().as_millis() as u64);
            host.os_info = os_line;
            host.detected_agents = agents;
        }
        _ => {
            host.status = "offline".to_string();
            host.latency_ms = None;
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
        node_kind: "ssh".to_string(),
        ssh_target: clean_target,
        daemon_url: None,
        pairing_uri: None,
        remote_host_id: None,
        default_cwd: default_cwd
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("~")
            .to_string(),
        prefer_hush,
        status: "unknown".to_string(),
        os_info: String::new(),
        detected_agents: Vec::new(),
        latency_ms: None,
        running_count: 0,
        waiting_count: 0,
        last_checked_at: None,
    }
}

pub fn create_daemon_host_node(
    label: &str,
    daemon_url: &str,
    pairing_uri: Option<&str>,
) -> RemoteHostNode {
    let clean_url = daemon_url.trim().trim_end_matches('/').to_string();
    let normalized_url = if clean_url.starts_with("http://") || clean_url.starts_with("https://") {
        clean_url
    } else if !clean_url.is_empty() {
        format!("http://{}", clean_url)
    } else {
        String::new()
    };
    let clean_label = if label.trim().is_empty() {
        normalized_url
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .to_string()
    } else {
        label.trim().to_string()
    };
    RemoteHostNode {
        id: format!("node-{}", &Uuid::new_v4().simple().to_string()[..10]),
        label: if clean_label.is_empty() {
            "Remote Velo Host".to_string()
        } else {
            clean_label
        },
        node_kind: "daemon".to_string(),
        ssh_target: String::new(),
        daemon_url: if normalized_url.is_empty() {
            None
        } else {
            Some(normalized_url)
        },
        pairing_uri: pairing_uri
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        remote_host_id: None,
        default_cwd: "~".to_string(),
        prefer_hush: false,
        status: "unknown".to_string(),
        os_info: String::new(),
        detected_agents: Vec::new(),
        latency_ms: None,
        running_count: 0,
        waiting_count: 0,
        last_checked_at: None,
    }
}

pub fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

pub fn local_host_summary_json(ident: &HostIdentity, running_count: usize, waiting_count: usize) -> Value {
    json!({
        "id": "local",
        "host_id": ident.host_id,
        "node_kind": "daemon",
        "label": format!("{} (本机)", ident.label),
        "ssh_target": "127.0.0.1",
        "daemon_url": "http://127.0.0.1:6767",
        "default_cwd": "~",
        "is_local": true,
        "status": "online",
        "latency_ms": 1,
        "running_count": running_count,
        "waiting_count": waiting_count,
        "os_info": ident.os_info,
    })
}
