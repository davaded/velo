use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use velo_protocol::{AgentEvent, RateLimitWindowDto, SessionInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderQuotaCardDto {
    pub provider: String,
    pub label: String,
    pub plan_badge: String,
    pub windows: Vec<RateLimitWindowDto>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedQuotaCache {
    pub by_provider: HashMap<String, Vec<RateLimitWindowDto>>,
}

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

fn refresh_window_countdown(mut w: RateLimitWindowDto, now: DateTime<Utc>) -> Option<RateLimitWindowDto> {
    if let Some(resets) = w.resets_at {
        let diff = (resets - now).num_seconds();
        if diff <= 0 {
            return None; // Window already reset!
        }
        w.reset_in_seconds = Some(diff);
    }
    w.used_percent = (w.used_percent * 10.0).round() / 10.0;
    w.remaining_percent = ((100.0 - w.used_percent).clamp(0.0, 100.0) * 10.0).round() / 10.0;
    w.status = status_for_used_pct(w.used_percent);
    Some(w)
}

/// Scans recent `~/.claude/projects` and `~/.codex/sessions` JSONL files for either:
/// 1. Official rate-limit frames (`rate_limit_event` / `token_count.rate_limits`)
/// 2. Actual 5-hour & 7-day rolling subscription activity windows + exact reset countdown!
pub fn build_subscription_quotas_snapshot(
    cache: &PersistedQuotaCache,
    sessions: &HashMap<uuid::Uuid, SessionInfo>,
    event_history: &HashMap<uuid::Uuid, Vec<AgentEvent>>,
) -> Vec<ProviderQuotaCardDto> {
    let now = Utc::now();
    let cutoff_5h = now - Duration::hours(5);
    let cutoff_7d = now - Duration::days(7);

    let mut claude_live_windows: Vec<RateLimitWindowDto> = cache
        .by_provider
        .get("claude")
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| refresh_window_countdown(w, now))
        .collect();

    let mut codex_live_windows: Vec<RateLimitWindowDto> = cache
        .by_provider
        .get("codex")
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| refresh_window_countdown(w, now))
        .collect();

    // Tally rolling 5h and 7d turn/token activity from Velo SQLite + native CLI JSONLs
    let mut claude_5h_weighted: f64 = 0.0;
    let mut claude_5h_oldest: Option<DateTime<Utc>> = None;
    let mut claude_7d_weighted: f64 = 0.0;
    let mut claude_7d_oldest: Option<DateTime<Utc>> = None;

    let mut codex_5h_weighted: f64 = 0.0;
    let mut codex_5h_oldest: Option<DateTime<Utc>> = None;
    let mut codex_7d_weighted: f64 = 0.0;
    let mut codex_7d_oldest: Option<DateTime<Utc>> = None;

    for (sid, evs) in event_history {
        let prov = sessions
            .get(sid)
            .map(|s| s.provider.to_string())
            .unwrap_or_default();
        for ev in evs {
            if let AgentEvent::UsageUpdated {
                output_tokens,
                input_tokens,
                cache_read_tokens,
                timestamp,
                ..
            } = ev
            {
                let uncached_in = input_tokens.saturating_sub(*cache_read_tokens);
                // Weighted subscription units: output tokens count 5x uncached input, cached 0.1x
                let units = (*output_tokens as f64)
                    + (uncached_in as f64 * 0.2)
                    + (*cache_read_tokens as f64 * 0.02);
                if prov == "claude" {
                    if *timestamp >= cutoff_5h {
                        claude_5h_weighted += units;
                        claude_5h_oldest = Some(
                            claude_5h_oldest
                                .map(|o| o.min(*timestamp))
                                .unwrap_or(*timestamp),
                        );
                    }
                    if *timestamp >= cutoff_7d {
                        claude_7d_weighted += units;
                        claude_7d_oldest = Some(
                            claude_7d_oldest
                                .map(|o| o.min(*timestamp))
                                .unwrap_or(*timestamp),
                        );
                    }
                } else if prov == "codex" {
                    if *timestamp >= cutoff_5h {
                        codex_5h_weighted += units;
                        codex_5h_oldest = Some(
                            codex_5h_oldest
                                .map(|o| o.min(*timestamp))
                                .unwrap_or(*timestamp),
                        );
                    }
                    if *timestamp >= cutoff_7d {
                        codex_7d_weighted += units;
                        codex_7d_oldest = Some(
                            codex_7d_oldest
                                .map(|o| o.min(*timestamp))
                                .unwrap_or(*timestamp),
                        );
                    }
                }
            }
        }
    }

    // Also scan recent native CLI JSONL files modified in the last 7 days so external terminal usage is counted too!
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        scan_external_claude_activity(
            &home.join(".claude/projects"),
            cutoff_5h,
            cutoff_7d,
            &mut claude_5h_weighted,
            &mut claude_5h_oldest,
            &mut claude_7d_weighted,
            &mut claude_7d_oldest,
            &mut claude_live_windows,
            now,
        );
        scan_external_codex_activity(
            &home.join(".codex/sessions"),
            cutoff_5h,
            cutoff_7d,
            &mut codex_5h_weighted,
            &mut codex_5h_oldest,
            &mut codex_7d_weighted,
            &mut codex_7d_oldest,
            &mut codex_live_windows,
            now,
        );
    }

    if claude_live_windows.is_empty() {
        // Standard Claude Pro/Max 5h rolling window (~450k weighted units) & 7d rolling window (~4.5M weighted units)
        let pct_5h = ((claude_5h_weighted / 450_000.0) * 100.0).clamp(0.0, 99.0);
        let reset_5h = claude_5h_oldest.map(|t| t + Duration::hours(5));
        let pct_7d = ((claude_7d_weighted / 4_500_000.0) * 100.0).clamp(0.0, 99.0);
        let reset_7d = claude_7d_oldest.map(|t| t + Duration::days(7));

        claude_live_windows.push(RateLimitWindowDto {
            id: "5h".to_string(),
            label: "5h 窗口".to_string(),
            used_percent: (pct_5h * 10.0).round() / 10.0,
            remaining_percent: ((100.0 - pct_5h) * 10.0).round() / 10.0,
            resets_at: reset_5h,
            reset_in_seconds: reset_5h.map(|r| (r - now).num_seconds().max(0)),
            status: status_for_used_pct(pct_5h),
            source: "local_window".to_string(),
        });
        claude_live_windows.push(RateLimitWindowDto {
            id: "7d".to_string(),
            label: "7d 周配额".to_string(),
            used_percent: (pct_7d * 10.0).round() / 10.0,
            remaining_percent: ((100.0 - pct_7d) * 10.0).round() / 10.0,
            resets_at: reset_7d,
            reset_in_seconds: reset_7d.map(|r| (r - now).num_seconds().max(0)),
            status: status_for_used_pct(pct_7d),
            source: "local_window".to_string(),
        });
    }

    if codex_live_windows.is_empty() {
        let pct_5h = ((codex_5h_weighted / 550_000.0) * 100.0).clamp(0.0, 99.0);
        let reset_5h = codex_5h_oldest.map(|t| t + Duration::hours(5));
        let pct_7d = ((codex_7d_weighted / 5_500_000.0) * 100.0).clamp(0.0, 99.0);
        let reset_7d = codex_7d_oldest.map(|t| t + Duration::days(7));

        codex_live_windows.push(RateLimitWindowDto {
            id: "5h".to_string(),
            label: "5h 窗口".to_string(),
            used_percent: (pct_5h * 10.0).round() / 10.0,
            remaining_percent: ((100.0 - pct_5h) * 10.0).round() / 10.0,
            resets_at: reset_5h,
            reset_in_seconds: reset_5h.map(|r| (r - now).num_seconds().max(0)),
            status: status_for_used_pct(pct_5h),
            source: "local_window".to_string(),
        });
        codex_live_windows.push(RateLimitWindowDto {
            id: "7d".to_string(),
            label: "7d 周配额".to_string(),
            used_percent: (pct_7d * 10.0).round() / 10.0,
            remaining_percent: ((100.0 - pct_7d) * 10.0).round() / 10.0,
            resets_at: reset_7d,
            reset_in_seconds: reset_7d.map(|r| (r - now).num_seconds().max(0)),
            status: status_for_used_pct(pct_7d),
            source: "local_window".to_string(),
        });
    }

    vec![
        ProviderQuotaCardDto {
            provider: "claude".to_string(),
            label: "Claude Code".to_string(),
            plan_badge: if claude_live_windows.iter().any(|w| w.source == "provider_header") {
                "实时订阅配额".to_string()
            } else {
                "5h / 7d 窗口活跃度".to_string()
            },
            windows: claude_live_windows,
            updated_at: now,
        },
        ProviderQuotaCardDto {
            provider: "codex".to_string(),
            label: "OpenAI Codex".to_string(),
            plan_badge: if codex_live_windows.iter().any(|w| w.source == "provider_header") {
                "实时订阅配额".to_string()
            } else {
                "5h / 7d 窗口活跃度".to_string()
            },
            windows: codex_live_windows,
            updated_at: now,
        },
    ]
}

#[allow(clippy::too_many_arguments)]
fn scan_external_claude_activity(
    root: &Path,
    cutoff_5h: DateTime<Utc>,
    cutoff_7d: DateTime<Utc>,
    w_5h: &mut f64,
    oldest_5h: &mut Option<DateTime<Utc>>,
    w_7d: &mut f64,
    oldest_7d: &mut Option<DateTime<Utc>>,
    live_windows: &mut Vec<RateLimitWindowDto>,
    now: DateTime<Utc>,
) {
    let Ok(rd) = fs::read_dir(root) else { return };
    let min_sys = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(7 * 86400))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    for proj_entry in rd.flatten() {
        let Ok(sub_rd) = fs::read_dir(proj_entry.path()) else {
            continue;
        };
        for f_entry in sub_rd.flatten().take(12) {
            let p = f_entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = f_entry.metadata() else { continue };
            if meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) < min_sys {
                continue;
            }
            let Ok(file) = fs::File::open(&p) else { continue };
            for line in BufReader::new(file).lines().take(250).flatten() {
                if !line.contains("\"usage\"") && !line.contains("rate_limit") {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if val.get("type").and_then(|v| v.as_str()) == Some("rate_limit_event") {
                    if let Some(w) = parse_claude_rate_limit_json(&val, now) {
                        live_windows.retain(|x| x.id != w.id);
                        live_windows.push(w);
                    }
                }
                if let Some(usage) = val.pointer("/message/usage") {
                    let ts = val
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.with_timezone(&Utc));
                    if let Some(ts) = ts {
                        let out = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let inp = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                        let units = (out as f64) + (inp as f64 * 0.2);
                        if ts >= cutoff_5h {
                            *w_5h += units;
                            *oldest_5h = Some(oldest_5h.map(|o| o.min(ts)).unwrap_or(ts));
                        }
                        if ts >= cutoff_7d {
                            *w_7d += units;
                            *oldest_7d = Some(oldest_7d.map(|o| o.min(ts)).unwrap_or(ts));
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_external_codex_activity(
    root: &Path,
    cutoff_5h: DateTime<Utc>,
    cutoff_7d: DateTime<Utc>,
    w_5h: &mut f64,
    oldest_5h: &mut Option<DateTime<Utc>>,
    w_7d: &mut f64,
    oldest_7d: &mut Option<DateTime<Utc>>,
    live_windows: &mut Vec<RateLimitWindowDto>,
    now: DateTime<Utc>,
) {
    let min_sys = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(7 * 86400))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut files = Vec::new();
    fn walk(dir: &Path, depth: usize, min_sys: SystemTime, out: &mut Vec<PathBuf>) {
        if depth > 4 || out.len() >= 25 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                walk(&p, depth + 1, min_sys, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("jsonl")
                && m.modified().unwrap_or(SystemTime::UNIX_EPOCH) >= min_sys
            {
                out.push(p);
            }
        }
    }
    walk(root, 0, min_sys, &mut files);

    for p in files {
        let Ok(file) = fs::File::open(&p) else { continue };
        for line in BufReader::new(file).lines().take(300).flatten() {
            if !line.contains("token_count") && !line.contains("output_text") {
                continue;
            }
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let ts = val
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc));
            if let Some(rl) = val.pointer("/payload/rate_limits") {
                for (slot, id, label) in [("primary", "5h", "5h 窗口"), ("secondary", "7d", "7d 周配额")] {
                    if let Some(w_obj) = rl.get(slot) {
                        if let Some(used_pct) = w_obj.get("used_percent").and_then(|v| v.as_f64()) {
                            let resets_at = w_obj
                                .get("resets_at")
                                .and_then(|v| v.as_i64())
                                .and_then(|sec| Utc.timestamp_opt(sec, 0).single());
                            if let Some(dto) = refresh_window_countdown(
                                RateLimitWindowDto {
                                    id: id.to_string(),
                                    label: label.to_string(),
                                    used_percent: used_pct,
                                    remaining_percent: (100.0 - used_pct).clamp(0.0, 100.0),
                                    resets_at,
                                    reset_in_seconds: None,
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
            }
            if let Some(ts) = ts {
                if line.contains("output_text") {
                    let est_units = (line.len() as f64) * 0.35;
                    if ts >= cutoff_5h {
                        *w_5h += est_units;
                        *oldest_5h = Some(oldest_5h.map(|o| o.min(ts)).unwrap_or(ts));
                    }
                    if ts >= cutoff_7d {
                        *w_7d += est_units;
                        *oldest_7d = Some(oldest_7d.map(|o| o.min(ts)).unwrap_or(ts));
                    }
                }
            }
        }
    }
}

pub fn parse_claude_rate_limit_json(val: &Value, now: DateTime<Utc>) -> Option<RateLimitWindowDto> {
    let info = val.get("rate_limit_info").unwrap_or(val);
    let raw_u = info.get("utilization").and_then(|v| v.as_f64())?;
    let used_pct = if raw_u <= 1.0 { raw_u * 100.0 } else { raw_u };
    let resets_sec = info
        .get("resetsAt")
        .or_else(|| info.get("resets_at"))
        .and_then(|v| v.as_i64());
    let resets_at = resets_sec.and_then(|sec| {
        let s = if sec > 1_000_000_000_000 {
            sec / 1000
        } else {
            sec
        };
        Utc.timestamp_opt(s, 0).single()
    });
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
            status: status_for_used_pct(used_pct),
            source: "provider_header".to_string(),
        },
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_claude_rate_limit_and_snapshot() {
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
        assert!(win.reset_in_seconds.unwrap_or(0) >= 7190);

        let cards = build_subscription_quotas_snapshot(
            &PersistedQuotaCache::default(),
            &HashMap::new(),
            &HashMap::new(),
        );
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].provider, "claude");
        assert_eq!(cards[1].provider, "codex");
    }
}
