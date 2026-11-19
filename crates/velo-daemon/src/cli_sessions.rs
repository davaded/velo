use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
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
            "casual greeting",
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
            "只回复两个字母",
            "只回复",
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

    // 3. Scan Cursor Agent CLI (`~/.cursor/chats/<hash>/<uuid>/meta.json`)
    for (dt, dto) in scan_cursor_chats(&home, &velo_wt_prefix, existing_by_provider_sid) {
        if dismissed.contains(&cli_dismiss_key(&dto.provider, &dto.cli_session_id)) {
            continue;
        }
        results.push((dt, dto));
    }

    // 4. Scan Antigravity CLI (`~/.gemini/antigravity-cli/conversation_summaries.db`, read-only)
    for (dt, dto) in scan_antigravity_cli_sessions(&home, &velo_wt_prefix, existing_by_provider_sid)
    {
        if dismissed.contains(&cli_dismiss_key(&dto.provider, &dto.cli_session_id)) {
            continue;
        }
        results.push((dt, dto));
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

    if prov_lower.starts_with("cursor") {
        return load_cursor_cli_session(&home, cli_session_id, velo_session_id);
    }

    if prov_lower.starts_with("antigravity") || prov_lower == "agy" {
        return load_antigravity_cli_session(&home, cli_session_id, velo_session_id);
    }

    anyhow::bail!("Unsupported external CLI session provider: {}", provider_str)
}

fn decode_hex_string(hex: &str) -> Option<String> {
    let clean = hex.trim();
    if clean.len() % 2 != 0 || clean.is_empty() {
        return None;
    }
    let mut bytes = Vec::with_capacity(clean.len() / 2);
    for chunk in clean.as_bytes().chunks(2) {
        let s = std::str::from_utf8(chunk).ok()?;
        let b = u8::from_str_radix(s, 16).ok()?;
        bytes.push(b);
    }
    String::from_utf8(bytes).ok()
}

fn read_cursor_store_meta(chat_dir: &Path) -> (Option<String>, usize) {
    let db_path = chat_dir.join("store.db");
    if !db_path.is_file() {
        return (None, 0);
    }
    let Ok(conn) = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return (None, 0);
    };
    let mut name: Option<String> = None;
    if let Ok(raw_hex) = conn.query_row("SELECT value FROM meta WHERE key = '0' LIMIT 1", [], |r| {
        r.get::<_, String>(0)
    }) {
        if let Some(decoded) = decode_hex_string(&raw_hex) {
            if let Ok(v) = serde_json::from_str::<Value>(&decoded) {
                if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
                    let clean = n.trim();
                    if !clean.is_empty() && !clean.eq_ignore_ascii_case("New Agent") {
                        name = Some(clean.to_string());
                    }
                }
            }
        }
    }
    let blob_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))
        .unwrap_or(0);
    let approx_msgs = ((blob_count as usize) / 4).max(if blob_count > 0 { 2 } else { 0 });
    (name, approx_msgs)
}

fn scan_cursor_chats(
    home: &Path,
    velo_wt_prefix: &str,
    existing_by_provider_sid: &HashMap<String, Uuid>,
) -> Vec<(DateTime<Utc>, ExternalCliSessionDto)> {
    let root = home.join(".cursor/chats");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut by_sid: HashMap<String, (DateTime<Utc>, ExternalCliSessionDto)> = HashMap::new();
    let Ok(ws_dirs) = fs::read_dir(&root) else {
        return Vec::new();
    };
    for ws_entry in ws_dirs.flatten() {
        let ws_path = ws_entry.path();
        if !ws_path.is_dir() {
            continue;
        }
        let Ok(chat_dirs) = fs::read_dir(&ws_path) else {
            continue;
        };
        for chat_entry in chat_dirs.flatten() {
            let chat_dir = chat_entry.path();
            if !chat_dir.is_dir() {
                continue;
            }
            let sid = chat_entry.file_name().to_string_lossy().trim().to_string();
            if sid.is_empty() || sid.starts_with('.') {
                continue;
            }
            let meta_path = chat_dir.join("meta.json");
            let Ok(raw_meta) = fs::read_to_string(&meta_path) else {
                continue;
            };
            let Ok(meta_val) = serde_json::from_str::<Value>(&raw_meta) else {
                continue;
            };
            if meta_val.get("hasConversation").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            let cwd = meta_val
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if cwd.is_empty() || !Path::new(&cwd).is_dir() {
                continue;
            }
            let updated_ms = meta_val
                .get("updatedAtMs")
                .or_else(|| meta_val.get("createdAtMs"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let dt = if updated_ms > 1_000_000_000_000 {
                Utc.timestamp_millis_opt(updated_ms)
                    .single()
                    .unwrap_or_else(Utc::now)
            } else {
                let mtime = fs::metadata(&meta_path)
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                system_time_to_utc(mtime)
            };

            let imported_id = existing_by_provider_sid.get(&sid).copied();
            if cwd.starts_with(velo_wt_prefix) && imported_id.is_some() {
                continue;
            }
            let (stored_name, approx_msgs) = read_cursor_store_meta(&chat_dir);
            if approx_msgs == 0 {
                continue;
            }
            let project_name = Path::new(&cwd)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace")
                .to_string();
            let has_custom = stored_name.is_some();
            let title = stored_name.unwrap_or_else(|| format!("Cursor · {}", project_name));
            let ephemeral_reason = classify_ephemeral_session(
                &cwd,
                &title,
                has_custom,
                approx_msgs,
                velo_wt_prefix,
                imported_id.is_some(),
            );

            let dto = ExternalCliSessionDto {
                provider: "cursor".to_string(),
                cli_session_id: sid.clone(),
                title,
                cwd: cwd.clone(),
                project_name,
                updated_at: dt.to_rfc3339(),
                message_count: approx_msgs,
                last_preview: format!("Cursor 本地对话 · {}", cwd),
                imported_session_id: imported_id,
                is_ephemeral: ephemeral_reason.is_some(),
                ephemeral_reason,
            };

            let replace = by_sid
                .get(&sid)
                .map(|(old_dt, _)| dt > *old_dt)
                .unwrap_or(true);
            if replace {
                by_sid.insert(sid, (dt, dto));
            }
        }
    }
    by_sid.into_values().collect()
}

fn load_cursor_cli_session(
    home: &Path,
    cli_session_id: &str,
    velo_sid: Uuid,
) -> anyhow::Result<ParsedExternalSession> {
    let sid = validate_safe_session_id(cli_session_id)?;
    let root = home.join(".cursor/chats");
    let mut best: Option<(DateTime<Utc>, PathBuf, String)> = None;

    if let Ok(ws_dirs) = fs::read_dir(&root) {
        for ws_entry in ws_dirs.flatten() {
            let chat_dir = ws_entry.path().join(sid);
            let meta_path = chat_dir.join("meta.json");
            if !meta_path.is_file() {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&meta_path) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    let cwd = val
                        .get("cwd")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let updated_ms = val
                        .get("updatedAtMs")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let dt = Utc
                        .timestamp_millis_opt(updated_ms)
                        .single()
                        .unwrap_or_else(Utc::now);
                    if !cwd.is_empty()
                        && best.as_ref().map(|b| dt > b.0).unwrap_or(true)
                    {
                        best = Some((dt, chat_dir, cwd));
                    }
                }
            }
        }
    }

    let (dt, chat_dir, cwd) =
        best.ok_or_else(|| anyhow::anyhow!("Cursor chat session `{}` not found", sid))?;
    let (stored_name, _) = read_cursor_store_meta(&chat_dir);
    let proj = Path::new(&cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");
    let title = stored_name.unwrap_or_else(|| format!("Cursor · {}", proj));
    let events = vec![AgentEvent::MessageDelta {
        session_id: velo_sid,
        text: format!(
            "已无缝接管本机 Cursor Agent 会话（`{}` · 目录 `{}`）。\n直接输入下一条消息将通过 `cursor-agent --resume` 原地续接上下文。",
            sid, cwd
        ),
        timestamp: dt,
    }];

    Ok(ParsedExternalSession {
        provider: AgentProvider::Cursor,
        cli_session_id: sid.to_string(),
        title: title.clone(),
        cwd,
        updated_at: dt,
        first_prompt: title,
        events,
    })
}

fn parse_first_workspace_uri(raw_json: &str) -> Option<String> {
    let arr = serde_json::from_str::<Value>(raw_json).ok()?.as_array()?.clone();
    for item in arr {
        if let Some(uri) = item.as_str() {
            let p = uri.trim().strip_prefix("file://").unwrap_or(uri.trim());
            let decoded = p.replace("%20", " ");
            if !decoded.is_empty() && Path::new(&decoded).is_dir() {
                return Some(decoded);
            }
        }
    }
    None
}

fn parse_agy_sqlite_datetime(raw: &str) -> DateTime<Utc> {
    let trimmed = raw.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return dt.with_timezone(&Utc);
    }
    let iso_like = trimmed.replacen(' ', "T", 1);
    if let Ok(dt) = DateTime::parse_from_rfc3339(&iso_like) {
        return dt.with_timezone(&Utc);
    }
    Utc::now()
}

fn scan_antigravity_cli_sessions(
    home: &Path,
    velo_wt_prefix: &str,
    existing_by_provider_sid: &HashMap<String, Uuid>,
) -> Vec<(DateTime<Utc>, ExternalCliSessionDto)> {
    let db_path = home.join(".gemini/antigravity-cli/conversation_summaries.db");
    if !db_path.is_file() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris \
         FROM conversation_summaries \
         WHERE nesting_depth = 0 AND killed = 0 \
         ORDER BY last_modified_time DESC LIMIT 40",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1).unwrap_or_default(),
            r.get::<_, String>(2).unwrap_or_default(),
            r.get::<_, i64>(3).unwrap_or(0),
            r.get::<_, String>(4).unwrap_or_default(),
            r.get::<_, String>(5).unwrap_or_default(),
        ))
    }) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (cid, raw_title, raw_preview, step_count, modified_str, ws_uris) = row;
        if cid.trim().is_empty() || step_count <= 0 {
            continue;
        }
        let Some(cwd) = parse_first_workspace_uri(&ws_uris) else {
            continue;
        };
        let imported_id = existing_by_provider_sid.get(&cid).copied();
        if cwd.starts_with(velo_wt_prefix) && imported_id.is_some() {
            continue;
        }
        let clean_title = clean_title_snippet(&raw_title);
        let clean_prev = clean_title_snippet(&raw_preview);
        if clean_prev.starts_with("<conversation_history>") && clean_title.is_empty() {
            continue;
        }
        let project_name = Path::new(&cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_string();
        let has_custom = !clean_title.is_empty();
        let title = if !clean_title.is_empty() {
            clean_title
        } else if !clean_prev.is_empty() {
            clean_prev.clone()
        } else {
            format!("Antigravity · {}", project_name)
        };
        let msg_est = (step_count as usize).max(2);
        let ephemeral_reason = classify_ephemeral_session(
            &cwd,
            &title,
            false,
            msg_est,
            velo_wt_prefix,
            imported_id.is_some(),
        );
        // Also flag tiny 2-step "Casual Greeting" even when agy auto-titled it
        let final_ephemeral = ephemeral_reason.or_else(|| {
            if !has_custom && msg_est <= 2 {
                Some("极短临时会话".to_string())
            } else {
                None
            }
        });

        let dt = parse_agy_sqlite_datetime(&modified_str);
        out.push((
            dt,
            ExternalCliSessionDto {
                provider: "antigravity".to_string(),
                cli_session_id: cid,
                title,
                cwd,
                project_name,
                updated_at: dt.to_rfc3339(),
                message_count: msg_est,
                last_preview: clean_prev,
                imported_session_id: imported_id,
                is_ephemeral: final_ephemeral.is_some(),
                ephemeral_reason: final_ephemeral,
            },
        ));
    }
    out
}

fn load_antigravity_cli_session(
    home: &Path,
    cli_session_id: &str,
    velo_sid: Uuid,
) -> anyhow::Result<ParsedExternalSession> {
    let sid = validate_safe_session_id(cli_session_id)?;
    let db_path = home.join(".gemini/antigravity-cli/conversation_summaries.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let (raw_title, raw_preview, modified_str, ws_uris): (String, String, String, String) = conn
        .query_row(
            "SELECT title, preview, last_modified_time, workspace_uris \
             FROM conversation_summaries WHERE conversation_id = ?1 LIMIT 1",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;

    let cwd = parse_first_workspace_uri(&ws_uris)
        .unwrap_or_else(|| home.to_string_lossy().to_string());
    let dt = parse_agy_sqlite_datetime(&modified_str);
    let title = {
        let t = clean_title_snippet(&raw_title);
        if !t.is_empty() {
            t
        } else {
            let p = clean_title_snippet(&raw_preview);
            if !p.is_empty() { p } else { format!("Antigravity · {}", &sid[..8.min(sid.len())]) }
        }
    };

    let mut events = Vec::new();
    // Reconstruct recent preview turns from conversations_fts if available (read-only)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT user_body, agent_body FROM conversations_fts WHERE conversation_id = ?1 LIMIT 6",
    ) {
        if let Ok(rows) = stmt.query_map([sid], |r| {
            Ok((r.get::<_, String>(0).unwrap_or_default(), r.get::<_, String>(1).unwrap_or_default()))
        }) {
            for (u_txt, a_txt) in rows.flatten() {
                if !u_txt.trim().is_empty() {
                    events.push(AgentEvent::UserMessage {
                        session_id: velo_sid,
                        text: u_txt.chars().take(1800).collect(),
                        images: Vec::new(),
                        timestamp: dt,
                    });
                }
                if !a_txt.trim().is_empty() {
                    events.push(AgentEvent::MessageDelta {
                        session_id: velo_sid,
                        text: a_txt.chars().take(2400).collect(),
                        timestamp: dt,
                    });
                }
            }
        }
    }

    if events.is_empty() {
        events.push(AgentEvent::MessageDelta {
            session_id: velo_sid,
            text: format!(
                "已接管本机 Antigravity CLI 会话（`{}` · 目录 `{}`）。\n直接输入下一条消息将通过 `agy --conversation` 原地续接上下文。",
                sid, cwd
            ),
            timestamp: dt,
        });
    }

    Ok(ParsedExternalSession {
        provider: AgentProvider::Antigravity,
        cli_session_id: sid.to_string(),
        title: title.clone(),
        cwd,
        updated_at: dt,
        first_prompt: title,
        events,
    })
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

    if prov.starts_with("cursor") {
        let root = home.join(".cursor/chats");
        if !root.is_dir() {
            return Ok(false);
        }
        let canonical_root = fs::canonicalize(&root)?;
        let mut deleted = false;
        if let Ok(ws_dirs) = fs::read_dir(&root) {
            for ws_entry in ws_dirs.flatten() {
                let candidate = ws_entry.path().join(sid);
                if candidate.is_dir() {
                    if let Ok(canon_dir) = fs::canonicalize(&candidate) {
                        if canon_dir.starts_with(&canonical_root) && canon_dir != canonical_root {
                            fs::remove_dir_all(&canon_dir)?;
                            deleted = true;
                        }
                    }
                }
            }
        }
        return Ok(deleted);
    }

    if prov.starts_with("antigravity") || prov == "agy" {
        // Safely dismiss Antigravity CLI sessions via Velo's hide list without mutating agy's SQLite DB
        let mut dismissed = load_dismissed_cli_sessions();
        let inserted = dismissed.insert(cli_dismiss_key("antigravity", sid));
        save_dismissed_cli_sessions(&dismissed)?;
        return Ok(inserted);
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
                let p_low = prov.trim().to_lowercase();
                if p_low.starts_with("antigravity") || p_low == "agy" {
                    if validate_safe_session_id(sid).is_ok()
                        && dismissed.insert(cli_dismiss_key("antigravity", sid))
                    {
                        deleted += 1;
                        dismissed_changed = true;
                    }
                    continue;
                }
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
