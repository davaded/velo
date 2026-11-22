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
    #[serde(default = "default_global_scope")]
    pub scope: String,
    #[serde(default)]
    pub editable: bool,
}

fn default_global_scope() -> String {
    "global".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveCustomSkillRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default = "default_global_scope")]
    pub scope: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub existing_path: Option<String>,
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

fn scan_skills_dir(
    root: &Path,
    engine: &str,
    scope: &str,
    editable: bool,
    out: &mut Vec<SkillEntryDto>,
    seen: &mut HashSet<String>,
) {
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
        let dedup_key = format!("{scope}:{engine}:{}", name.to_lowercase());
        if seen.insert(dedup_key) {
            out.push(SkillEntryDto {
                id: format!("{scope}-{engine}-{folder_name}"),
                name,
                engine: engine.to_string(),
                description,
                path: skill_md.to_string_lossy().to_string(),
                scope: scope.to_string(),
                editable,
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

/// Scans local MCP servers and Skills across Velo, Codex, Cursor, Claude Code, Antigravity,
/// and optionally the active workspace project directory (`.velo/skills`, `.claude/skills`, `.codex/skills`, `.cursor/skills`, `.agents/skills`).
pub fn scan_local_extensions() -> LocalExtensionsSnapshotDto {
    scan_local_extensions_for_workspace(None)
}

pub fn scan_local_extensions_for_workspace(workspace: Option<&Path>) -> LocalExtensionsSnapshotDto {
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

    // 1. Project-level skills inside active workspace (shown first!)
    if let Some(ws_root) = workspace.filter(|p| p.is_dir()) {
        for (rel, eng, editable) in [
            (".velo/skills", "velo", true),
            (".claude/skills", "claude", false),
            (".codex/skills", "codex", false),
            (".cursor/skills", "cursor", false),
            (".agents/skills", "velo", false),
        ] {
            scan_skills_dir(
                &ws_root.join(rel),
                eng,
                "project",
                editable,
                &mut skills,
                &mut seen_skills,
            );
        }
    }

    // 2. Global Velo custom cross-engine skills + universal `~/.agents/skills` + engine skills
    for (rel, eng, editable) in [
        (".velo/skills", "velo", true),
        (".agents/skills", "velo", false),
        (".codex/skills", "codex", false),
        (".cursor/skills", "cursor", false),
        (".claude/skills", "claude", false),
        (".gemini/antigravity/skills", "antigravity", false),
        (".gemini/antigravity/builtin/skills", "antigravity", false),
        (".gemini/antigravity-cli/skills", "antigravity", false),
    ] {
        scan_skills_dir(
            &home.join(rel),
            eng,
            "global",
            editable,
            &mut skills,
            &mut seen_skills,
        );
    }
    for (plugins_rel, eng) in [
        (".gemini/config/plugins", "antigravity"),
        (".claude/plugins", "claude"),
    ] {
        if let Ok(rd) = fs::read_dir(home.join(plugins_rel)) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    scan_skills_dir(
                        &p.join("skills"),
                        eng,
                        "global",
                        false,
                        &mut skills,
                        &mut seen_skills,
                    );
                }
            }
        }
    }

    // Sort: project scope first, then `velo` custom skills, then alphabetical by engine & name
    skills.sort_by(|a, b| {
        let scope_rank = |s: &str| if s == "project" { 0 } else { 1 };
        let eng_rank = |e: &str| if e == "velo" { 0 } else { 1 };
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| eng_rank(&a.engine).cmp(&eng_rank(&b.engine)))
            .then_with(|| a.engine.cmp(&b.engine))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    LocalExtensionsSnapshotDto {
        mcp_servers,
        skills,
    }
}

fn is_valid_skill_md_path(canon: &Path) -> bool {
    if canon.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return false;
    }
    let Some(skill_dir) = canon.parent() else {
        return false;
    };
    let Some(skills_parent) = skill_dir.parent() else {
        return false;
    };
    if skills_parent.file_name().and_then(|n| n.to_str()) != Some("skills") {
        return false;
    }
    let parent_str = skills_parent.to_string_lossy();
    parent_str.contains("/.velo/skills")
        || parent_str.contains("/.claude/skills")
        || parent_str.contains("/.claude/plugins/")
        || parent_str.contains("/.codex/skills")
        || parent_str.contains("/.cursor/skills")
        || parent_str.contains("/.agents/skills")
        || parent_str.contains("/.gemini/antigravity/")
        || parent_str.contains("/.gemini/antigravity-cli/")
        || parent_str.contains("/.gemini/config/plugins/")
}

fn is_editable_velo_skill_md_path(canon: &Path) -> bool {
    if canon.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        return false;
    }
    let Some(skill_dir) = canon.parent() else {
        return false;
    };
    let Some(skills_root) = skill_dir.parent() else {
        return false;
    };
    let Some(dot_velo) = skills_root.parent() else {
        return false;
    };
    skills_root.file_name().and_then(|n| n.to_str()) == Some("skills")
        && dot_velo.file_name().and_then(|n| n.to_str()) == Some(".velo")
}

/// Prompt sent to the engine for one turn. The chat transcript keeps `visible`.
pub fn skill_turn_prompt(visible: &str, skill_path: Option<&str>) -> String {
    let Some(path) = skill_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return visible.to_string();
    };
    let Ok(raw) = read_skill_markdown(path) else {
        return visible.to_string();
    };
    let body: String = raw.chars().take(24_000).collect();
    format!(
        "Follow the skill below for this turn. Apply its steps to the user task. Do not repeat the skill text back unless the user asks.\n\n{body}\n\n---\nUser task:\n{visible}\n"
    )
}

/// Safely reads the full markdown source of any discovered `SKILL.md` file.
pub fn read_skill_markdown(raw_path: &str) -> anyhow::Result<String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Skill path is empty");
    }
    let canon = fs::canonicalize(Path::new(trimmed))
        .map_err(|_| anyhow::anyhow!("Skill file not found"))?;
    if !is_valid_skill_md_path(&canon) {
        anyhow::bail!("Access denied: path is not a recognized SKILL.md");
    }
    let raw = fs::read_to_string(&canon)?;
    Ok(raw)
}

fn slugify_skill_name(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if ch == '-' || ch == '_' || ch.is_whitespace() {
            if !slug.is_empty() && !prev_dash {
                slug.push('-');
                prev_dash = true;
            }
        } else if !ch.is_control() && ch != '/' && ch != '\\' && ch != '.' {
            // Preserve CJK / Unicode characters cleanly in folder names
            slug.push(ch);
            prev_dash = false;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("custom-skill-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
    } else {
        trimmed.chars().take(48).collect()
    }
}

/// Creates or updates a Velo custom cross-engine skill (`~/.velo/skills/<slug>/SKILL.md`
/// or `<workspace>/.velo/skills/<slug>/SKILL.md`).
pub fn save_custom_skill(req: SaveCustomSkillRequest) -> anyhow::Result<SkillEntryDto> {
    let clean_name = req.name.trim();
    if clean_name.is_empty() {
        anyhow::bail!("Skill name cannot be empty");
    }
    let clean_desc = req.description.trim();
    let raw_body = req.content.trim();
    if raw_body.is_empty() {
        anyhow::bail!("Skill instructions cannot be empty");
    }

    let (skill_md_path, folder_name, scope_label) = if let Some(existing) =
        req.existing_path.as_deref().map(str::trim).filter(|s| !s.is_empty())
    {
        let canon = fs::canonicalize(Path::new(existing))
            .map_err(|_| anyhow::anyhow!("Existing skill file not found"))?;
        if !is_editable_velo_skill_md_path(&canon) {
            anyhow::bail!("Only Velo custom skills under .velo/skills can be edited");
        }
        let folder = canon
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("custom")
            .to_string();
        let home_velo = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join(".velo/skills"));
        let scope = match home_velo.and_then(|hv| fs::canonicalize(hv).ok()) {
            Some(hv) if canon.starts_with(&hv) => "global".to_string(),
            _ => "project".to_string(),
        };
        (canon, folder, scope)
    } else {
        let slug = slugify_skill_name(clean_name);
        let (base_root, scope) = if req.scope == "project" {
            let ws_str = req
                .workspace
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Workspace path required for project skill"))?;
            let ws_path = crate::canonical_workspace_path(ws_str);
            (PathBuf::from(ws_path).join(".velo/skills"), "project".to_string())
        } else {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| anyhow::anyhow!("HOME environment variable not set"))?;
            (home.join(".velo/skills"), "global".to_string())
        };
        let target_dir = base_root.join(&slug);
        fs::create_dir_all(&target_dir)?;
        (target_dir.join("SKILL.md"), slug, scope)
    };

    // If the user already wrote full frontmatter, respect it; otherwise prepend standard YAML frontmatter
    let final_markdown = if raw_body.starts_with("---") {
        format!("{}\n", raw_body)
    } else {
        let safe_name = clean_name.replace('"', "\\\"");
        let safe_desc = if clean_desc.is_empty() {
            raw_body
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('#'))
                .unwrap_or(clean_name)
                .chars()
                .take(120)
                .collect::<String>()
        } else {
            clean_desc.to_string()
        }
        .replace('"', "\\\"");
        format!(
            "---\nname: \"{}\"\ndescription: \"{}\"\n---\n\n{}\n",
            safe_name, safe_desc, raw_body
        )
    };

    fs::write(&skill_md_path, &final_markdown)?;
    let (parsed_name, parsed_desc) = parse_skill_frontmatter(&final_markdown, &folder_name);

    Ok(SkillEntryDto {
        id: format!("{scope_label}-velo-{folder_name}"),
        name: parsed_name,
        engine: "velo".to_string(),
        description: parsed_desc,
        path: skill_md_path.to_string_lossy().to_string(),
        scope: scope_label,
        editable: true,
    })
}

/// Safely deletes a Velo custom skill folder (strictly restricted to `.velo/skills/<slug>/SKILL.md`).
pub fn delete_custom_skill(raw_path: &str) -> anyhow::Result<()> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Skill path is empty");
    }
    let canon = fs::canonicalize(Path::new(trimmed))
        .map_err(|_| anyhow::anyhow!("Skill file not found"))?;
    if !is_editable_velo_skill_md_path(&canon) {
        anyhow::bail!("Only Velo custom skills under .velo/skills can be deleted");
    }
    let Some(skill_dir) = canon.parent() else {
        anyhow::bail!("Invalid skill directory");
    };
    fs::remove_dir_all(skill_dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_skill_lifecycle_and_path_safety() {
        let temp_ws = std::env::temp_dir().join(format!(
            "velo-skill-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&temp_ws).unwrap();

        let saved = save_custom_skill(SaveCustomSkillRequest {
            name: "SwiftUI Audit".to_string(),
            description: "Check SwiftUI view hierarchy and performance".to_string(),
            content: "# SwiftUI Audit\n\n1. Check `@ObservedObject` ownership.".to_string(),
            scope: "project".to_string(),
            workspace: Some(temp_ws.to_string_lossy().to_string()),
            existing_path: None,
        })
        .expect("save project skill");

        assert_eq!(saved.scope, "project");
        assert_eq!(saved.engine, "velo");
        assert!(saved.editable);
        assert!(saved.path.ends_with("/.velo/skills/swiftui-audit/SKILL.md"));

        let snap = scan_local_extensions_for_workspace(Some(&temp_ws));
        assert!(snap
            .skills
            .iter()
            .any(|s| s.name == "SwiftUI Audit" && s.scope == "project" && s.editable));

        let content = read_skill_markdown(&saved.path).expect("read saved skill");
        assert!(content.contains("@ObservedObject"));

        let expanded = skill_turn_prompt("/SwiftUI Audit check views", Some(&saved.path));
        assert!(expanded.contains("@ObservedObject"));
        assert!(expanded.contains("User task:\n/SwiftUI Audit check views"));
        assert_eq!(skill_turn_prompt("hello", None), "hello");
        assert_eq!(skill_turn_prompt("hello", Some("/etc/hosts")), "hello");

        // Path traversal / arbitrary file read must be rejected
        assert!(read_skill_markdown("/etc/hosts").is_err());
        assert!(delete_custom_skill("/etc/hosts").is_err());

        delete_custom_skill(&saved.path).expect("delete custom skill");
        assert!(!Path::new(&saved.path).exists());

        let _ = fs::remove_dir_all(&temp_ws);
    }
}
