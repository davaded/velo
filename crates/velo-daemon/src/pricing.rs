use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider, SessionInfo};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ModelRateCard {
    /// USD per 1,000,000 uncached input tokens
    pub input_per_m: f64,
    /// USD per 1,000,000 cached read input tokens
    pub cached_input_per_m: f64,
    /// USD per 1,000,000 cache creation tokens
    pub cache_write_per_m: f64,
    /// USD per 1,000,000 output (reasoning + text) tokens
    pub output_per_m: f64,
    /// Optional long-context threshold (e.g. 200_000 for Gemini Pro / Grok 4.6+, 100_000 for Haiku 5.5)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context_threshold: Option<u64>,
    /// Multiplier applied when `input_tokens > long_context_threshold` (typically 2.0)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context_multiplier: Option<f64>,
}

impl ModelRateCard {
    const fn flat(input: f64, cached: f64, write: f64, output: f64) -> Self {
        Self {
            input_per_m: input,
            cached_input_per_m: cached,
            cache_write_per_m: write,
            output_per_m: output,
            long_context_threshold: None,
            long_context_multiplier: None,
        }
    }

    const fn tiered(
        input: f64,
        cached: f64,
        write: f64,
        output: f64,
        threshold: u64,
        multiplier: f64,
    ) -> Self {
        Self {
            input_per_m: input,
            cached_input_per_m: cached,
            cache_write_per_m: write,
            output_per_m: output,
            long_context_threshold: Some(threshold),
            long_context_multiplier: Some(multiplier),
        }
    }
}

pub fn custom_pricing_file_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".velo").join("pricing.json"))
}

struct CachedOverrides {
    mtime: Option<SystemTime>,
    map: HashMap<String, ModelRateCard>,
}

static CUSTOM_OVERRIDES: std::sync::OnceLock<Mutex<CachedOverrides>> = std::sync::OnceLock::new();

fn load_custom_overrides() -> HashMap<String, ModelRateCard> {
    let Some(path) = custom_pricing_file_path() else {
        return HashMap::new();
    };
    let current_mtime = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());
    let lock = CUSTOM_OVERRIDES.get_or_init(|| {
        Mutex::new(CachedOverrides {
            mtime: None,
            map: HashMap::new(),
        })
    });
    let mut guard = lock.lock().unwrap();
    if guard.mtime == current_mtime {
        return guard.map.clone();
    }
    guard.mtime = current_mtime;
    guard.map.clear();
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<HashMap<String, ModelRateCard>>(&raw) {
            for (k, v) in parsed {
                guard.map.insert(k.trim().to_ascii_lowercase(), v);
            }
        }
    }
    guard.map.clone()
}

pub fn lookup_rate_card(provider: &AgentProvider, model: Option<&str>) -> ModelRateCard {
    let m = model.unwrap_or("").trim().to_ascii_lowercase();
    let clean = m.strip_prefix("cursor:").unwrap_or(&m);

    // 0. Check hot-reloaded user overrides in ~/.velo/pricing.json (exact or substring key)
    if !clean.is_empty() {
        let overrides = load_custom_overrides();
        if let Some(exact) = overrides.get(clean) {
            return *exact;
        }
        for (pattern, card) in &overrides {
            if !pattern.is_empty() && clean.contains(pattern.as_str()) {
                return *card;
            }
        }
    }

    // 1. Explicit calibrated 2026 model slug matching (handles Cursor-routed models accurately too)
    // Anthropic Claude 5.5 vs 4.x / Fable
    if clean.contains("opus") || clean.contains("fable") {
        if clean.contains("5-5") || clean.contains("5.5") {
            return ModelRateCard::flat(4.00, 0.20, 5.00, 20.00);
        }
        return ModelRateCard::flat(5.00, 0.50, 6.25, 25.00);
    }
    if clean.contains("haiku") {
        if clean.contains("5-5") || clean.contains("5.5") {
            return ModelRateCard::tiered(0.10, 0.01, 0.20, 0.50, 100_000, 5.0);
        }
        return ModelRateCard::flat(1.00, 0.10, 1.25, 5.00);
    }
    if clean.contains("sonnet") || clean.contains("claude") {
        if clean.contains("5-5") || clean.contains("5.5") {
            return ModelRateCard::flat(2.00, 0.10, 2.50, 10.00);
        }
        return ModelRateCard::flat(3.00, 0.30, 3.75, 15.00);
    }

    // Google Gemini 4 (Neon / Hydrogen) + 3.8 Flash + 3.1/2.5 Pro & Flash
    if clean.contains("gemini") || clean.contains("neon") || clean.contains("hydrogen") {
        if clean.contains("neon") {
            return ModelRateCard::tiered(3.00, 0.15, 0.0, 15.00, 200_000, 2.0);
        }
        if clean.contains("hydrogen") {
            return ModelRateCard::flat(1.50, 0.15, 0.0, 7.50);
        }
        if clean.contains("flash-lite") {
            return ModelRateCard::flat(0.10, 0.01, 0.0, 0.40);
        }
        if clean.contains("3.8-flash") || clean.contains("3-8-flash") {
            return ModelRateCard::flat(0.75, 0.075, 0.0, 3.75);
        }
        if clean.contains("flash") {
            return ModelRateCard::flat(0.30, 0.03, 0.0, 2.50);
        }
        return ModelRateCard::tiered(2.00, 0.20, 0.0, 12.00, 200_000, 2.0);
    }

    // OpenAI GPT-5/6 / Codex / o3 / o4
    if clean.contains("nano") {
        return ModelRateCard::flat(0.05, 0.005, 0.0, 0.40);
    }
    if clean.contains("o3-mini") || clean.contains("o4-mini") {
        return ModelRateCard::flat(1.10, 0.275, 0.0, 4.40);
    }
    if clean.contains("-mini") || clean.ends_with("mini") {
        return ModelRateCard::flat(0.25, 0.025, 0.0, 2.00);
    }
    if clean.contains("o3") || clean.contains("o4") {
        return ModelRateCard::flat(2.00, 0.50, 0.0, 8.00);
    }
    if clean.contains("gpt-") || clean.contains("codex") {
        return ModelRateCard::flat(1.25, 0.125, 0.0, 10.00);
    }
    if clean.contains("flash-lite") {
        return ModelRateCard::flat(0.10, 0.01, 0.0, 0.40);
    }
    if clean.contains("flash") {
        return ModelRateCard::flat(0.30, 0.03, 0.0, 2.50);
    }

    // xAI Grok 4.7 / 4.6 / 4.3 / Build / Fast
    if clean.contains("grok") {
        if clean.contains("fast") {
            return ModelRateCard::flat(0.20, 0.05, 0.0, 1.50);
        }
        if clean.contains("build") {
            return ModelRateCard::flat(1.00, 0.20, 0.0, 2.00);
        }
        if clean.contains("4.3") || clean.contains("4-3") {
            return ModelRateCard::flat(1.25, 0.20, 0.0, 2.50);
        }
        return ModelRateCard::tiered(2.00, 0.50, 0.0, 6.00, 200_000, 2.0);
    }

    // 2. Provider-level default rate card
    match provider {
        AgentProvider::Claude => ModelRateCard::flat(3.00, 0.30, 3.75, 15.00),
        AgentProvider::Codex => ModelRateCard::flat(1.25, 0.125, 0.0, 10.00),
        AgentProvider::Antigravity => ModelRateCard::tiered(3.00, 0.15, 0.0, 15.00, 200_000, 2.0),
        AgentProvider::Grok => ModelRateCard::tiered(2.00, 0.50, 0.0, 6.00, 200_000, 2.0),
        AgentProvider::Cursor | AgentProvider::Copilot => ModelRateCard::flat(2.00, 0.25, 0.0, 10.00),
        AgentProvider::Qwen => ModelRateCard::flat(0.80, 0.16, 0.0, 3.20),
        AgentProvider::OpenCode | AgentProvider::Acp(_) | AgentProvider::Custom(_) => {
            ModelRateCard::flat(1.50, 0.20, 0.0, 6.00)
        }
    }
}

pub fn compute_cost_usd(
    provider: &AgentProvider,
    model: Option<&str>,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
) -> f64 {
    let rate = lookup_rate_card(provider, model);
    let tier_mult = match (rate.long_context_threshold, rate.long_context_multiplier) {
        (Some(thresh), Some(mult)) if input_tokens > thresh && mult > 1.0 => mult,
        _ => 1.0,
    };
    let uncached_in = input_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let usd = (uncached_in as f64 * rate.input_per_m * tier_mult
        + cache_read_tokens as f64 * rate.cached_input_per_m * tier_mult
        + cache_write_tokens as f64 * rate.cache_write_per_m * tier_mult
        + output_tokens as f64 * rate.output_per_m * tier_mult)
        / 1_000_000.0;
    (usd * 1_000_000.0).round() / 1_000_000.0
}

/// Returns the transparent active pricing catalog for UI display & user override discovery.
pub fn pricing_catalog_json() -> Value {
    let overrides = load_custom_overrides();
    let path_str = custom_pricing_file_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.velo/pricing.json".to_string());
    let sample_models: &[(&str, AgentProvider, &str, &str)] = &[
        ("Claude Opus 5.5", AgentProvider::Claude, "claude-opus-5-5", "缓存读 5%"),
        ("Claude Opus 4.x / Fable", AgentProvider::Claude, "claude-fable-5-2", "缓存读 10%"),
        ("Claude Sonnet 5.5", AgentProvider::Claude, "claude-sonnet-5-5", "缓存读 5%"),
        ("Claude Sonnet 4.x", AgentProvider::Claude, "claude-sonnet-4-5", "缓存读 10%"),
        ("Claude Haiku 5.5", AgentProvider::Claude, "claude-haiku-5-5", ">100k 5×"),
        ("OpenAI GPT-5 / Codex", AgentProvider::Codex, "gpt-6.1-sol", "缓存读 10%"),
        ("OpenAI o3 / o4-mini", AgentProvider::Codex, "o4-mini", "缓存读 25%"),
        ("Gemini 4 Neon (Pro)", AgentProvider::Antigravity, "gemini-4-neon", ">200k 2×"),
        ("Gemini 4 Hydrogen", AgentProvider::Antigravity, "gemini-4-hydrogen", "标准价"),
        ("Gemini 3.8 Flash", AgentProvider::Antigravity, "gemini-3.8-flash", "标准价"),
        ("Gemini 2.5 Flash", AgentProvider::Antigravity, "gemini-2.5-flash", "标准价"),
        ("xAI Grok 4.6 / 4.7", AgentProvider::Grok, "grok-4.7", ">200k 2×"),
        ("xAI Grok 4.3", AgentProvider::Grok, "grok-4.3", "标准价"),
        ("xAI Grok Build", AgentProvider::Grok, "grok-build", "标准价"),
        ("xAI Grok Fast", AgentProvider::Grok, "grok-fast", "极速低价"),
    ];
    let cards: Vec<Value> = sample_models
        .iter()
        .map(|(label, prov, slug, note)| {
            let rc = lookup_rate_card(prov, Some(slug));
            json!({
                "label": label,
                "model": slug,
                "input_per_m": rc.input_per_m,
                "cached_input_per_m": rc.cached_input_per_m,
                "cache_write_per_m": rc.cache_write_per_m,
                "output_per_m": rc.output_per_m,
                "long_context_threshold": rc.long_context_threshold,
                "long_context_multiplier": rc.long_context_multiplier,
                "note": note,
            })
        })
        .collect();
    json!({
        "ok": true,
        "override_path": path_str,
        "override_count": overrides.len(),
        "cursor_note": "Cursor CLI 原生不回传 Prompt 输入 Token，其账单按输出 Token 与对应模型单价折算。",
        "rate_cards": cards,
    })
}

/// Authoritative per-turn cost: prefers exact provider-reported `cost_usd` when present and sane,
/// otherwise computes from the model rate card (automatically healing legacy inflated rows).
pub fn effective_turn_cost_usd(
    provider: &AgentProvider,
    model: Option<&str>,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    stored_cost_usd: f64,
) -> f64 {
    let computed = compute_cost_usd(
        provider,
        model,
        input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        output_tokens,
    );
    if stored_cost_usd <= 0.0 {
        return computed;
    }
    // If legacy Codex double-counting inflated `stored_cost_usd` far above what the recorded
    // tokens can actually cost at the model's rate card, use the token-accurate rate card cost.
    if computed > 0.0 && stored_cost_usd > computed * 1.65 {
        return computed;
    }
    stored_cost_usd
}

/// Reconciles `session.cost_usd` and `session.output_tokens` directly from its persisted
/// `UsageUpdated` turn history so session cards and analytics totals never drift apart.
pub fn reconcile_session_usage(session: &mut SessionInfo, history: &[AgentEvent]) -> bool {
    let enriched = crate::enrich_history_turn_metrics(history);
    let mut sum_out = 0u64;
    let mut sum_cost = 0.0f64;
    let mut last_in = 0u64;
    let mut last_cache = 0u64;
    let mut last_ctx = 0u64;
    let mut saw_usage = false;

    for ev in &enriched {
        if let AgentEvent::UsageUpdated {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            context_window,
            cost_usd,
            ..
        } = ev
        {
            saw_usage = true;
            sum_out = sum_out.saturating_add(*output_tokens);
            sum_cost += effective_turn_cost_usd(
                &session.provider,
                session.model.as_deref(),
                *input_tokens,
                *cache_read_tokens,
                *cache_write_tokens,
                *output_tokens,
                *cost_usd,
            );
            if *input_tokens > 0 {
                last_in = *input_tokens;
            }
            if *cache_read_tokens > 0 {
                last_cache = *cache_read_tokens;
            }
            if *context_window > 0 {
                last_ctx = *context_window;
            }
        }
    }

    if !saw_usage {
        return false;
    }

    let rounded_cost = (sum_cost * 1_000_000.0).round() / 1_000_000.0;
    let mut changed = false;
    if (session.cost_usd - rounded_cost).abs() > 1e-6 {
        session.cost_usd = rounded_cost;
        changed = true;
    }
    if session.output_tokens != sum_out {
        session.output_tokens = sum_out;
        changed = true;
    }
    if last_in > 0 && session.input_tokens != last_in {
        session.input_tokens = last_in;
        changed = true;
    }
    if last_cache > 0 && session.cache_read_tokens != last_cache {
        session.cache_read_tokens = last_cache;
        changed = true;
    }
    if last_ctx > 0 && session.context_window != last_ctx {
        session.context_window = last_ctx;
        changed = true;
    }
    changed
}

fn provider_key(p: &AgentProvider) -> &'static str {
    match p {
        AgentProvider::Claude => "claude",
        AgentProvider::Codex => "codex",
        AgentProvider::Antigravity => "agy",
        AgentProvider::Grok => "grok",
        AgentProvider::Cursor => "cursor",
        AgentProvider::Copilot => "copilot",
        AgentProvider::Qwen => "qwen",
        AgentProvider::OpenCode => "opencode",
        AgentProvider::Acp(_) => "acp",
        AgentProvider::Custom(_) => "custom",
    }
}

#[derive(Default, Clone, Serialize)]
pub struct BucketStats {
    pub key: String,
    pub label: String,
    pub sessions_count: usize,
    pub turns_count: usize,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub cache_hit_pct: f64,
    pub avg_tps: f64,
    pub cost_usd: f64,
}

pub fn build_usage_analytics(
    sessions: &HashMap<Uuid, SessionInfo>,
    histories: &HashMap<Uuid, Vec<AgentEvent>>,
) -> Value {
    let now = Utc::now();
    let mut total_in = 0u64;
    let mut total_cache = 0u64;
    let mut total_out = 0u64;
    let mut total_cost = 0.0f64;
    let mut today_cost = 0.0f64;
    let mut today_tokens = 0u64;
    let mut tps_weighted_sum = 0.0f64;
    let mut tps_weight_tok = 0u64;
    let mut total_turns = 0usize;

    let mut by_provider: HashMap<String, (BucketStats, f64, u64)> = HashMap::new();
    let mut by_workspace: HashMap<String, (BucketStats, f64, u64)> = HashMap::new();

    for s in sessions.values() {
        let p_key = provider_key(&s.provider).to_string();
        let ws_key = if s.repo_root.trim().is_empty() {
            "default".to_string()
        } else {
            s.repo_root.clone()
        };
        let ws_label = ws_key
            .rsplit('/')
            .find(|seg| !seg.is_empty())
            .unwrap_or(&ws_key)
            .to_string();

        by_provider
            .entry(p_key.clone())
            .or_insert_with(|| {
                (
                    BucketStats {
                        key: p_key.clone(),
                        label: p_key.to_uppercase(),
                        ..Default::default()
                    },
                    0.0,
                    0,
                )
            })
            .0
            .sessions_count += 1;

        by_workspace
            .entry(ws_key.clone())
            .or_insert_with(|| {
                (
                    BucketStats {
                        key: ws_key.clone(),
                        label: ws_label,
                        ..Default::default()
                    },
                    0.0,
                    0,
                )
            })
            .0
            .sessions_count += 1;

        if let Some(raw_evs) = histories.get(&s.id) {
            let enriched = crate::enrich_history_turn_metrics(raw_evs);
            let mut sess_had_usage = false;
            for ev in &enriched {
                if let AgentEvent::UsageUpdated {
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    cost_usd,
                    output_tps,
                    timestamp,
                    ..
                } = ev
                {
                    sess_had_usage = true;
                    total_turns += 1;
                    let eff_cost = effective_turn_cost_usd(
                        &s.provider,
                        s.model.as_deref(),
                        *input_tokens,
                        *cache_read_tokens,
                        *cache_write_tokens,
                        *output_tokens,
                        *cost_usd,
                    );

                    total_in += *input_tokens;
                    total_cache += *cache_read_tokens;
                    total_out += *output_tokens;
                    total_cost += eff_cost;

                    if timestamp.year() == now.year() && timestamp.ordinal() == now.ordinal() {
                        today_cost += eff_cost;
                        today_tokens += input_tokens.saturating_add(*output_tokens);
                    }

                    if *output_tps >= 0.5 && *output_tokens > 0 {
                        tps_weighted_sum += *output_tps * (*output_tokens as f64);
                        tps_weight_tok += *output_tokens;
                    }

                    if let Some((b, w_sum, w_tok)) = by_provider.get_mut(&p_key) {
                        b.turns_count += 1;
                        b.input_tokens += *input_tokens;
                        b.cache_read_tokens += *cache_read_tokens;
                        b.output_tokens += *output_tokens;
                        b.cost_usd += eff_cost;
                        if *output_tps >= 0.5 && *output_tokens > 0 {
                            *w_sum += *output_tps * (*output_tokens as f64);
                            *w_tok += *output_tokens;
                        }
                    }

                    if let Some((b, w_sum, w_tok)) = by_workspace.get_mut(&ws_key) {
                        b.turns_count += 1;
                        b.input_tokens += *input_tokens;
                        b.cache_read_tokens += *cache_read_tokens;
                        b.output_tokens += *output_tokens;
                        b.cost_usd += eff_cost;
                        if *output_tps >= 0.5 && *output_tokens > 0 {
                            *w_sum += *output_tps * (*output_tokens as f64);
                            *w_tok += *output_tokens;
                        }
                    }
                }
            }
            if !sess_had_usage && (s.input_tokens > 0 || s.output_tokens > 0 || s.cost_usd > 0.0) {
                let eff_cost = if s.cost_usd > 0.0 {
                    s.cost_usd
                } else {
                    compute_cost_usd(
                        &s.provider,
                        s.model.as_deref(),
                        s.input_tokens,
                        s.cache_read_tokens,
                        0,
                        s.output_tokens,
                    )
                };
                total_in += s.input_tokens;
                total_cache += s.cache_read_tokens;
                total_out += s.output_tokens;
                total_cost += eff_cost;
            }
        }
    }

    let finalize_buckets = |map: HashMap<String, (BucketStats, f64, u64)>| -> Vec<BucketStats> {
        let mut list: Vec<BucketStats> = map
            .into_values()
            .map(|(mut b, w_sum, w_tok)| {
                b.cache_hit_pct = if b.input_tokens > 0 {
                    ((b.cache_read_tokens as f64 / b.input_tokens as f64) * 1000.0)
                        .round()
                        .min(1000.0)
                        / 10.0
                } else {
                    0.0
                };
                b.avg_tps = if w_tok > 0 {
                    ((w_sum / w_tok as f64) * 10.0).round() / 10.0
                } else {
                    0.0
                };
                b.cost_usd = (b.cost_usd * 10_000.0).round() / 10_000.0;
                b
            })
            .collect();
        list.sort_by(|a, b| {
            b.cost_usd
                .partial_cmp(&a.cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.output_tokens.cmp(&a.output_tokens))
        });
        list
    };

    let cache_hit_pct = if total_in > 0 {
        ((total_cache as f64 / total_in as f64) * 1000.0)
            .round()
            .min(1000.0)
            / 10.0
    } else {
        0.0
    };
    let avg_tps = if tps_weight_tok > 0 {
        ((tps_weighted_sum / tps_weight_tok as f64) * 10.0).round() / 10.0
    } else {
        0.0
    };

    json!({
        "ok": true,
        "sessions_count": sessions.len(),
        "turns_count": total_turns,
        "input_tokens": total_in,
        "cache_read_tokens": total_cache,
        "output_tokens": total_out,
        "total_tokens": total_in.saturating_add(total_out),
        "cache_hit_pct": cache_hit_pct,
        "avg_tps": avg_tps,
        "total_cost_usd": (total_cost * 10_000.0).round() / 10_000.0,
        "today_cost_usd": (today_cost * 10_000.0).round() / 10_000.0,
        "today_tokens": today_tokens,
        "by_provider": finalize_buckets(by_provider),
        "by_workspace": finalize_buckets(by_workspace),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_card_matching_avoids_gemini_mini_collision() {
        let gem = lookup_rate_card(&AgentProvider::Antigravity, Some("gemini-4-neon"));
        assert_eq!(gem.input_per_m, 3.0);
        assert_eq!(gem.cached_input_per_m, 0.15);
        assert_eq!(gem.output_per_m, 15.0);

        let cur_gem = lookup_rate_card(&AgentProvider::Cursor, Some("cursor:gemini-4-neon"));
        assert_eq!(cur_gem.output_per_m, 15.0);

        let hydro = lookup_rate_card(&AgentProvider::Antigravity, Some("gemini-4-hydrogen"));
        assert_eq!(hydro.input_per_m, 1.5);
        assert_eq!(hydro.output_per_m, 7.5);

        let grok47 = lookup_rate_card(&AgentProvider::Grok, Some("grok-4.7"));
        assert_eq!(grok47.input_per_m, 2.0);
        assert_eq!(grok47.output_per_m, 6.0);
        // Long context (>200k) doubles Grok 4.7 pricing
        let grok_long = compute_cost_usd(&AgentProvider::Grok, Some("grok-4.7"), 250_000, 0, 0, 10_000);
        let grok_std = compute_cost_usd(&AgentProvider::Grok, Some("grok-4.7"), 100_000, 0, 0, 10_000);
        assert!(grok_long > grok_std * 3.0);

        let opus55 = lookup_rate_card(&AgentProvider::Claude, Some("claude-opus-5-5"));
        assert_eq!(opus55.input_per_m, 4.0);
        assert_eq!(opus55.cached_input_per_m, 0.20);
        assert_eq!(opus55.output_per_m, 20.0);

        let flash = lookup_rate_card(&AgentProvider::Antigravity, Some("gemini-2.5-flash"));
        assert_eq!(flash.output_per_m, 2.5);

        let gpt_mini = lookup_rate_card(&AgentProvider::Codex, Some("gpt-5-mini"));
        assert_eq!(gpt_mini.output_per_m, 2.0);

        let codex = lookup_rate_card(&AgentProvider::Codex, Some("gpt-6.1-sol"));
        assert_eq!(codex.input_per_m, 1.25);
        assert_eq!(codex.cached_input_per_m, 0.125);
        assert_eq!(codex.output_per_m, 10.0);

        // Legacy inflated Codex turn ($2.71 for 127k cached + 25.8k out) heals to ~$0.275
        let healed = effective_turn_cost_usd(
            &AgentProvider::Codex,
            Some("gpt-6.1-sol"),
            127_139,
            126_976,
            0,
            25_866,
            2.7140,
        );
        assert!(healed > 0.25 && healed < 0.30, "unexpected healed cost: {healed}");
    }
}
