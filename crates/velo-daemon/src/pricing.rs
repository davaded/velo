use chrono::{Datelike, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
use velo_protocol::{AgentEvent, AgentProvider, SessionInfo};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ModelRateCard {
    /// USD per 1,000,000 uncached input tokens
    pub input_per_m: f64,
    /// USD per 1,000,000 cached read input tokens
    pub cached_input_per_m: f64,
    /// USD per 1,000,000 cache creation tokens
    pub cache_write_per_m: f64,
    /// USD per 1,000,000 output (reasoning + text) tokens
    pub output_per_m: f64,
}

pub fn lookup_rate_card(provider: &AgentProvider, model: Option<&str>) -> ModelRateCard {
    let m = model.unwrap_or("").trim().to_ascii_lowercase();
    let clean = m.strip_prefix("cursor:").unwrap_or(&m);

    // 1. Explicit model slug matching first (handles Cursor-routed models accurately too)
    if clean.contains("fable") || clean.contains("opus") {
        return ModelRateCard {
            input_per_m: 5.00,
            cached_input_per_m: 0.50,
            cache_write_per_m: 6.25,
            output_per_m: 25.00,
        };
    }
    if clean.contains("haiku") {
        return ModelRateCard {
            input_per_m: 1.00,
            cached_input_per_m: 0.10,
            cache_write_per_m: 1.25,
            output_per_m: 5.00,
        };
    }
    if clean.contains("sonnet") || clean.contains("claude") {
        return ModelRateCard {
            input_per_m: 3.00,
            cached_input_per_m: 0.30,
            cache_write_per_m: 3.75,
            output_per_m: 15.00,
        };
    }
    if clean.contains("gemini") {
        if clean.contains("flash-lite") {
            return ModelRateCard {
                input_per_m: 0.10,
                cached_input_per_m: 0.01,
                cache_write_per_m: 0.0,
                output_per_m: 0.40,
            };
        }
        if clean.contains("flash") {
            return ModelRateCard {
                input_per_m: 0.30,
                cached_input_per_m: 0.03,
                cache_write_per_m: 0.0,
                output_per_m: 2.50,
            };
        }
        return ModelRateCard {
            input_per_m: 1.25,
            cached_input_per_m: 0.125,
            cache_write_per_m: 0.0,
            output_per_m: 10.00,
        };
    }
    if clean.contains("nano") {
        return ModelRateCard {
            input_per_m: 0.05,
            cached_input_per_m: 0.005,
            cache_write_per_m: 0.0,
            output_per_m: 0.40,
        };
    }
    if clean.contains("o3-mini") || clean.contains("o4-mini") {
        return ModelRateCard {
            input_per_m: 1.10,
            cached_input_per_m: 0.275,
            cache_write_per_m: 0.0,
            output_per_m: 4.40,
        };
    }
    if clean.contains("-mini") || clean.ends_with("mini") {
        return ModelRateCard {
            input_per_m: 0.25,
            cached_input_per_m: 0.025,
            cache_write_per_m: 0.0,
            output_per_m: 2.00,
        };
    }
    if clean.contains("o3") || clean.contains("o4") {
        return ModelRateCard {
            input_per_m: 2.00,
            cached_input_per_m: 0.50,
            cache_write_per_m: 0.0,
            output_per_m: 8.00,
        };
    }
    if clean.contains("gpt-") || clean.contains("codex") {
        return ModelRateCard {
            input_per_m: 1.25,
            cached_input_per_m: 0.125,
            cache_write_per_m: 0.0,
            output_per_m: 10.00,
        };
    }
    if clean.contains("flash-lite") {
        return ModelRateCard {
            input_per_m: 0.10,
            cached_input_per_m: 0.01,
            cache_write_per_m: 0.0,
            output_per_m: 0.40,
        };
    }
    if clean.contains("flash") {
        return ModelRateCard {
            input_per_m: 0.30,
            cached_input_per_m: 0.03,
            cache_write_per_m: 0.0,
            output_per_m: 2.50,
        };
    }
    if clean.contains("grok") && clean.contains("fast") {
        return ModelRateCard {
            input_per_m: 0.20,
            cached_input_per_m: 0.05,
            cache_write_per_m: 0.0,
            output_per_m: 1.50,
        };
    }
    if clean.contains("grok") {
        return ModelRateCard {
            input_per_m: 3.00,
            cached_input_per_m: 0.75,
            cache_write_per_m: 0.0,
            output_per_m: 15.00,
        };
    }

    // 2. Provider-level default rate card
    match provider {
        AgentProvider::Claude => ModelRateCard {
            input_per_m: 3.00,
            cached_input_per_m: 0.30,
            cache_write_per_m: 3.75,
            output_per_m: 15.00,
        },
        AgentProvider::Codex => ModelRateCard {
            input_per_m: 1.25,
            cached_input_per_m: 0.125,
            cache_write_per_m: 0.0,
            output_per_m: 10.00,
        },
        AgentProvider::Antigravity => ModelRateCard {
            input_per_m: 1.25,
            cached_input_per_m: 0.125,
            cache_write_per_m: 0.0,
            output_per_m: 10.00,
        },
        AgentProvider::Grok => ModelRateCard {
            input_per_m: 3.00,
            cached_input_per_m: 0.75,
            cache_write_per_m: 0.0,
            output_per_m: 15.00,
        },
        AgentProvider::Cursor | AgentProvider::Copilot => ModelRateCard {
            input_per_m: 2.00,
            cached_input_per_m: 0.25,
            cache_write_per_m: 0.0,
            output_per_m: 10.00,
        },
        AgentProvider::Qwen => ModelRateCard {
            input_per_m: 0.80,
            cached_input_per_m: 0.16,
            cache_write_per_m: 0.0,
            output_per_m: 3.20,
        },
        AgentProvider::OpenCode | AgentProvider::Acp(_) | AgentProvider::Custom(_) => {
            ModelRateCard {
                input_per_m: 1.50,
                cached_input_per_m: 0.20,
                cache_write_per_m: 0.0,
                output_per_m: 6.00,
            }
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
    let uncached_in = input_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let usd = (uncached_in as f64 * rate.input_per_m
        + cache_read_tokens as f64 * rate.cached_input_per_m
        + cache_write_tokens as f64 * rate.cache_write_per_m
        + output_tokens as f64 * rate.output_per_m)
        / 1_000_000.0;
    (usd * 1_000_000.0).round() / 1_000_000.0
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
        assert_eq!(gem.input_per_m, 1.25);
        assert_eq!(gem.cached_input_per_m, 0.125);
        assert_eq!(gem.output_per_m, 10.0);

        let cur_gem = lookup_rate_card(&AgentProvider::Cursor, Some("cursor:gemini-4-neon"));
        assert_eq!(cur_gem.output_per_m, 10.0);

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
