use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant, SystemTime};
use velo_protocol::{AgentEvent, RateLimitWindowDto, SessionInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderQuotaCardDto {
    pub provider: String,
    pub label: String,
    pub plan_badge: String,
    /// `"subscription"` | `"api_key"` | `"unauthenticated"`
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_text: Option<String>,
    pub windows: Vec<RateLimitWindowDto>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedQuotaCache {
    pub by_provider: HashMap<String, Vec<RateLimitWindowDto>>,
}

static LIVE_PROBE_CACHE: OnceLock<Mutex<Option<(Instant, Vec<ProviderQuotaCardDto>)>>> =
    OnceLock::new();

pub fn load_quota_cache(path: &Path) -> PersistedQuotaCache {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<PersistedQuotaCache>(&s).ok())
        .unwrap_or_default()
}

pub fn save_quota_cache(path: &Path, cache: &PersistedQuotaCache) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(path, s);
    }
}

fn status_for_used_pct(used: f64) -> String {
    if used >= 99.5 {
        "exhausted".to_string()
    } else if used >= 82.0 {
        "warning".to_string()
    } else {
        "healthy".to_string()
    }
}

fn extract_url_host(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .trim()
        .to_string()
}

fn parse_any_timestamp(val: &Value) -> Option<DateTime<Utc>> {
    if let Some(s) = val.as_str() {
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    if let Some(sec) = val.as_i64() {
        let s = if sec > 1_000_000_000_000 {
            sec / 1000
        } else {
            sec
        };
        return Utc.timestamp_opt(s, 0).single();
    }
    if let Some(f) = val.as_f64() {
        let s = if f > 1_000_000_000_000.0 {
            (f / 1000.0) as i64
        } else {
            f as i64
        };
        return Utc.timestamp_opt(s, 0).single();
    }
    None
}

fn refresh_window_countdown(
    mut w: RateLimitWindowDto,
    now: DateTime<Utc>,
) -> Option<RateLimitWindowDto> {
    if let Some(resets) = w.resets_at {
        let diff = (resets - now).num_seconds();
        if diff <= 0 {
            return None;
        }
        w.reset_in_seconds = Some(diff);
    }
    w.used_percent = (w.used_percent * 10.0).round() / 10.0;
    w.remaining_percent = ((100.0 - w.used_percent).clamp(0.0, 100.0) * 10.0).round() / 10.0;
    w.status = status_for_used_pct(w.used_percent);
    Some(w)
}

fn curl_json_get(url: &str, headers: &[(&str, String)]) -> Option<Value> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-sS", "--max-time", "5", "-H", "Accept: application/json"]);
    for (k, v) in headers {
        cmd.arg("-H").arg(format!("{k}: {v}"));
    }
    cmd.arg(url);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice::<Value>(&out.stdout).ok()
}

/// Parses gateway `/v1/usage` ONLY for real rate-limit / subscription windows (`5h` / `1d` / `7d` / `30d`).
/// Unrestricted / pay-as-you-go / wallet keys return `None` here so they are classified as `mode: "api_key"`
/// with zero fabricated progress bars.
fn parse_gateway_subscription_windows(
    provider: &str,
    label: &str,
    val: &Value,
    now: DateTime<Utc>,
) -> Option<ProviderQuotaCardDto> {
    let plan_name = val
        .get("planName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "钱包余额")
        .unwrap_or("网关限额")
        .to_string();

    // 1. Key-level `rate_limits` array (`window: "5h" | "1d" | "7d"` with `limit > 0`)
    if let Some(rl_arr) = val.get("rate_limits").and_then(|v| v.as_array()) {
        let mut wins = Vec::new();
        for entry in rl_arr {
            let win_id = entry.get("window").and_then(|v| v.as_str()).unwrap_or("5h");
            let limit = entry.get("limit").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let used = entry.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if limit <= 0.0 {
                continue;
            }
            let used_pct = ((used / limit) * 100.0).clamp(0.0, 100.0);
            let resets_at = entry.get("reset_at").and_then(parse_any_timestamp);
            let reset_in_seconds = resets_at
                .map(|r| (r - now).num_seconds())
                .filter(|&s| s > 0);
            let win_label = match win_id {
                "5h" => "5h 窗口",
                "1d" => "今日限额",
                "7d" => "7d 周限额",
                _ => win_id,
            };
            wins.push(RateLimitWindowDto {
                id: win_id.to_string(),
                label: win_label.to_string(),
                used_percent: (used_pct * 10.0).round() / 10.0,
                remaining_percent: (((100.0 - used_pct).clamp(0.0, 100.0)) * 10.0).round() / 10.0,
                resets_at,
                reset_in_seconds,
                detail_text: Some(format!("${:.2} / ${:.2}", used, limit)),
                status: status_for_used_pct(used_pct),
                source: "provider_api".to_string(),
            });
        }
        if !wins.is_empty() {
            return Some(ProviderQuotaCardDto {
                provider: provider.to_string(),
                label: label.to_string(),
                plan_badge: plan_name,
                mode: "subscription".to_string(),
                summary_text: None,
                windows: wins,
                updated_at: now,
            });
        }
    }

    // 2. Group `subscription` (`daily_limit_usd` / `weekly_limit_usd` / `monthly_limit_usd` > 0)
    if let Some(sub) = val.get("subscription").and_then(|v| v.as_object()) {
        let mut wins = Vec::new();
        for (u_key, l_key, id, win_label) in [
            ("daily_usage_usd", "daily_limit_usd", "1d", "今日额度"),
            ("weekly_usage_usd", "weekly_limit_usd", "7d", "7d 周额度"),
            ("monthly_usage_usd", "monthly_limit_usd", "30d", "月度额度"),
        ] {
            if let Some(limit) = sub.get(l_key).and_then(|v| v.as_f64()).filter(|&l| l > 0.0) {
                let used = sub.get(u_key).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let used_pct = ((used / limit) * 100.0).clamp(0.0, 100.0);
                wins.push(RateLimitWindowDto {
                    id: id.to_string(),
                    label: win_label.to_string(),
                    used_percent: (used_pct * 10.0).round() / 10.0,
                    remaining_percent: (((100.0 - used_pct).clamp(0.0, 100.0)) * 10.0).round()
                        / 10.0,
                    resets_at: None,
                    reset_in_seconds: None,
                    detail_text: Some(format!("${:.2} / ${:.2}", used, limit)),
                    status: status_for_used_pct(used_pct),
                    source: "provider_api".to_string(),
                });
            }
        }
        if !wins.is_empty() {
            return Some(ProviderQuotaCardDto {
                provider: provider.to_string(),
                label: label.to_string(),
                plan_badge: plan_name,
                mode: "subscription".to_string(),
                summary_text: None,
                windows: wins,
                updated_at: now,
            });
        }
    }

    None
}

fn build_custom_gateway_api_key_card(
    provider: &str,
    label: &str,
    base_url: &str,
    now: DateTime<Utc>,
) -> ProviderQuotaCardDto {
    let host = extract_url_host(base_url);
    let summary = if host.is_empty() {
        "自定义网关 API Key · 无 5h/7d 速率窗口".to_string()
    } else {
        format!("自定义网关 ({host}) · 无 5h/7d 速率窗口")
    };
    ProviderQuotaCardDto {
        provider: provider.to_string(),
        label: label.to_string(),
        plan_badge: "自定义网关 · API Key".to_string(),
        mode: "api_key".to_string(),
        summary_text: Some(summary),
        windows: Vec::new(),
        updated_at: now,
    }
}

fn probe_claude_card(
    home: &Path,
    cache: &PersistedQuotaCache,
    now: DateTime<Utc>,
) -> ProviderQuotaCardDto {
    // 1. Check `~/.claude/settings.json` for custom gateway or direct Anthropic API key
    if let Ok(raw_settings) = fs::read_to_string(home.join(".claude/settings.json")) {
        if let Ok(settings_val) = serde_json::from_str::<Value>(&raw_settings) {
            let base_url = settings_val
                .pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(|v| v.as_str())
                .map(|s| s.trim_end_matches('/'))
                .filter(|s| !s.is_empty());
            let token = settings_val
                .pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .or_else(|| settings_val.pointer("/env/ANTHROPIC_API_KEY"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());

            if let Some(base) = base_url {
                let host = extract_url_host(base);
                if !host.eq_ignore_ascii_case("api.anthropic.com") {
                    if let Some(tok) = token {
                        let usage_url = if base.ends_with("/v1") {
                            format!("{base}/usage")
                        } else {
                            format!("{base}/v1/usage")
                        };
                        if let Some(u_val) = curl_json_get(
                            &usage_url,
                            &[("Authorization", format!("Bearer {tok}"))],
                        ) {
                            if let Some(sub_card) = parse_gateway_subscription_windows(
                                "claude",
                                "Claude Code",
                                &u_val,
                                now,
                            ) {
                                return sub_card;
                            }
                        }
                    }
                    return build_custom_gateway_api_key_card("claude", "Claude Code", base, now);
                }
            }

            if token.is_some() {
                return ProviderQuotaCardDto {
                    provider: "claude".to_string(),
                    label: "Claude Code".to_string(),
                    plan_badge: "Anthropic API Key".to_string(),
                    mode: "api_key".to_string(),
                    summary_text: Some("Anthropic API Key 按量计费 · 无 5h/7d 订阅窗口".to_string()),
                    windows: Vec::new(),
                    updated_at: now,
                };
            }
        }
    }

    // 2. Check Official Claude Code OAuth Keychain (`Claude Code-credentials` -> `claudeAiOauth.accessToken`)
    let mut has_claude_oauth = false;
    if let Ok(kc_out) = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
    {
        if kc_out.status.success() {
            if let Ok(cred_val) = serde_json::from_slice::<Value>(&kc_out.stdout) {
                if let Some(tok) = cred_val
                    .pointer("/claudeAiOauth/accessToken")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    has_claude_oauth = true;
                    let sub_type = cred_val
                        .pointer("/claudeAiOauth/subscriptionType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Pro / Max");
                    if let Some(usage_val) = curl_json_get(
                        "https://api.anthropic.com/api/oauth/usage",
                        &[
                            ("Authorization", format!("Bearer {tok}")),
                            ("anthropic-beta", "oauth-2025-04-20".to_string()),
                            ("User-Agent", "claude-code/2.1.0".to_string()),
                        ],
                    ) {
                        let mut wins = Vec::new();
                        for (field, id, win_label) in [
                            ("five_hour", "5h", "5h 窗口"),
                            ("seven_day", "7d", "7d 周配额"),
                        ] {
                            if let Some(w_obj) = usage_val.get(field) {
                                if let Some(raw_u) =
                                    w_obj.get("utilization").and_then(|v| v.as_f64())
                                {
                                    let used_pct = if raw_u <= 1.0 && raw_u > 0.0 {
                                        raw_u * 100.0
                                    } else {
                                        raw_u
                                    };
                                    let resets_at =
                                        w_obj.get("resets_at").and_then(parse_any_timestamp);
                                    let reset_in_seconds = resets_at
                                        .map(|r| (r - now).num_seconds())
                                        .filter(|&s| s > 0);
                                    wins.push(RateLimitWindowDto {
                                        id: id.to_string(),
                                        label: win_label.to_string(),
                                        used_percent: (used_pct * 10.0).round() / 10.0,
                                        remaining_percent: (((100.0 - used_pct).clamp(0.0, 100.0))
                                            * 10.0)
                                            .round()
                                            / 10.0,
                                        resets_at,
                                        reset_in_seconds,
                                        detail_text: None,
                                        status: status_for_used_pct(used_pct),
                                        source: "provider_api".to_string(),
                                    });
                                }
                            }
                        }
                        if !wins.is_empty() {
                            return ProviderQuotaCardDto {
                                provider: "claude".to_string(),
                                label: "Claude Code".to_string(),
                                plan_badge: format!("Claude {sub_type}"),
                                mode: "subscription".to_string(),
                                summary_text: None,
                                windows: wins,
                                updated_at: now,
                            };
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback to live cached `rate_limit_event` frames ONLY if Claude OAuth is signed in
    if has_claude_oauth {
        let cached_wins: Vec<RateLimitWindowDto> = cache
            .by_provider
            .get("claude")
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|w| refresh_window_countdown(w, now))
            .collect();
        if !cached_wins.is_empty() {
            return ProviderQuotaCardDto {
                provider: "claude".to_string(),
                label: "Claude Code".to_string(),
                plan_badge: "实时订阅配额".to_string(),
                mode: "subscription".to_string(),
                summary_text: None,
                windows: cached_wins,
                updated_at: now,
            };
        }
    }

    // 4. Unauthenticated — never show a fake bar
    ProviderQuotaCardDto {
        provider: "claude".to_string(),
        label: "Claude Code".to_string(),
        plan_badge: "未登录".to_string(),
        mode: "unauthenticated".to_string(),
        summary_text: Some("未登录 · 请运行 claude /login".to_string()),
        windows: Vec::new(),
        updated_at: now,
    }
}

#[derive(Debug, Default)]
struct CodexTomlConfig {
    base_url: Option<String>,
    requires_openai_auth: Option<bool>,
    experimental_bearer_token: Option<String>,
}

fn parse_codex_toml_config(raw_toml: &str) -> CodexTomlConfig {
    let mut active_provider_name = "openai".to_string();
    let mut top_openai_base_url: Option<String> = None;
    let mut current_section = String::new();

    #[derive(Default)]
    struct ProviderSection {
        base_url: Option<String>,
        requires_openai_auth: Option<bool>,
        experimental_bearer_token: Option<String>,
    }
    let mut provider_sections: HashMap<String, ProviderSection> = HashMap::new();

    for line in raw_toml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current_section = trimmed[1..trimmed.len() - 1].trim().to_string();
            continue;
        }
        let Some((raw_k, raw_v)) = trimmed.split_once('=') else {
            continue;
        };
        let key = raw_k.trim();
        let val_clean = raw_v
            .split('#')
            .next()
            .unwrap_or(raw_v)
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();

        if current_section.is_empty() {
            if key == "model_provider" && !val_clean.is_empty() {
                active_provider_name = val_clean.to_string();
            } else if key == "openai_base_url" && !val_clean.is_empty() {
                top_openai_base_url = Some(val_clean.to_string());
            }
        } else if let Some(prov_key) = current_section.strip_prefix("model_providers.") {
            let norm_prov = prov_key.trim().trim_matches('"').trim_matches('\'').to_lowercase();
            let entry = provider_sections.entry(norm_prov).or_default();
            match key {
                "base_url" if !val_clean.is_empty() => {
                    entry.base_url = Some(val_clean.to_string());
                }
                "requires_openai_auth" => {
                    if val_clean.eq_ignore_ascii_case("false") {
                        entry.requires_openai_auth = Some(false);
                    } else if val_clean.eq_ignore_ascii_case("true") {
                        entry.requires_openai_auth = Some(true);
                    }
                }
                "experimental_bearer_token" if !val_clean.is_empty() => {
                    entry.experimental_bearer_token = Some(val_clean.to_string());
                }
                _ => {}
            }
        }
    }

    let sec = provider_sections.remove(&active_provider_name.to_lowercase());
    CodexTomlConfig {
        base_url: sec.as_ref().and_then(|s| s.base_url.clone()).or(top_openai_base_url),
        requires_openai_auth: sec.as_ref().and_then(|s| s.requires_openai_auth),
        experimental_bearer_token: sec.and_then(|s| s.experimental_bearer_token),
    }
}

fn classify_codex_window_slot(w_obj: &Value, fallback_id: &str) -> (&'static str, &'static str) {
    if let Some(secs) = w_obj
        .get("limit_window_seconds")
        .or_else(|| w_obj.get("window_seconds"))
        .and_then(|v| v.as_i64())
    {
        if secs >= 86_400 * 3 {
            return ("7d", "7d 周配额");
        }
        return ("5h", "5h 窗口");
    }
    if let Some(mins) = w_obj.get("window_minutes").and_then(|v| v.as_i64()) {
        if mins >= 1440 * 3 {
            return ("7d", "7d 周配额");
        }
        return ("5h", "5h 窗口");
    }
    if fallback_id == "7d" {
        ("7d", "7d 周配额")
    } else {
        ("5h", "5h 窗口")
    }
}

fn probe_codex_card(
    home: &Path,
    cache: &PersistedQuotaCache,
    now: DateTime<Utc>,
) -> ProviderQuotaCardDto {
    let raw_toml = fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
    let cfg = parse_codex_toml_config(&raw_toml);

    let auth_val: Value = fs::read_to_string(home.join(".codex/auth.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let api_key = cfg
        .experimental_bearer_token
        .clone()
        .or_else(|| {
            auth_val
                .get("OPENAI_API_KEY")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let oauth_token = auth_val
        .pointer("/tokens/access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let chatgpt_account_id = auth_val
        .pointer("/tokens/account_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let is_custom_gateway = cfg
        .base_url
        .as_deref()
        .map(|u| {
            let host = extract_url_host(u);
            !host.is_empty()
                && !host.eq_ignore_ascii_case("api.openai.com")
                && !host.eq_ignore_ascii_case("chatgpt.com")
        })
        .unwrap_or(false);

    // 1. Custom Gateway (`base_url` points to non-OpenAI gateway, or `requires_openai_auth = false`)
    if is_custom_gateway || cfg.requires_openai_auth == Some(false) {
        if let (Some(base), Some(key)) = (cfg.base_url.as_deref(), api_key.as_deref()) {
            let trimmed_base = base.trim_end_matches('/');
            let usage_url = if trimmed_base.ends_with("/v1") {
                format!("{trimmed_base}/usage")
            } else {
                format!("{trimmed_base}/v1/usage")
            };
            if let Some(u_val) =
                curl_json_get(&usage_url, &[("Authorization", format!("Bearer {key}"))])
            {
                if let Some(sub_card) =
                    parse_gateway_subscription_windows("codex", "OpenAI Codex", &u_val, now)
                {
                    return sub_card;
                }
            }
            return build_custom_gateway_api_key_card("codex", "OpenAI Codex", base, now);
        }
        return build_custom_gateway_api_key_card(
            "codex",
            "OpenAI Codex",
            cfg.base_url.as_deref().unwrap_or(""),
            now,
        );
    }

    // 2. Official ChatGPT Plus / Pro / Team OAuth (`chatgpt.com/backend-api/wham/usage`)
    if let Some(tok) = oauth_token {
        let mut headers = vec![
            ("Authorization", format!("Bearer {tok}")),
            ("User-Agent", "codex-cli".to_string()),
        ];
        if let Some(acc_id) = chatgpt_account_id {
            headers.push(("ChatGPT-Account-Id", acc_id.to_string()));
        }
        if let Some(wham) = curl_json_get("https://chatgpt.com/backend-api/wham/usage", &headers) {
            let plan_type = wham
                .get("plan_type")
                .and_then(|v| v.as_str())
                .unwrap_or("ChatGPT");
            let mut wins = Vec::new();
            for (ptr, fallback_id) in [
                ("/rate_limit/primary_window", "5h"),
                ("/rate_limit/secondary_window", "7d"),
            ] {
                if let Some(w_obj) = wham.pointer(ptr) {
                    if let Some(used_pct) = w_obj.get("used_percent").and_then(|v| v.as_f64()) {
                        let (id, win_label) = classify_codex_window_slot(w_obj, fallback_id);
                        let resets_at = w_obj
                            .get("reset_at")
                            .or_else(|| w_obj.get("resets_at"))
                            .and_then(parse_any_timestamp);
                        let reset_in_seconds = resets_at
                            .map(|r| (r - now).num_seconds())
                            .filter(|&s| s > 0);
                        wins.retain(|x: &RateLimitWindowDto| x.id != id);
                        wins.push(RateLimitWindowDto {
                            id: id.to_string(),
                            label: win_label.to_string(),
                            used_percent: (used_pct * 10.0).round() / 10.0,
                            remaining_percent: (((100.0 - used_pct).clamp(0.0, 100.0)) * 10.0)
                                .round()
                                / 10.0,
                            resets_at,
                            reset_in_seconds,
                            detail_text: None,
                            status: status_for_used_pct(used_pct),
                            source: "provider_api".to_string(),
                        });
                    }
                }
            }
            wins.sort_by_key(|w| if w.id == "5h" { 0 } else { 1 });
            if !wins.is_empty() {
                return ProviderQuotaCardDto {
                    provider: "codex".to_string(),
                    label: "OpenAI Codex".to_string(),
                    plan_badge: format!("Codex ({plan_type})"),
                    mode: "subscription".to_string(),
                    summary_text: None,
                    windows: wins,
                    updated_at: now,
                };
            }
        }

        // Fallback to cached or recent session JSONL rate_limits ONLY when signed into official ChatGPT OAuth
        let mut cached_wins: Vec<RateLimitWindowDto> = cache
            .by_provider
            .get("codex")
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|w| refresh_window_countdown(w, now))
            .collect();
        if cached_wins.is_empty() {
            scan_tail_codex_rate_limits(&home.join(".codex/sessions"), &mut cached_wins, now);
        }
        if !cached_wins.is_empty() {
            return ProviderQuotaCardDto {
                provider: "codex".to_string(),
                label: "OpenAI Codex".to_string(),
                plan_badge: "Codex 订阅配额".to_string(),
                mode: "subscription".to_string(),
                summary_text: None,
                windows: cached_wins,
                updated_at: now,
            };
        }
    }

    // 3. Direct OpenAI Platform API Key (`sk-...` against `api.openai.com`, no ChatGPT OAuth)
    if api_key.is_some() {
        return ProviderQuotaCardDto {
            provider: "codex".to_string(),
            label: "OpenAI Codex".to_string(),
            plan_badge: "OpenAI API Key".to_string(),
            mode: "api_key".to_string(),
            summary_text: Some("OpenAI API Key 按量计费 · 无 5h/7d 订阅窗口".to_string()),
            windows: Vec::new(),
            updated_at: now,
        };
    }

    // 4. Unauthenticated
    ProviderQuotaCardDto {
        provider: "codex".to_string(),
        label: "OpenAI Codex".to_string(),
        plan_badge: "未登录".to_string(),
        mode: "unauthenticated".to_string(),
        summary_text: Some("未登录 · 请运行 codex login".to_string()),
        windows: Vec::new(),
        updated_at: now,
    }
}

fn scan_tail_codex_rate_limits(
    root: &Path,
    live_windows: &mut Vec<RateLimitWindowDto>,
    now: DateTime<Utc>,
) {
    let min_sys = SystemTime::now()
        .checked_sub(StdDuration::from_secs(7 * 86400))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    fn walk(dir: &Path, depth: usize, min_sys: SystemTime, out: &mut Vec<(SystemTime, PathBuf)>) {
        if depth > 4 || out.len() >= 30 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                walk(&p, depth + 1, min_sys, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                let mtime = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if mtime >= min_sys {
                    out.push((mtime, p));
                }
            }
        }
    }
    walk(root, 0, min_sys, &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, p) in files.into_iter().take(4) {
        let Ok(file) = fs::File::open(&p) else { continue };
        let lines: Vec<String> = BufReader::new(file).lines().flatten().collect();
        for line in lines.iter().rev().take(150) {
            if !line.contains("\"used_percent\"") {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(rl) = val.pointer("/payload/rate_limits") {
                for (slot, fallback_id) in [("primary", "5h"), ("secondary", "7d")] {
                    if let Some(w_obj) = rl.get(slot) {
                        if let Some(used_pct) = w_obj.get("used_percent").and_then(|v| v.as_f64()) {
                            let (id, label) = classify_codex_window_slot(w_obj, fallback_id);
                            let resets_at = w_obj
                                .get("resets_at")
                                .or_else(|| w_obj.get("reset_at"))
                                .and_then(parse_any_timestamp);
                            if let Some(dto) = refresh_window_countdown(
                                RateLimitWindowDto {
                                    id: id.to_string(),
                                    label: label.to_string(),
                                    used_percent: used_pct,
                                    remaining_percent: (100.0 - used_pct).clamp(0.0, 100.0),
                                    resets_at,
                                    reset_in_seconds: None,
                                    detail_text: None,
                                    status: status_for_used_pct(used_pct),
                                    source: "provider_header".to_string(),
                                },
                                now,
                            ) {
                                live_windows.retain(|x| x.id != id);
                                live_windows.push(dto);
                            }
                        }
                    }
                }
                if !live_windows.is_empty() {
                    live_windows.sort_by_key(|w| if w.id == "5h" { 0 } else { 1 });
                    return;
                }
            }
        }
    }
}

pub fn build_subscription_quotas_snapshot(
    cache: &PersistedQuotaCache,
    _sessions: &HashMap<uuid::Uuid, SessionInfo>,
    _event_history: &HashMap<uuid::Uuid, Vec<AgentEvent>>,
) -> Vec<ProviderQuotaCardDto> {
    build_subscription_quotas_snapshot_opts(cache, false)
}

pub fn build_subscription_quotas_snapshot_opts(
    cache: &PersistedQuotaCache,
    force_refresh: bool,
) -> Vec<ProviderQuotaCardDto> {
    let lock = LIVE_PROBE_CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh {
        if let Ok(guard) = lock.lock() {
            if let Some((ts, ref cached_cards)) = *guard {
                if ts.elapsed() < StdDuration::from_secs(30) {
                    return cached_cards.clone();
                }
            }
        }
    }

    let now = Utc::now();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));

    let cards = vec![
        probe_claude_card(&home, cache, now),
        probe_codex_card(&home, cache, now),
    ];

    if let Ok(mut guard) = lock.lock() {
        *guard = Some((Instant::now(), cards.clone()));
    }
    cards
}

pub fn parse_claude_rate_limit_json(val: &Value, now: DateTime<Utc>) -> Option<RateLimitWindowDto> {
    let info = val.get("rate_limit_info").unwrap_or(val);
    let raw_u = info.get("utilization").and_then(|v| v.as_f64())?;
    let used_pct = if raw_u <= 1.0 && raw_u > 0.0 {
        raw_u * 100.0
    } else {
        raw_u
    };
    let resets_at = info
        .get("resetsAt")
        .or_else(|| info.get("resets_at"))
        .and_then(parse_any_timestamp);
    let rtype = info
        .get("rateLimitType")
        .and_then(|v| v.as_str())
        .unwrap_or("5h");
    let (id, label) = if rtype.contains("7d") || rtype.contains("week") {
        ("7d", "7d 周配额")
    } else {
        ("5h", "5h 窗口")
    };
    refresh_window_countdown(
        RateLimitWindowDto {
            id: id.to_string(),
            label: label.to_string(),
            used_percent: used_pct,
            remaining_percent: (100.0 - used_pct).clamp(0.0, 100.0),
            resets_at,
            reset_in_seconds: None,
            detail_text: None,
            status: status_for_used_pct(used_pct),
            source: "provider_header".to_string(),
        },
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn test_parse_claude_rate_limit_and_gateway_modes() {
        let now = Utc::now();
        let future_ts = (now + Duration::hours(2)).timestamp();
        let raw = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "utilization": 0.42,
                "resetsAt": future_ts,
                "rateLimitType": "5h"
            }
        });
        let win = parse_claude_rate_limit_json(&raw, now).expect("should parse 5h rate limit");
        assert_eq!(win.id, "5h");
        assert!((win.used_percent - 42.0).abs() < 0.1);
        assert!((win.remaining_percent - 58.0).abs() < 0.1);

        // Unrestricted wallet payload MUST NOT produce fake subscription windows
        let wallet_raw = serde_json::json!({
            "mode": "unrestricted",
            "planName": "钱包余额",
            "balance": 980144.0,
            "usage": {
                "today": { "actual_cost": 4.5, "requests": 12 },
                "total": { "actual_cost": 25.0 }
            }
        });
        assert!(
            parse_gateway_subscription_windows("codex", "OpenAI Codex", &wallet_raw, now).is_none(),
            "unrestricted wallet key must not be treated as a 5h/7d subscription"
        );

        // Real 5h/7d gateway rate_limits MUST produce subscription windows
        let limited_raw = serde_json::json!({
            "mode": "quota_limited",
            "planName": "Pro 5h/7d",
            "rate_limits": [
                { "window": "5h", "limit": 20.0, "used": 5.0 },
                { "window": "7d", "limit": 100.0, "used": 40.0 }
            ]
        });
        let sub_card =
            parse_gateway_subscription_windows("codex", "OpenAI Codex", &limited_raw, now)
                .expect("rate_limits should produce subscription card");
        assert_eq!(sub_card.mode, "subscription");
        assert_eq!(sub_card.windows.len(), 2);
        assert!((sub_card.windows[0].remaining_percent - 75.0).abs() < 0.1);

        // Active TOML section parsing must respect model_provider
        let sample_toml = r#"
model_provider = "OpenAI"
[model_providers.Other]
base_url = "https://unused.example.com/v1"
[model_providers.OpenAI]
base_url = "https://api.daidaiyu.me/v1"
requires_openai_auth = false
"#;
        let parsed = parse_codex_toml_config(sample_toml);
        assert_eq!(
            parsed.base_url.as_deref(),
            Some("https://api.daidaiyu.me/v1")
        );
        assert_eq!(parsed.requires_openai_auth, Some(false));
    }
}
