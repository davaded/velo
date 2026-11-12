use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::OnceLock;
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::Mutex;
use tracing::{info, warn};

pub const LAUNCH_AGENT_LABEL: &str = "com.velo.daemon";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceConfig {
    #[serde(default = "default_true")]
    pub prevent_idle_sleep: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            prevent_idle_sleep: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceStatusDto {
    pub label: String,
    pub plist_installed: bool,
    pub plist_path: String,
    pub launchd_loaded: bool,
    pub launchd_pid: Option<u32>,
    pub running_under_launchd: bool,
    pub prevent_idle_sleep: bool,
    pub caffeinate_active: bool,
    pub installed_binary_path: String,
    pub log_dir: String,
}

static CAFFEINATE_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn caffeinate_lock() -> &'static Mutex<Option<Child>> {
    CAFFEINATE_CHILD.get_or_init(|| Mutex::new(None))
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/daiyudai"))
}

pub fn velo_home_dir() -> PathBuf {
    home_dir().join(".velo")
}

pub fn installed_daemon_bin_path() -> PathBuf {
    velo_home_dir().join("bin").join("velo-daemon")
}

pub fn installed_ui_dist_dir() -> PathBuf {
    velo_home_dir().join("ui").join("dist")
}

pub fn logs_dir() -> PathBuf {
    velo_home_dir().join("logs")
}

pub fn launch_agent_plist_path() -> PathBuf {
    home_dir()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}

fn service_config_path() -> PathBuf {
    velo_home_dir().join("service_config.json")
}

pub fn load_service_config() -> ServiceConfig {
    let p = service_config_path();
    if let Ok(raw) = std::fs::read_to_string(&p) {
        if let Ok(cfg) = serde_json::from_str::<ServiceConfig>(&raw) {
            return cfg;
        }
    }
    ServiceConfig::default()
}

pub fn save_service_config(cfg: &ServiceConfig) {
    let p = service_config_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(p, raw);
    }
}

pub async fn sync_caffeinate_assertion(enable: bool) {
    #[cfg(target_os = "macos")]
    {
        let mut guard = caffeinate_lock().lock().await;
        if let Some(ref mut existing) = *guard {
            if let Ok(Some(_)) = existing.try_wait() {
                *guard = None;
            }
        }
        if enable {
            if guard.is_none() && Path::new("/usr/bin/caffeinate").is_file() {
                let my_pid = std::process::id().to_string();
                match TokioCommand::new("/usr/bin/caffeinate")
                    .args(["-i", "-w", &my_pid])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(child) => {
                        info!(
                            "macOS prevent-idle-sleep assertion active (`caffeinate -i -w {}`)",
                            my_pid
                        );
                        *guard = Some(child);
                    }
                    Err(e) => warn!("Failed to spawn caffeinate: {}", e),
                }
            }
        } else if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
            info!("macOS prevent-idle-sleep assertion released");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enable;
    }
}

pub async fn is_caffeinate_running() -> bool {
    let mut guard = caffeinate_lock().lock().await;
    if let Some(ref mut c) = *guard {
        match c.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        }
    } else {
        false
    }
}

pub async fn autostart_service_assertions() {
    let cfg = load_service_config();
    let under_launchd = std::env::var("VELO_LAUNCHD").as_deref() == Ok("1");
    if cfg.prevent_idle_sleep && (under_launchd || launch_agent_plist_path().is_file()) {
        sync_caffeinate_assertion(true).await;
    }
}

fn current_uid() -> u32 {
    StdCommand::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok())
        .unwrap_or(501)
}

fn query_launchd_state() -> (bool, Option<u32>) {
    let domain_target = format!("gui/{}/{}", current_uid(), LAUNCH_AGENT_LABEL);
    let Ok(out) = StdCommand::new("launchctl")
        .args(["print", &domain_target])
        .output()
    else {
        return (false, None);
    };
    if !out.status.success() {
        return (false, None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut pid = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("pid = ") {
            if let Ok(p) = rest.trim().parse::<u32>() {
                pid = Some(p);
                break;
            }
        }
    }
    (true, pid)
}

pub async fn get_service_status() -> ServiceStatusDto {
    let plist = launch_agent_plist_path();
    let (loaded, pid) = query_launchd_state();
    let cfg = load_service_config();
    ServiceStatusDto {
        label: LAUNCH_AGENT_LABEL.to_string(),
        plist_installed: plist.is_file(),
        plist_path: plist.to_string_lossy().to_string(),
        launchd_loaded: loaded,
        launchd_pid: pid,
        running_under_launchd: std::env::var("VELO_LAUNCHD").as_deref() == Ok("1"),
        prevent_idle_sleep: cfg.prevent_idle_sleep,
        caffeinate_active: is_caffeinate_running().await,
        installed_binary_path: installed_daemon_bin_path().to_string_lossy().to_string(),
        log_dir: logs_dir().to_string_lossy().to_string(),
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

fn find_best_ui_dist_source() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("VELO_UI_DIR") {
        let p = PathBuf::from(env_dir);
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    let candidates = [
        PathBuf::from("/Users/daiyudai/code/velo/Velo.app/Contents/Resources/dist"),
        PathBuf::from("/Users/daiyudai/code/velo/apps/velo-desktop/dist"),
        PathBuf::from("/Applications/Velo.app/Contents/Resources/dist"),
    ];
    candidates.into_iter().find(|c| c.join("index.html").is_file())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Atomically installs `~/.velo/bin/velo-daemon`, `~/.velo/ui/dist`, and `~/Library/LaunchAgents/com.velo.daemon.plist`.
pub fn stage_launch_agent_files(source_bin_override: Option<&Path>) -> Result<PathBuf> {
    let bin_dest = installed_daemon_bin_path();
    if let Some(parent) = bin_dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(logs_dir())?;

    let src_bin = match source_bin_override {
        Some(p) => p.to_path_buf(),
        None => std::env::current_exe().context("Failed to locate current velo binary")?,
    };

    // Only copy if src_bin is distinct from bin_dest; use atomic temp file + ad-hoc codesign to avoid Apple Silicon vnode SIGKILL
    if src_bin.canonicalize().ok() != bin_dest.canonicalize().ok() {
        let tmp_bin = bin_dest.with_extension("tmp");
        let _ = std::fs::remove_file(&tmp_bin);
        std::fs::copy(&src_bin, &tmp_bin)
            .with_context(|| format!("Failed to copy {:?} to {:?}", src_bin, tmp_bin))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp_bin, std::fs::Permissions::from_mode(0o755))?;
        }
        let _ = StdCommand::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&tmp_bin)
            .output();
        std::fs::rename(&tmp_bin, &bin_dest)?;
    }

    // Also link `~/.local/bin/velo` -> `~/.velo/bin/velo-daemon` for convenient terminal CLI usage
    let user_local_bin = home_dir().join(".local").join("bin");
    if user_local_bin.is_dir() {
        let cli_link = user_local_bin.join("velo");
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&cli_link);
            let _ = std::os::unix::fs::symlink(&bin_dest, &cli_link);
        }
    }

    // Stage UI dist assets to `~/.velo/ui/dist`
    let dst_ui = installed_ui_dist_dir();
    if let Some(src_ui) = find_best_ui_dist_source() {
        if src_ui.canonicalize().ok() != dst_ui.canonicalize().ok() {
            let tmp_ui = velo_home_dir().join("ui").join("dist.tmp");
            let _ = std::fs::remove_dir_all(&tmp_ui);
            if copy_dir_recursive(&src_ui, &tmp_ui).is_ok() {
                let _ = std::fs::remove_dir_all(&dst_ui);
                let _ = std::fs::rename(&tmp_ui, &dst_ui);
            }
        }
    }

    let plist_path = launch_agent_plist_path();
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let home_str = home_dir().to_string_lossy().to_string();
    let aug_path = velo_agent::discover_augmented_path();
    let bin_str = bin_dest.to_string_lossy().to_string();
    let ui_str = dst_ui.to_string_lossy().to_string();
    let out_log = logs_dir().join("daemon.out.log").to_string_lossy().to_string();
    let err_log = logs_dir().join("daemon.err.log").to_string_lossy().to_string();

    let plist_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
        <string>--addr</string>
        <string>0.0.0.0:6767</string>
        <string>up</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>ThrottleInterval</key>
    <integer>3</integer>
    <key>WorkingDirectory</key>
    <string>{home}</string>
    <key>StandardOutPath</key>
    <string>{out_log}</string>
    <key>StandardErrorPath</key>
    <string>{err_log}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{home}</string>
        <key>PATH</key>
        <string>{path}</string>
        <key>VELO_UI_DIR</key>
        <string>{ui}</string>
        <key>VELO_LAUNCHD</key>
        <string>1</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>
"#,
        label = xml_escape(LAUNCH_AGENT_LABEL),
        bin = xml_escape(&bin_str),
        home = xml_escape(&home_str),
        out_log = xml_escape(&out_log),
        err_log = xml_escape(&err_log),
        path = xml_escape(&aug_path),
        ui = xml_escape(&ui_str),
    );

    std::fs::write(&plist_path, plist_xml)?;
    if !service_config_path().is_file() {
        save_service_config(&ServiceConfig::default());
    }

    Ok(plist_path)
}

pub fn bootstrap_and_kickstart_sync(plist_path: &Path) -> Result<()> {
    let uid = current_uid();
    let gui_domain = format!("gui/{}", uid);
    let service_target = format!("gui/{}/{}", uid, LAUNCH_AGENT_LABEL);

    let _ = StdCommand::new("launchctl")
        .args(["bootout", &service_target])
        .output();

    let boot = StdCommand::new("launchctl")
        .args(["bootstrap", &gui_domain])
        .arg(plist_path)
        .output()
        .context("Failed to execute launchctl bootstrap")?;

    if !boot.status.success() {
        let stderr = String::from_utf8_lossy(&boot.stderr);
        // Domain may already have service loaded
        if !stderr.contains("already") {
            let _ = StdCommand::new("launchctl")
                .args(["load", "-w"])
                .arg(plist_path)
                .output();
        }
    }

    let _ = StdCommand::new("launchctl")
        .args(["kickstart", "-k", &service_target])
        .output();

    Ok(())
}

pub fn bootout_and_remove_plist_sync(stop_running: bool) -> Result<()> {
    let plist_path = launch_agent_plist_path();
    let uid = current_uid();
    let service_target = format!("gui/{}/{}", uid, LAUNCH_AGENT_LABEL);
    if stop_running {
        let _ = StdCommand::new("launchctl")
            .args(["bootout", &service_target])
            .output();
    }
    if plist_path.is_file() {
        let _ = std::fs::remove_file(&plist_path);
    }
    Ok(())
}

pub fn restart_launchd_service_sync() -> Result<()> {
    let uid = current_uid();
    let service_target = format!("gui/{}/{}", uid, LAUNCH_AGENT_LABEL);
    let out = StdCommand::new("launchctl")
        .args(["kickstart", "-k", &service_target])
        .output()
        .context("Failed to run launchctl kickstart")?;
    if !out.status.success() {
        anyhow::bail!(
            "launchctl kickstart failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}
