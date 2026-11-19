use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerEntryDto {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub transport: String,
    pub target: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntryDto {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalExtensionsSnapshotDto {
    pub mcp_servers: Vec<McpServerEntryDto>,
    pub skills: Vec<SkillEntryDto>,
}

fn parse_skill_frontmatter(raw: &str, fallback_name: &str) -> (String, String) {
    let mut name = fallback_name.to_string();
    let mut desc = String::new();
    let trimmed = raw.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end_idx) = rest.find("\n---") {
            let yaml = &rest[..end_idx];
            for line in yaml.lines() {
                let l = line.trim();
                if let Some(v) = l.strip_prefix("name:") {
                    let clean = v.trim().trim_matches('"').trim_matches('\'');
                    if !clean.is_empty() {
                        name = clean.to_string();
                    }
                } else if let Some(v) = l.strip_prefix("description:") {
                    let clean = v.trim().trim_matches('"').trim_matches('\'');
                    if !clean.is_empty() {
                        desc = clean.to_string();
                    }
                }
            }
        }
    }
    if desc.is_empty() {
        for line in raw.lines() {
            let l = line.trim();
            if !l.is_empty() && !l.starts_with("---") && !l.starts_with('#') {
                desc = l.chars().take(120).collect();
                break;
            }
        }
    }
    (name, desc)
}

fn scan_skills_dir(root: &Path, engine: &str, out: &mut Vec<SkillEntryDto>, seen: &mut HashSet<String>) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let folder_name = entry.file_name().to_string_lossy().to_string();
        if folder_name.starts_with('.') {
            continue;
        }
        let skill_md = if p.is_dir() {
            p.join("SKILL.md")
        } else {
            continue;
        };
        if !skill_md.is_file() {
            continue;
        }
        let raw = fs::read_to_string(&skill_md).unwrap_or_default();
        let (name, description) = parse_skill_frontmatter(&raw, &folder_name);
        let dedup_key = format!("{engine}:{}", name.to_lowercase());
        if seen.insert(dedup_key) {
            out.push(SkillEntryDto {
                id: format!("{engine}-{folder_name}"),
                name,
                engine: engine.to_string(),
                description,
                path: skill_md.to_string_lossy().to_string(),
            });
        }
    }
}

fn parse_mcp_json_map(
    obj: &serde_json::Map<String, Value>,
    engine: &str,
    out: &mut Vec<McpServerEntryDto>,
    seen: &mut HashSet<String>,
) {
    for (name, cfg) in obj {
        let key = format!("{engine}:{}", name.to_lowercase());
        if !seen.insert(key) {
            continue;
        }
        let disabled = cfg
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let (transport, target) = if let Some(u) = cfg
            .get("url")
            .or_else(|| cfg.get("serverUrl"))
            .and_then(|v| v.as_str())
        {
            ("http".to_string(), u.to_string())
        } else if let Some(cmd) = cfg.get("command").and_then(|v| v.as_str()) {
            let args: Vec<&str> = cfg
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).take(3).collect())
                .unwrap_or_default();
            let summary = if args.is_empty() {
                cmd.to_string()
            } else {
                format!("{} {}", cmd, args.join(" "))
            };
            ("stdio".to_string(), summary)
        } else {
            ("stdio".to_string(), "configured".to_string())
        };

        out.push(McpServerEntryDto {
            id: format!("{engine}-{name}"),
            name: name.clone(),
            engine: engine.to_string(),
            transport,
            target,
            enabled: !disabled,
        });
    }
}

fn scan_codex_toml_mcps(
    raw_toml: &str,
    out: &mut Vec<McpServerEntryDto>,
    seen: &mut HashSet<String>,
) {
    let mut current_mcp: Option<String> = None;
    let mut cmd_map: std::collections::HashMap<String, (String, String, bool)> =
        std::collections::HashMap::new();

    for line in raw_toml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let sec = &trimmed[1..trimmed.len() - 1];
            if let Some(rest) = sec.strip_prefix("mcp_servers.") {
                let name = rest
                    .split('.')
                    .next()
                    .unwrap_or(rest)
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if !rest.contains('.') {
                    cmd_map
                        .entry(name.clone())
                        .or_insert_with(|| ("stdio".to_string(), String::new(), true));
                    current_mcp = Some(name);
                } else {
                    current_mcp = None;
                }
            } else {
                current_mcp = None;
            }
            continue;
        }

        if let Some(ref name) = current_mcp {
            if let Some((k, v)) = trimmed.split_once('=') {
                let key = k.trim();
                let val = v.trim().trim_matches('"').trim_matches('\'');
                if let Some(entry) = cmd_map.get_mut(name) {
                    match key {
                        "command" => {
                            entry.0 = "stdio".to_string();
                            entry.1 = val.to_string();
                        }
                        "url" => {
                            entry.0 = "http".to_string();
                            entry.1 = val.to_string();
                        }
                        "enabled" => {
                            entry.2 = !val.eq_ignore_ascii_case("false");
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    for (name, (transport, target, enabled)) in cmd_map {
        let key = format!("codex:{}", name.to_lowercase());
        if seen.insert(key) {
            out.push(McpServerEntryDto {
                id: format!("codex-{name}"),
                name,
                engine: "codex".to_string(),
                transport,
                target: if target.is_empty() {
                    "configured".to_string()
                } else {
                    target
                },
                enabled,
            });
        }
    }
}

/// Scans local MCP servers and Skills across Codex, Cursor, Claude Code, and Antigravity (read-only).
pub fn scan_local_extensions() -> LocalExtensionsSnapshotDto {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return LocalExtensionsSnapshotDto {
            mcp_servers: Vec::new(),
            skills: Vec::new(),
        };
    };

    let mut mcp_servers = Vec::new();
    let mut seen_mcp = HashSet::new();

    // 1. Cursor MCP (`~/.cursor/mcp.json`)
    if let Ok(raw) = fs::read_to_string(home.join(".cursor/mcp.json")) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(map) = val.get("mcpServers").and_then(|v| v.as_object()) {
                parse_mcp_json_map(map, "cursor", &mut mcp_servers, &mut seen_mcp);
            }
        }
    }

    // 2. Claude Code MCP (`~/.claude.json` & `~/.claude/settings.json`)
    for rel in [".claude.json", ".claude/settings.json"] {
        if let Ok(raw) = fs::read_to_string(home.join(rel)) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(map) = val.get("mcpServers").and_then(|v| v.as_object()) {
                    parse_mcp_json_map(map, "claude", &mut mcp_servers, &mut seen_mcp);
                }
            }
        }
    }

    // 3. Codex MCP (`~/.codex/config.toml`)
    if let Ok(raw) = fs::read_to_string(home.join(".codex/config.toml")) {
        scan_codex_toml_mcps(&raw, &mut mcp_servers, &mut seen_mcp);
    }

    // 4. Antigravity MCP (`~/.gemini/antigravity/mcp_config.json` & `~/.gemini/config/plugins/*/mcp_config.json`)
    if let Ok(raw) = fs::read_to_string(home.join(".gemini/antigravity/mcp_config.json")) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(map) = val.get("mcpServers").and_then(|v| v.as_object()) {
                parse_mcp_json_map(map, "antigravity", &mut mcp_servers, &mut seen_mcp);
            }
        }
    }
    if let Ok(rd) = fs::read_dir(home.join(".gemini/config/plugins")) {
        for entry in rd.flatten() {
            let cfg_path = entry.path().join("mcp_config.json");
            if let Ok(raw) = fs::read_to_string(cfg_path) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    if let Some(map) = val.get("mcpServers").and_then(|v| v.as_object()) {
                        parse_mcp_json_map(map, "antigravity", &mut mcp_servers, &mut seen_mcp);
                    }
                }
            }
        }
    }

    mcp_servers.sort_by(|a, b| a.engine.cmp(&b.engine).then_with(|| a.name.cmp(&b.name)));

    let mut skills = Vec::new();
    let mut seen_skills = HashSet::new();
    for (rel, eng) in [
        (".codex/skills", "codex"),
        (".cursor/skills", "cursor"),
        (".claude/skills", "claude"),
        (".gemini/antigravity/skills", "antigravity"),
        (".gemini/antigravity/builtin/skills", "antigravity"),
        (".gemini/antigravity-cli/skills", "antigravity"),
    ] {
        scan_skills_dir(&home.join(rel), eng, &mut skills, &mut seen_skills);
    }
    for (plugins_rel, eng) in [
        (".gemini/config/plugins", "antigravity"),
        (".claude/plugins", "claude"),
    ] {
        if let Ok(rd) = fs::read_dir(home.join(plugins_rel)) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    scan_skills_dir(&p.join("skills"), eng, &mut skills, &mut seen_skills);
                }
            }
        }
    }
    skills.sort_by(|a, b| a.engine.cmp(&b.engine).then_with(|| a.name.cmp(&b.name)));

    LocalExtensionsSnapshotDto {
        mcp_servers,
        skills,
    }
}
