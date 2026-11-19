use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCliSessionDto {
    pub provider: String,
    pub cli_session_id: String,
    pub title: String,
    pub cwd: String,
    pub project_name: String,
    pub updated_at: String,
    pub message_count: usize,
    pub last_preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_session_id: Option<Uuid>,
    #[serde(default)]
    pub is_ephemeral: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCliSessionsSnapshot {
    pub sessions: Vec<ExternalCliSessionDto>,
    pub ephemeral_count: usize,
    pub hidden_count: usize,
}

fn dismissed_store_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".velo/dismissed_cli_sessions.json"))
}

pub fn load_dismissed_cli_sessions() -> HashSet<String> {
    let Some(path) = dismissed_store_path() else {
        return HashSet::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

pub fn save_dismissed_cli_sessions(set: &HashSet<String>) -> anyhow::Result<()> {
    let Some(path) = dismissed_store_path() else {
        anyhow::bail!("HOME directory not found");
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut sorted: Vec<String> = set.iter().cloned().collect();
    sorted.sort();
    fs::write(path, serde_json::to_string_pretty(&sorted)?)?;
    Ok(())
}

fn cli_dismiss_key(provider: &str, cli_session_id: &str) -> String {
    format!("{}:{}", provider.trim().to_lowercase(), cli_session_id.trim())
}

pub fn classify_ephemeral_session(
    cwd: &str,
    title: &str,
    has_custom_title: bool,
    msg_count: usize,
    velo_wt_prefix: &str,
    imported: bool,
) -> Option<String> {
    if imported {
        return None;
    }
    let clean_cwd = cwd.trim();
    if clean_cwd == "/" {
        return Some("根目录临时会话".to_string());
    }
    if clean_cwd.starts_with("/tmp")
        || clean_cwd.starts_with("/private/tmp")
        || clean_cwd.starts_with("/var/folders")
        || clean_cwd.contains("/.cache/")
        || clean_cwd.contains("/scratchpad")
        || (!velo_wt_prefix.is_empty() && clean_cwd.starts_with(velo_wt_prefix))
    {
        return Some("临时目录会话".to_string());
    }

    if !has_custom_title && msg_count <= 2 {
        let norm = title
            .trim()
            .to_lowercase()
            .trim_matches(|c: char| matches!(c, '.' | '!' | '?' | ',' | '。' | '！' | '？' | '"' | '\'' | '`'))
            .trim()
            .to_string();

        const EXACT_PINGS: &[&str] = &[
            "ok",
            "okay",
            "hi",
            "hello",
            "hey",
            "ping",
            "pong",
            "test",
            "testing",
            "1",
            "123",
            "你好",
            "测试",
            "在吗",
            "reply ok",
            "say ok",
            "say pong",
            "just ok",
            "just pong",
        ];
        if EXACT_PINGS.contains(&norm.as_str()) {
            return Some("单轮探测/测试".to_string());
        }

        const PROBE_SUBSTRS: &[&str] = &[
            "reply with just",
            "respond with just",
            "reply only with",
            "say just ",
            "health check",
            "connectivity check",
            "smoke test",
        ];
        if PROBE_SUBSTRS.iter().any(|p| norm.contains(p)) {
            return Some("连通性测试".to_string());
        }

        if msg_count <= 1 && norm.chars().count() <= 4 {
            return Some("极短临时会话".to_string());
        }
    }

    None
}

#[derive(Debug, Clone)]
pub struct ParsedExternalSession {
    pub provider: AgentProvider,
    pub cli_session_id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: DateTime<Utc>,
    pub first_prompt: String,
    pub events: Vec<AgentEvent>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn system_time_to_utc(st: SystemTime) -> DateTime<Utc> {
    let dur = st
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    Utc.timestamp_opt(dur.as_secs() as i64, dur.subsec_nanos())
        .single()
        .unwrap_or_else(Utc::now)
}

fn parse_timestamp_or(raw: Option<&str>, fallback: DateTime<Utc>) -> DateTime<Utc> {
    raw.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(fallback)
}

fn clean_title_snippet(text: &str) -> String {
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.starts_with("<environment_context>")
                && !l.starts_with("# AGENTS.md")
                && !l.starts_with("# Files mentioned")
                && !l.starts_with("<local-command")
                && !l.starts_with("<command-name>")
        })
        .unwrap_or_else(|| text.trim());
    let chars: Vec<char> = first_line.chars().collect();
    if chars.len() > 54 {
        format!("{}…", chars[..54].iter().collect::<String>())
    } else {
        first_line.to_string()
    }
}

fn is_synthetic_injected_user_text(text: &str) -> bool {
    let t = text.trim();
    t.is_empty()
        || t.starts_with("<environment_context>")
        || t.starts_with("<permissions instructions>")
        || t.starts_with("# AGENTS.md instructions")
        || t.starts_with("<local-command-caveat>")
        || t.starts_with("<command-name>")
}

fn extract_claude_message_text(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(arr)) => {
            let mut parts = Vec::new();
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        let trimmed = t.trim();
                        if !trimmed.is_empty() {
                            parts.push(trimmed.to_string());
                        }
                    }
                }
            }
            parts.join("\n\n")
        }
        _ => String::new(),
    }
}

fn extract_codex_message_text(payload: &Value) -> String {
    let Some(arr) = payload.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in arr {
        let btype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if btype == "input_text" || btype == "output_text" || btype == "text" {
            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                if !is_synthetic_injected_user_text(t) {
                    parts.push(t.trim().to_string());
                }
            }
        }
    }
    parts.join("\n\n")
}

fn collect_recent_jsonl_files(root: &Path, max_depth: usize) -> Vec<(PathBuf, SystemTime)> {
    let mut out = Vec::new();
    fn walk(dir: &Path, depth: usize, max_d: usize, acc: &mut Vec<(PathBuf, SystemTime)>) {
        if depth > max_d {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let p = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&p, depth + 1, max_d, acc);
            } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if meta.len() > 32 {
                    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    acc.push((p, mtime));
                }
            }
        }
    }
    walk(root, 0, max_depth, &mut out);
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

/// Scans `~/.claude/projects` and `~/.codex/sessions` for recent native CLI sessions.
pub fn discover_external_cli_sessions(
    existing_by_provider_sid: &HashMap<String, Uuid>,
    limit: usize,
) -> Vec<ExternalCliSessionDto> {
    discover_external_cli_sessions_with_stats(existing_by_provider_sid, limit).sessions
}

pub fn discover_external_cli_sessions_with_stats(
    existing_by_provider_sid: &HashMap<String, Uuid>,
    limit: usize,
) -> ExternalCliSessionsSnapshot {
    let Some(home) = home_dir() else {
        return ExternalCliSessionsSnapshot {
            sessions: Vec::new(),
            ephemeral_count: 0,
            hidden_count: 0,
        };
    };
    let velo_wt_prefix = home.join(".velo/worktrees").to_string_lossy().to_string();
    let dismissed = load_dismissed_cli_sessions();
    let hidden_count = dismissed.len();
    let mut results: Vec<(DateTime<Utc>, ExternalCliSessionDto)> = Vec::new();

    // 1. Scan Claude Code (`~/.claude/projects/*/*.jsonl`)
    let claude_root = home.join(".claude/projects");
    if claude_root.is_dir() {
        for (path, mtime) in collect_recent_jsonl_files(&claude_root, 2)
            .into_iter()
            .take(80)
        {
            if let Some(dto) =
                summarize_claude_jsonl(&path, mtime, &velo_wt_prefix, existing_by_provider_sid)
            {
                if dismissed.contains(&cli_dismiss_key(&dto.provider, &dto.cli_session_id)) {
                    continue;
                }
                let dt = parse_timestamp_or(Some(&dto.updated_at), system_time_to_utc(mtime));
                results.push((dt, dto));
            }
        }
    }

    // 2. Scan Codex CLI / Desktop (`~/.codex/sessions/**/*.jsonl`)
    let codex_root = home.join(".codex/sessions");
    if codex_root.is_dir() {
        for (path, mtime) in collect_recent_jsonl_files(&codex_root, 4)
            .into_iter()
            .take(80)
        {
            if let Some(dto) =
                summarize_codex_jsonl(&path, mtime, &velo_wt_prefix, existing_by_provider_sid)
            {
                if dismissed.contains(&cli_dismiss_key(&dto.provider, &dto.cli_session_id)) {
                    continue;
                }
                let dt = parse_timestamp_or(Some(&dto.updated_at), system_time_to_utc(mtime));
                results.push((dt, dto));
            }
        }
    }

    results.sort_by(|a, b| b.0.cmp(&a.0));

    // Reserve `limit` slots for real non-ephemeral sessions so temporary probes never crowd them out
    let max_real = limit.clamp(5, 80);
    let mut kept_real = Vec::new();
    let mut kept_ephemeral = Vec::new();
    for item in results {
        if item.1.is_ephemeral {
            if kept_ephemeral.len() < 40 {
                kept_ephemeral.push(item);
            }
        } else if kept_real.len() < max_real {
            kept_real.push(item);
        }
    }
    let ephemeral_count = kept_ephemeral.len();
    let mut combined = kept_real;
    combined.extend(kept_ephemeral);
    combined.sort_by(|a, b| b.0.cmp(&a.0));

    ExternalCliSessionsSnapshot {
        sessions: combined.into_iter().map(|(_, d)| d).collect(),
        ephemeral_count,
        hidden_count,
    }
}

fn summarize_claude_jsonl(
    path: &Path,
    mtime: SystemTime,
    velo_wt_prefix: &str,
    existing_by_provider_sid: &HashMap<String, Uuid>,
) -> Option<ExternalCliSessionDto> {
    let sid = path.file_stem()?.to_str()?.trim().to_string();
    if sid.is_empty() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut custom_title: Option<String> = None;
    let mut first_user_title: Option<String> = None;
    let mut last_preview = String::new();
    let mut cwd = String::new();
    let mut msg_count = 0usize;

    for (line_idx, line_res) in reader.lines().enumerate() {
        if line_idx > 600 {
            break;
        }
        let Ok(line) = line_res else { continue };
        if line.len() > 256_000 {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_empty() {
            if let Some(c) = val
                .get("cwd")
                .or_else(|| val.get("relocatedCwd"))
                .and_then(|v| v.as_str())
            {
                if !c.trim().is_empty() {
                    cwd = c.trim().to_string();
                }
            }
        }
        match val.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "custom-title" => {
                if let Some(ct) = val.get("customTitle").and_then(|v| v.as_str()) {
                    if !ct.trim().is_empty() {
                        custom_title = Some(ct.trim().to_string());
                    }
                }
            }
            "user" => {
                if val.get("isVisibleInTranscriptOnly").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(msg) = val.get("message") {
                    let txt = extract_claude_message_text(msg);
                    if !is_synthetic_injected_user_text(&txt) {
                        msg_count += 1;
                        if first_user_title.is_none() {
                            first_user_title = Some(clean_title_snippet(&txt));
                        }
                        last_preview = clean_title_snippet(&txt);
                    }
                }
            }
            "assistant" => {
                if let Some(msg) = val.get("message") {
                    let txt = extract_claude_message_text(msg);
                    if !txt.is_empty() {
                        msg_count += 1;
                        last_preview = clean_title_snippet(&txt);
                    }
                }
            }
            _ => {}
        }
    }

    if msg_count == 0 || cwd.is_empty() {
        return None;
    }
    let imported_id = existing_by_provider_sid.get(&sid).copied();
    // Skip Velo's own internal worktree runs unless the user explicitly looks up non-worktree folders
    if cwd.starts_with(velo_wt_prefix) && imported_id.is_some() {
        return None;
    }
    if cwd.contains("/Library/Application Support/Claude/scratch-workspaces") {
        return None;
    }
    if !Path::new(&cwd).is_dir() {
        return None;
    }

    let project_name = Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let has_custom_title = custom_title.is_some();
    let title = custom_title
        .or(first_user_title)
        .unwrap_or_else(|| format!("Claude · {}", project_name));
    let ephemeral_reason = classify_ephemeral_session(
        &cwd,
        &title,
        has_custom_title,
        msg_count,
        velo_wt_prefix,
        imported_id.is_some(),
    );

    Some(ExternalCliSessionDto {
        provider: "claude".to_string(),
        cli_session_id: sid,
        title,
        cwd,
        project_name,
        updated_at: system_time_to_utc(mtime).to_rfc3339(),
        message_count: msg_count,
        last_preview,
        imported_session_id: imported_id,
        is_ephemeral: ephemeral_reason.is_some(),
        ephemeral_reason,
    })
}

fn summarize_codex_jsonl(
    path: &Path,
    mtime: SystemTime,
    velo_wt_prefix: &str,
    existing_by_provider_sid: &HashMap<String, Uuid>,
) -> Option<ExternalCliSessionDto> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut sid = String::new();
    let mut cwd = String::new();
    let mut first_user_title: Option<String> = None;
    let mut last_preview = String::new();
    let mut msg_count = 0usize;

    for (line_idx, line_res) in reader.lines().enumerate() {
        if line_idx > 700 {
            break;
        }
        let Ok(line) = line_res else { continue };
        if line.len() > 256_000 {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let rtype = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if rtype == "session_meta" {
            if let Some(p) = val.get("payload") {
                if let Some(id_s) = p
                    .get("session_id")
                    .or_else(|| p.get("id"))
                    .and_then(|v| v.as_str())
                {
                    sid = id_s.trim().to_string();
                }
                if let Some(c) = p.get("cwd").and_then(|v| v.as_str()) {
                    cwd = c.trim().to_string();
                }
            }
        } else if rtype == "response_item" {
            if let Some(p) = val.get("payload") {
                if p.get("type").and_then(|v| v.as_str()) == Some("message") {
                    let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    if role == "user" || role == "assistant" {
                        let txt = extract_codex_message_text(p);
                        if !txt.is_empty() {
                            msg_count += 1;
                            if role == "user" && first_user_title.is_none() {
                                first_user_title = Some(clean_title_snippet(&txt));
                            }
                            last_preview = clean_title_snippet(&txt);
                        }
                    }
                }
            }
        }
    }

    if sid.is_empty() || msg_count == 0 || cwd.is_empty() {
        return None;
    }
    let imported_id = existing_by_provider_sid.get(&sid).copied();
    if cwd.starts_with(velo_wt_prefix) && imported_id.is_some() {
        return None;
    }
    if !Path::new(&cwd).is_dir() {
        return None;
    }

    let project_name = Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let title = first_user_title.unwrap_or_else(|| format!("Codex · {}", project_name));
    let ephemeral_reason = classify_ephemeral_session(
        &cwd,
        &title,
        false,
        msg_count,
        velo_wt_prefix,
        imported_id.is_some(),
    );

    Some(ExternalCliSessionDto {
        provider: "codex".to_string(),
        cli_session_id: sid,
        title,
        cwd,
        project_name,
        updated_at: system_time_to_utc(mtime).to_rfc3339(),
        message_count: msg_count,
        last_preview,
        imported_session_id: imported_id,
        is_ephemeral: ephemeral_reason.is_some(),
        ephemeral_reason,
    })
}

/// Locates and parses the full history of a Claude or Codex native `.jsonl` session for Velo import.
pub fn load_external_cli_session(
    provider_str: &str,
    cli_session_id: &str,
    velo_session_id: Uuid,
) -> anyhow::Result<ParsedExternalSession> {
    let home = home_dir().ok_or_else(|| anyhow::anyhow!("HOME directory not found"))?;
    let prov_lower = provider_str.trim().to_lowercase();

    if prov_lower.starts_with("claude") {
        let claude_root = home.join(".claude/projects");
        let target_name = format!("{}.jsonl", cli_session_id.trim());
        let mut found_path: Option<(PathBuf, SystemTime)> = None;
        for (p, mtime) in collect_recent_jsonl_files(&claude_root, 2) {
            if p.file_name().and_then(|n| n.to_str()) == Some(target_name.as_str()) {
                found_path = Some((p, mtime));
                break;
            }
        }
        let (path, mtime) =
            found_path.ok_or_else(|| anyhow::anyhow!("Claude session file not found"))?;
        return parse_full_claude_session(&path, mtime, cli_session_id, velo_session_id);
    }

    if prov_lower.starts_with("codex") {
        let codex_root = home.join(".codex/sessions");
        let needle = cli_session_id.trim();
        let mut found_path: Option<(PathBuf, SystemTime)> = None;
        for (p, mtime) in collect_recent_jsonl_files(&codex_root, 4) {
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(needle))
                .unwrap_or(false)
            {
                found_path = Some((p, mtime));
                break;
            }
        }
        if found_path.is_none() {
            // Fallback: check session_meta inside top 40 recent files
            for (p, mtime) in collect_recent_jsonl_files(&codex_root, 4).into_iter().take(40) {
                if let Ok(f) = fs::File::open(&p) {
                    if let Some(Ok(first_line)) = BufReader::new(f).lines().next() {
                        if first_line.contains(needle) {
                            found_path = Some((p, mtime));
                            break;
                        }
                    }
                }
            }
        }
        let (path, mtime) =
            found_path.ok_or_else(|| anyhow::anyhow!("Codex session file not found"))?;
        return parse_full_codex_session(&path, mtime, cli_session_id, velo_session_id);
    }

    anyhow::bail!("Unsupported external CLI session provider: {}", provider_str)
}

fn parse_full_claude_session(
    path: &Path,
    mtime: SystemTime,
    cli_session_id: &str,
    velo_sid: Uuid,
) -> anyhow::Result<ParsedExternalSession> {
    let fallback_ts = system_time_to_utc(mtime);
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);

    let mut custom_title: Option<String> = None;
    let mut first_prompt = String::new();
    let mut cwd = String::new();
    let mut events = Vec::new();

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_empty() {
            if let Some(c) = val
                .get("cwd")
                .or_else(|| val.get("relocatedCwd"))
                .and_then(|v| v.as_str())
            {
                if !c.trim().is_empty() {
                    cwd = c.trim().to_string();
                }
            }
        }
        let ts = parse_timestamp_or(val.get("timestamp").and_then(|v| v.as_str()), fallback_ts);
        match val.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "custom-title" => {
                if let Some(ct) = val.get("customTitle").and_then(|v| v.as_str()) {
                    if !ct.trim().is_empty() {
                        custom_title = Some(ct.trim().to_string());
                    }
                }
            }
            "user" => {
                if val.get("isVisibleInTranscriptOnly").and_then(|v| v.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(msg) = val.get("message") {
                    let txt = extract_claude_message_text(msg);
                    if !is_synthetic_injected_user_text(&txt) {
                        if first_prompt.is_empty() {
                            first_prompt = txt.clone();
                        }
                        events.push(AgentEvent::UserMessage {
                            session_id: velo_sid,
                            text: txt,
                            images: Vec::new(),
                            timestamp: ts,
                        });
                    }
                }
            }
            "assistant" => {
                if let Some(msg) = val.get("message") {
                    if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                        for block in arr {
                            match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                                "thinking" => {
                                    if let Some(th) = block.get("thinking").and_then(|v| v.as_str())
                                    {
                                        if !th.trim().is_empty() {
                                            events.push(AgentEvent::ThinkingDelta {
                                                session_id: velo_sid,
                                                text: th.trim().to_string(),
                                                timestamp: ts,
                                            });
                                        }
                                    }
                                }
                                "tool_use" => {
                                    let tid = block
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("tool")
                                        .to_string();
                                    let tname = block
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Tool")
                                        .to_string();
                                    let args = block.get("input").cloned().unwrap_or(Value::Null);
                                    events.push(AgentEvent::ToolCallRequested {
                                        session_id: velo_sid,
                                        tool_id: tid.clone(),
                                        tool_name: tname,
                                        arguments: args,
                                        timestamp: ts,
                                    });
                                    events.push(AgentEvent::ToolCallCompleted {
                                        session_id: velo_sid,
                                        tool_id: tid,
                                        output: String::new(),
                                        is_error: false,
                                        timestamp: ts,
                                    });
                                }
                                "text" => {
                                    if let Some(tx) = block.get("text").and_then(|v| v.as_str()) {
                                        if !tx.trim().is_empty() {
                                            events.push(AgentEvent::MessageDelta {
                                                session_id: velo_sid,
                                                text: tx.trim().to_string(),
                                                timestamp: ts,
                                            });
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let proj = Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");
    let title = custom_title.unwrap_or_else(|| {
        if !first_prompt.is_empty() {
            clean_title_snippet(&first_prompt)
        } else {
            format!("Claude · {}", proj)
        }
    });

    Ok(ParsedExternalSession {
        provider: AgentProvider::Claude,
        cli_session_id: cli_session_id.trim().to_string(),
        title,
        cwd,
        updated_at: fallback_ts,
        first_prompt,
        events,
    })
}

fn parse_full_codex_session(
    path: &Path,
    mtime: SystemTime,
    cli_session_id: &str,
    velo_sid: Uuid,
) -> anyhow::Result<ParsedExternalSession> {
    let fallback_ts = system_time_to_utc(mtime);
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);

    let mut first_prompt = String::new();
    let mut cwd = String::new();
    let mut events = Vec::new();
    // Coalesce consecutive Codex commentary/final assistant messages into clean per-turn text
    let mut pending_assistant_parts: Vec<(String, DateTime<Utc>)> = Vec::new();

    let flush_assistant = |evs: &mut Vec<AgentEvent>, parts: &mut Vec<(String, DateTime<Utc>)>| {
        if parts.is_empty() {
            return;
        }
        let last_ts = parts.last().map(|(_, t)| *t).unwrap_or(fallback_ts);
        let text = parts
            .iter()
            .map(|(s, _)| s.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        parts.clear();
        evs.push(AgentEvent::MessageDelta {
            session_id: velo_sid,
            text,
            timestamp: last_ts,
        });
    };

    for line_res in reader.lines() {
        let Ok(line) = line_res else { continue };
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts = parse_timestamp_or(val.get("timestamp").and_then(|v| v.as_str()), fallback_ts);
        let rtype = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if rtype == "session_meta" {
            if let Some(p) = val.get("payload") {
                if let Some(c) = p.get("cwd").and_then(|v| v.as_str()) {
                    if !c.trim().is_empty() {
                        cwd = c.trim().to_string();
                    }
                }
            }
        } else if rtype == "response_item" {
            if let Some(p) = val.get("payload") {
                let ptype = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if ptype == "message" {
                    let role = p.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    if role == "user" {
                        let txt = extract_codex_message_text(p);
                        if !txt.is_empty() {
                            flush_assistant(&mut events, &mut pending_assistant_parts);
                            if first_prompt.is_empty() {
                                first_prompt = txt.clone();
                            }
                            events.push(AgentEvent::UserMessage {
                                session_id: velo_sid,
                                text: txt,
                                images: Vec::new(),
                                timestamp: ts,
                            });
                        }
                    } else if role == "assistant" {
                        let txt = extract_codex_message_text(p);
                        if !txt.is_empty() {
                            pending_assistant_parts.push((txt, ts));
                        }
                    }
                } else if ptype == "function_call" {
                    let tid = p
                        .get("call_id")
                        .or_else(|| p.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("call")
                        .to_string();
                    let tname = p
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Command")
                        .to_string();
                    let args_val = p
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or(Value::Null);
                    events.push(AgentEvent::ToolCallRequested {
                        session_id: velo_sid,
                        tool_id: tid.clone(),
                        tool_name: tname,
                        arguments: args_val,
                        timestamp: ts,
                    });
                    events.push(AgentEvent::ToolCallCompleted {
                        session_id: velo_sid,
                        tool_id: tid,
                        output: String::new(),
                        is_error: false,
                        timestamp: ts,
                    });
                }
            }
        }
    }
    flush_assistant(&mut events, &mut pending_assistant_parts);

    let proj = Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");
    let title = if !first_prompt.is_empty() {
        clean_title_snippet(&first_prompt)
    } else {
        format!("Codex · {}", proj)
    };

    Ok(ParsedExternalSession {
        provider: AgentProvider::Codex,
        cli_session_id: cli_session_id.trim().to_string(),
        title,
        cwd,
        updated_at: fallback_ts,
        first_prompt,
        events,
    })
}

fn validate_safe_session_id(raw: &str) -> anyhow::Result<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.len() > 200
    {
        anyhow::bail!("Invalid external CLI session id");
    }
    Ok(trimmed)
}

/// Safely deletes a native Claude (`~/.claude/projects/.../<sid>.jsonl`) or Codex (`~/.codex/sessions/.../*.jsonl`)
/// session file on disk after canonical root boundary verification.
pub fn delete_external_cli_session_file(
    provider_str: &str,
    cli_session_id: &str,
) -> anyhow::Result<bool> {
    let sid = validate_safe_session_id(cli_session_id)?;
    let home = home_dir().ok_or_else(|| anyhow::anyhow!("HOME directory not found"))?;
    let prov = provider_str.trim().to_lowercase();

    if prov.starts_with("claude") {
        let root = home.join(".claude/projects");
        if !root.is_dir() {
            return Ok(false);
        }
        let canonical_root = fs::canonicalize(&root)?;
        let target_name = format!("{sid}.jsonl");
        let mut deleted = false;
        for (p, _) in collect_recent_jsonl_files(&root, 2) {
            if p.file_name().and_then(|n| n.to_str()) == Some(target_name.as_str()) {
                let canon_file = fs::canonicalize(&p)?;
                if canon_file.starts_with(&canonical_root)
                    && canon_file.extension().and_then(|e| e.to_str()) == Some("jsonl")
                {
                    fs::remove_file(&canon_file)?;
                    deleted = true;
                    // Also remove companion `<sid>/` subagent directory if inside the same project folder
                    if let Some(parent) = canon_file.parent() {
                        let companion = parent.join(sid);
                        if companion.is_dir() {
                            if let Ok(canon_comp) = fs::canonicalize(&companion) {
                                if canon_comp.starts_with(&canonical_root) {
                                    let _ = fs::remove_dir_all(&canon_comp);
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
        return Ok(deleted);
    }

    if prov.starts_with("codex") {
        let root = home.join(".codex/sessions");
        if !root.is_dir() {
            return Ok(false);
        }
        let canonical_root = fs::canonicalize(&root)?;
        let files = collect_recent_jsonl_files(&root, 4);
        let mut target: Option<PathBuf> = None;
        for (p, _) in &files {
            if p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(sid))
                .unwrap_or(false)
            {
                target = Some(p.clone());
                break;
            }
        }
        if target.is_none() {
            for (p, _) in files.iter().take(80) {
                if let Ok(f) = fs::File::open(p) {
                    if let Some(Ok(first_line)) = BufReader::new(f).lines().next() {
                        if first_line.contains(sid) {
                            target = Some(p.clone());
                            break;
                        }
                    }
                }
            }
        }
        if let Some(found) = target {
            let canon_file = fs::canonicalize(&found)?;
            if canon_file.starts_with(&canonical_root)
                && canon_file.extension().and_then(|e| e.to_str()) == Some("jsonl")
            {
                fs::remove_file(&canon_file)?;
                // Best-effort remove matching entry from `~/.codex/session_index.jsonl`
                let idx_path = home.join(".codex/session_index.jsonl");
                if let Ok(raw_idx) = fs::read_to_string(&idx_path) {
                    let filtered: Vec<&str> = raw_idx
                        .lines()
                        .filter(|line| !line.contains(sid))
                        .collect();
                    if filtered.len() < raw_idx.lines().count() {
                        let mut out = filtered.join("\n");
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        let _ = fs::write(&idx_path, out);
                    }
                }
                return Ok(true);
            }
        }
        return Ok(false);
    }

    anyhow::bail!("Unsupported external CLI session provider: {}", provider_str)
}

/// Executes batch management (`"delete"` | `"hide"` | `"unhide_all"`) over discovered external CLI sessions.
pub fn manage_external_cli_sessions(
    action: &str,
    items: &[(String, String)],
) -> anyhow::Result<usize> {
    let mut dismissed = load_dismissed_cli_sessions();
    match action.trim().to_lowercase().as_str() {
        "unhide_all" => {
            let count = dismissed.len();
            dismissed.clear();
            save_dismissed_cli_sessions(&dismissed)?;
            Ok(count)
        }
        "hide" => {
            let mut added = 0usize;
            for (prov, sid) in items {
                if validate_safe_session_id(sid).is_ok() {
                    if dismissed.insert(cli_dismiss_key(prov, sid)) {
                        added += 1;
                    }
                }
            }
            save_dismissed_cli_sessions(&dismissed)?;
            Ok(added)
        }
        "delete" => {
            let mut deleted = 0usize;
            let mut dismissed_changed = false;
            for (prov, sid) in items {
                if delete_external_cli_session_file(prov, sid).unwrap_or(false) {
                    deleted += 1;
                }
                if dismissed.remove(&cli_dismiss_key(prov, sid)) {
                    dismissed_changed = true;
                }
            }
            if dismissed_changed {
                let _ = save_dismissed_cli_sessions(&dismissed);
            }
            Ok(deleted)
        }
        other => anyhow::bail!("Unsupported manage action: {}", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_ephemeral_sessions() {
        assert!(classify_ephemeral_session("/", "ok", false, 2, "/wt", false).is_some());
        assert!(
            classify_ephemeral_session("/Users/me/code/velo", "Reply with just OK", false, 2, "/wt", false)
                .is_some()
        );
        assert!(
            classify_ephemeral_session("/Users/me/code/velo", "hi", false, 2, "/wt", false)
                .is_some()
        );
        assert!(
            classify_ephemeral_session("/", "reply with just the word PONG", false, 2, "/wt", false)
                .is_some()
        );
        assert!(
            classify_ephemeral_session("/tmp/scratch", "debug something", false, 10, "/wt", false)
                .is_some()
        );
        // Real coding sessions MUST NOT be flagged ephemeral
        assert!(
            classify_ephemeral_session(
                "/Users/me/code/velo",
                "帮我重构一下灵动岛的展示逻辑",
                false,
                14,
                "/wt",
                false
            )
            .is_none()
        );
        // Already imported sessions are never auto-hidden
        assert!(classify_ephemeral_session("/", "ok", false, 2, "/wt", true).is_none());
    }
}
