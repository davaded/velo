use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;
use velo_protocol::AgentProvider;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRule {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    /// `"cron"` | `"once"` | `"github_webhook"` | `"generic_webhook"`
    pub trigger_type: String,
    #[serde(default)]
    pub cron_expr: Option<String>,
    /// Human-readable schedule summary in local time (e.g. `"每天 09:00"`, `"每个工作日 18:30"`, `"今天 23:00 · 单次"`).
    #[serde(default)]
    pub schedule_text: Option<String>,
    /// Exact trigger timestamp (UTC) for one-shot `"once"` scheduled tasks.
    #[serde(default)]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default)]
    pub github_events: Vec<String>,
    pub repo_path: String,
    #[serde(default = "default_branch_prefix")]
    pub branch_prefix: String,
    pub provider: AgentProvider,
    #[serde(default)]
    pub model: Option<String>,
    pub prompt_template: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_session_id: Option<Uuid>,
    #[serde(default)]
    pub run_count: u64,
}

fn default_branch_prefix() -> String {
    "auto/hub".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateAutomationRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_trigger_type")]
    pub trigger_type: String,
    pub cron_expr: Option<String>,
    #[serde(default)]
    pub schedule_text: Option<String>,
    #[serde(default)]
    pub run_at: Option<DateTime<Utc>>,
    /// Optional raw natural-language sentence (e.g. `"每天早上9点跑单测"`); if provided and
    /// `cron_expr`/`run_at` are empty, daemon automatically parses it in local timezone.
    #[serde(default)]
    pub natural_input: Option<String>,
    pub webhook_secret: Option<String>,
    #[serde(default)]
    pub github_events: Vec<String>,
    pub repo_path: String,
    pub branch_prefix: Option<String>,
    pub provider: AgentProvider,
    pub model: Option<String>,
    #[serde(default)]
    pub prompt_template: String,
}

fn default_true() -> bool {
    true
}

fn default_trigger_type() -> String {
    "cron".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAutomationRequest {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub cron_expr: Option<String>,
    pub schedule_text: Option<String>,
    pub run_at: Option<DateTime<Utc>>,
    pub prompt_template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedScheduleResult {
    pub ok: bool,
    /// `"cron"` | `"once"`
    pub trigger_type: String,
    pub cron_expr: Option<String>,
    pub run_at: Option<DateTime<Utc>>,
    /// Crisp human-readable Chinese label in local timezone (e.g. `"每天 09:00"`, `"今天 23:00 · 单次"`).
    pub schedule_text: String,
    pub next_run_label: Option<String>,
    pub task_prompt: String,
    pub suggested_name: String,
    pub hint: Option<String>,
}

/// Evaluates a standard 5-field cron expression (`min hour dom month dow`) against any chrono `DateTime`.
pub fn matches_cron_minute<Tz: TimeZone>(expr: &str, dt: &DateTime<Tz>) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let min = dt.minute();
    let hour = dt.hour();
    let dom = dt.day();
    let month = dt.month();
    let dow = dt.weekday().num_days_from_sunday(); // 0 = Sun .. 6 = Sat

    match_field(fields[0], min, 0, 59)
        && match_field(fields[1], hour, 0, 23)
        && match_field(fields[2], dom, 1, 31)
        && match_field(fields[3], month, 1, 12)
        && (match_field(fields[4], dow, 0, 7) || (dow == 0 && match_field(fields[4], 7, 0, 7)))
}

fn match_field(spec: &str, val: u32, min: u32, max: u32) -> bool {
    for part in spec.split(',') {
        let part = part.trim();
        if part == "*" {
            return true;
        }
        if let Some(step_str) = part.strip_prefix("*/") {
            if let Ok(step) = step_str.parse::<u32>() {
                if step > 0 && (val.saturating_sub(min)) % step == 0 {
                    return true;
                }
            }
            continue;
        }
        if let Some((start_s, end_s)) = part.split_once('-') {
            if let (Ok(s), Ok(e)) = (start_s.parse::<u32>(), end_s.parse::<u32>()) {
                if val >= s.max(min) && val <= e.min(max) {
                    return true;
                }
            }
            continue;
        }
        if let Ok(exact) = part.parse::<u32>() {
            if exact == val {
                return true;
            }
        }
    }
    false
}

/// Converts a standard 5-field local-time cron expression into human-readable Chinese.
pub fn describe_cron_human(expr: &str) -> String {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return expr.to_string();
    }
    let (min_f, hour_f, dom_f, month_f, dow_f) =
        (fields[0], fields[1], fields[2], fields[3], fields[4]);

    if let Some(step) = min_f.strip_prefix("*/") {
        if hour_f == "*" && dom_f == "*" && month_f == "*" && dow_f == "*" {
            return format!("每 {} 分钟", step);
        }
    }
    if min_f == "0" && dom_f == "*" && month_f == "*" && dow_f == "*" {
        if hour_f == "*" {
            return "每小时整点".to_string();
        }
        if let Some(step) = hour_f.strip_prefix("*/") {
            return format!("每 {} 小时", step);
        }
    }

    if let (Ok(m), Ok(h)) = (min_f.parse::<u32>(), hour_f.parse::<u32>()) {
        let hhmm = format!("{:02}:{:02}", h, m);
        if dom_f == "*" && month_f == "*" {
            return match dow_f {
                "*" => format!("每天 {}", hhmm),
                "1-5" => format!("每个工作日 {}", hhmm),
                "0,6" | "6,0" | "6-7" => format!("每周末 {}", hhmm),
                _ => {
                    let names: Vec<&str> = dow_f
                        .split(',')
                        .filter_map(|d| match d.trim() {
                            "0" | "7" => Some("周日"),
                            "1" => Some("周一"),
                            "2" => Some("周二"),
                            "3" => Some("周三"),
                            "4" => Some("周四"),
                            "5" => Some("周五"),
                            "6" => Some("周六"),
                            _ => None,
                        })
                        .collect();
                    if !names.is_empty() {
                        format!("每{} {}", names.join("、"), hhmm)
                    } else {
                        format!("定时 {}", expr)
                    }
                }
            };
        }
        if month_f == "*" && dow_f == "*" {
            if let Ok(day) = dom_f.parse::<u32>() {
                return format!("每月 {} 号 {}", day, hhmm);
            }
        }
    }
    format!("定时 {}", expr)
}

/// Computes the next trigger time (within 35 days) for a local-time cron expression.
pub fn next_cron_run_local(expr: &str, now_local: DateTime<Local>) -> Option<DateTime<Local>> {
    // Start checking from the next whole minute
    let mut candidate = now_local
        .with_second(0)
        .and_then(|d| d.with_nanosecond(0))
        .unwrap_or(now_local)
        + Duration::minutes(1);
    // Max 35 days = 50,400 minutes (sub-millisecond in Rust)
    for _ in 0..(35 * 24 * 60) {
        if matches_cron_minute(expr, &candidate) {
            return Some(candidate);
        }
        candidate += Duration::minutes(1);
    }
    None
}

fn format_next_run_label(target: DateTime<Local>, now: DateTime<Local>) -> String {
    let diff = target.signed_duration_since(now);
    let hhmm = target.format("%H:%M").to_string();
    let day_diff = (target.date_naive() - now.date_naive()).num_days();
    let day_prefix = match day_diff {
        0 => format!("今天 {}", hhmm),
        1 => format!("明天 {}", hhmm),
        2 => format!("后天 {}", hhmm),
        _ => target.format("%m/%d %H:%M").to_string(),
    };
    let mins = diff.num_minutes().max(1);
    let rel = if mins < 60 {
        format!("{} 分钟后", mins)
    } else if mins < 24 * 60 {
        let h = mins / 60;
        let m = mins % 60;
        if m == 0 {
            format!("{} 小时后", h)
        } else {
            format!("{} 小时 {} 分钟后", h, m)
        }
    } else {
        format!("{} 天后", mins / (24 * 60))
    };
    format!("{}（{}）", day_prefix, rel)
}

fn parse_cn_or_ascii_num(s: &str) -> Option<u32> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(n) = trimmed.parse::<u32>() {
        return Some(n);
    }
    match trimmed {
        "零" | "〇" => Some(0),
        "一" => Some(1),
        "二" | "两" => Some(2),
        "三" => Some(3),
        "四" => Some(4),
        "五" => Some(5),
        "六" => Some(6),
        "七" => Some(7),
        "八" => Some(8),
        "九" => Some(9),
        "十" => Some(10),
        "十一" => Some(11),
        "十二" => Some(12),
        "十三" => Some(13),
        "十四" => Some(14),
        "十五" => Some(15),
        "十六" => Some(16),
        "十七" => Some(17),
        "十八" => Some(18),
        "十九" => Some(19),
        "二十" => Some(20),
        "二十一" => Some(21),
        "二十二" => Some(22),
        "二十三" => Some(23),
        "二十四" => Some(24),
        "二十五" => Some(25),
        "三十" => Some(30),
        "四十五" => Some(45),
        _ => None,
    }
}

/// Extracts `(hour_24, minute, consumed_end_byte_idx)` from a Chinese/English time fragment.
fn extract_time_of_day(s: &str) -> Option<(u32, u32, usize)> {
    let bytes = s.as_bytes();
    // Detect optional period prefix (早上/上午/中午/下午/傍晚/晚上/凌晨/晚)
    let period_markers: [(&str, i32); 11] = [
        ("凌晨", 0),
        ("早上", 0),
        ("早晨", 0),
        ("上午", 0),
        ("早", 0),
        ("中午", 12),
        ("下午", 12),
        ("傍晚", 12),
        ("晚上", 12),
        ("今晚", 12),
        ("晚", 12),
    ];

    let mut period_offset: Option<i32> = None;
    for (m, off) in period_markers {
        if s.contains(m) {
            period_offset = Some(off);
            break;
        }
    }

    // Pattern 1: HH:MM or H:MM (with optional am/pm)
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b':' || s[i..].starts_with('：')) {
                let colon_len = if bytes[i] == b':' { 1 } else { '：'.len_utf8() };
                let m_start = i + colon_len;
                let mut m_end = m_start;
                while m_end < bytes.len() && bytes[m_end].is_ascii_digit() {
                    m_end += 1;
                }
                if m_end > m_start {
                    if let (Ok(mut h), Ok(m)) =
                        (s[start..i].parse::<u32>(), s[m_start..m_end].parse::<u32>())
                    {
                        if h <= 23 && m <= 59 {
                            let rest_lower = s[m_end..].trim_start().to_lowercase();
                            let mut end_idx = m_end;
                            if rest_lower.starts_with("pm") {
                                if h < 12 {
                                    h += 12;
                                }
                                end_idx = m_end + (s[m_end..].len() - rest_lower.len()) + 2;
                            } else if rest_lower.starts_with("am") {
                                if h == 12 {
                                    h = 0;
                                }
                                end_idx = m_end + (s[m_end..].len() - rest_lower.len()) + 2;
                            } else if let Some(12) = period_offset {
                                if h >= 1 && h <= 11 {
                                    h += 12;
                                }
                            }
                            return Some((h, m, end_idx));
                        }
                    }
                }
            }
            continue;
        }
        i += 1;
    }

    // Pattern 2: Chinese "<num>点[半|一刻|三刻|<num>分?]" or "<num>am/pm"
    for (idx, _) in s.match_indices('点') {
        let before = &s[..idx];
        // Grab trailing digits or up to 3 Chinese number chars right before '点'
        let num_str: String = before
            .chars()
            .rev()
            .take_while(|c| {
                c.is_ascii_digit()
                    || matches!(
                        c,
                        '零' | '〇' | '一' | '二' | '两' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
                    )
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Some(mut h) = parse_cn_or_ascii_num(&num_str) {
            if h <= 24 {
                if h == 24 {
                    h = 0;
                }
                if let Some(12) = period_offset {
                    if h >= 1 && h <= 11 {
                        h += 12;
                    }
                }
                let after_dot = &s[idx + '点'.len_utf8()..];
                let mut end_idx = idx + '点'.len_utf8();
                let mut m = 0u32;
                if after_dot.starts_with("半") {
                    m = 30;
                    end_idx += "半".len();
                } else if after_dot.starts_with("一刻") {
                    m = 15;
                    end_idx += "一刻".len();
                } else if after_dot.starts_with("三刻") {
                    m = 45;
                    end_idx += "三刻".len();
                } else if after_dot.starts_with("整") {
                    m = 0;
                    end_idx += "整".len();
                } else {
                    let min_chars: String = after_dot
                        .chars()
                        .take_while(|c| {
                            c.is_ascii_digit()
                                || matches!(
                                    c,
                                    '零' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
                                )
                        })
                        .collect();
                    if !min_chars.is_empty() {
                        if let Some(parsed_m) = parse_cn_or_ascii_num(&min_chars) {
                            if parsed_m <= 59 {
                                m = parsed_m;
                                end_idx += min_chars.len();
                                if s[end_idx..].starts_with("分钟") {
                                    end_idx += "分钟".len();
                                } else if s[end_idx..].starts_with('分') {
                                    end_idx += '分'.len_utf8();
                                }
                            }
                        }
                    }
                }
                return Some((h, m, end_idx));
            }
        }
    }

    // Pattern 3: English "9am", "6pm"
    let lower = s.to_lowercase();
    for suffix in ["am", "pm"] {
        if let Some(pos) = lower.find(suffix) {
            let before = lower[..pos].trim_end();
            let digits: String = before
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Ok(mut h) = digits.parse::<u32>() {
                if h >= 1 && h <= 12 {
                    if suffix == "pm" && h < 12 {
                        h += 12;
                    } else if suffix == "am" && h == 12 {
                        h = 0;
                    }
                    return Some((h, 0, pos + 2));
                }
            }
        }
    }

    None
}

fn clean_extracted_task(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    loop {
        let before = s.clone();
        for p in [
            "，", ",", "：", ":", "。", ".", "帮我", "请帮我", "请", "自动", "定时", "提醒我", "去",
            "to ", "run ",
        ] {
            if let Some(rest) = s.strip_prefix(p) {
                s = rest.trim_start().to_string();
            }
        }
        if s == before {
            break;
        }
    }
    s
}

fn make_suggested_name(task: &str, schedule_text: &str) -> String {
    let cleaned = task.trim();
    if cleaned.is_empty() {
        return format!("定时任务 · {}", schedule_text);
    }
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() <= 18 {
        cleaned.to_string()
    } else {
        format!("{}…", chars[..18].iter().collect::<String>())
    }
}

/// Parses natural Chinese / English schedule sentences into a local-time Cron or one-shot `run_at`.
///
/// Examples:
/// - `"每天早上9点跑单测并修复报错"` -> `cron: "0 9 * * *"`, `schedule_text: "每天 09:00"`
/// - `"每个工作日18:30总结代码改动"` -> `cron: "30 18 * * 1-5"`, `schedule_text: "每个工作日 18:30"`
/// - `"每周五下午6点写本周周报"` -> `cron: "0 18 * * 5"`, `schedule_text: "每周五 18:00"`
/// - `"每2小时检查接口状态"` -> `cron: "0 */2 * * *"`, `schedule_text: "每 2 小时"`
/// - `"30分钟后检查构建结果"` -> `once`, `run_at: now + 30m`
/// - `"明天上午10点提醒我看PR"` -> `once`, `run_at: tomorrow 10:00`
pub fn parse_natural_schedule(input: &str, now_local: DateTime<Local>) -> ParsedScheduleResult {
    let trimmed = input.trim();
    // Strip optional leading intent wrappers like "帮我定时" / "定时" / "/schedule"
    let mut normalized = trimmed;
    for prefix in [
        "/schedule",
        "/定时",
        "帮我定时",
        "请定时",
        "创建定时任务",
        "设个定时",
        "定时：",
        "定时:",
        "定时",
    ] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            normalized = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '：' || c == ':');
        }
    }
    let lower = normalized.to_lowercase();

    // -------------------------------------------------------------------------
    // 1. Relative one-shot: "30分钟后...", "半小时后...", "2小时后...", "in 30 minutes..."
    // -------------------------------------------------------------------------
    if let Some(pos) = normalized.find("半小时后") {
        let target = now_local + Duration::minutes(30);
        let task = clean_extracted_task(&normalized[pos + "半小时后".len()..]);
        let sched = format!("{} · 单次", target.format("%H:%M"));
        return ParsedScheduleResult {
            ok: true,
            trigger_type: "once".to_string(),
            cron_expr: None,
            run_at: Some(target.with_timezone(&Utc)),
            schedule_text: sched.clone(),
            next_run_label: Some(format_next_run_label(target, now_local)),
            suggested_name: make_suggested_name(&task, &sched),
            task_prompt: task,
            hint: None,
        };
    }

    for (unit_kw, multiplier_mins) in [
        ("分钟后", 1i64),
        ("分后", 1i64),
        ("小时后", 60i64),
        ("个小时后", 60i64),
        ("天后", 24 * 60i64),
    ] {
        if let Some(pos) = normalized.find(unit_kw) {
            let before = normalized[..pos].trim_end();
            let num_str: String = before
                .chars()
                .rev()
                .take_while(|c| {
                    c.is_ascii_digit()
                        || matches!(
                            c,
                            '一' | '二' | '两' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十'
                        )
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Some(n) = parse_cn_or_ascii_num(&num_str) {
                if n > 0 && n <= 720 {
                    let target = now_local + Duration::minutes(n as i64 * multiplier_mins);
                    let task = clean_extracted_task(&normalized[pos + unit_kw.len()..]);
                    let sched = format!("{} · 单次", target.format("%m/%d %H:%M"));
                    return ParsedScheduleResult {
                        ok: true,
                        trigger_type: "once".to_string(),
                        cron_expr: None,
                        run_at: Some(target.with_timezone(&Utc)),
                        schedule_text: sched.clone(),
                        next_run_label: Some(format_next_run_label(target, now_local)),
                        suggested_name: make_suggested_name(&task, &sched),
                        task_prompt: task,
                        hint: None,
                    };
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 2. Recurring intervals: "每30分钟...", "每隔2小时...", "每小时...", "every 2 hours..."
    // -------------------------------------------------------------------------
    for (kw, is_hour) in [
        ("每小时", true),
        ("每隔一小时", true),
        ("every hour", true),
        ("hourly", true),
    ] {
        if let Some(pos) = lower.find(kw) {
            let cron = "0 * * * *".to_string();
            let task = clean_extracted_task(&normalized[pos + kw.len()..]);
            let sched = "每小时整点".to_string();
            let next_lbl = next_cron_run_local(&cron, now_local)
                .map(|t| format_next_run_label(t, now_local));
            return ParsedScheduleResult {
                ok: true,
                trigger_type: "cron".to_string(),
                cron_expr: Some(cron),
                run_at: None,
                schedule_text: sched.clone(),
                next_run_label: next_lbl,
                suggested_name: make_suggested_name(&task, &sched),
                task_prompt: task,
                hint: None,
            };
        }
        let _ = is_hour;
    }

    for (prefix, unit_kw, is_hour) in [
        ("每隔", "小时", true),
        ("每隔", "个小时", true),
        ("每", "小时", true),
        ("每", "个小时", true),
        ("每隔", "分钟", false),
        ("每", "分钟", false),
    ] {
        if let Some(p_idx) = normalized.find(prefix) {
            let rest = &normalized[p_idx + prefix.len()..];
            if let Some(u_idx) = rest.find(unit_kw) {
                let between = rest[..u_idx].trim();
                if let Some(n) = parse_cn_or_ascii_num(between) {
                    let valid = if is_hour { (1..=23).contains(&n) } else { (1..=59).contains(&n) };
                    if valid {
                        let cron = if is_hour {
                            format!("0 */{} * * *", n)
                        } else {
                            format!("*/{} * * * *", n)
                        };
                        let sched = if is_hour {
                            format!("每 {} 小时", n)
                        } else {
                            format!("每 {} 分钟", n)
                        };
                        let task = clean_extracted_task(&rest[u_idx + unit_kw.len()..]);
                        let next_lbl = next_cron_run_local(&cron, now_local)
                            .map(|t| format_next_run_label(t, now_local));
                        return ParsedScheduleResult {
                            ok: true,
                            trigger_type: "cron".to_string(),
                            cron_expr: Some(cron),
                            run_at: None,
                            schedule_text: sched.clone(),
                            next_run_label: next_lbl,
                            suggested_name: make_suggested_name(&task, &sched),
                            task_prompt: task,
                            hint: None,
                        };
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 3. Named-day one-shot: "今天/今晚/明天/后天 + time"
    // -------------------------------------------------------------------------
    let named_day_offset: Option<(i64, &str)> = if normalized.contains("后天") {
        Some((2, "后天"))
    } else if normalized.contains("明天") || lower.contains("tomorrow") {
        Some((1, "明天"))
    } else if normalized.contains("今晚") || normalized.contains("今天") || lower.contains("today") {
        Some((0, if normalized.contains("今晚") { "今晚" } else { "今天" }))
    } else {
        None
    };

    if let Some((day_off, day_kw)) = named_day_offset {
        let (h, m, consumed_end) = extract_time_of_day(normalized).unwrap_or((9, 0, normalized.find(day_kw).map(|i| i + day_kw.len()).unwrap_or(0)));
        let target_date = now_local.date_naive() + Duration::days(day_off);
        if let Some(naive_dt) = target_date.and_hms_opt(h, m, 0) {
            if let Some(mut target_local) = Local.from_local_datetime(&naive_dt).earliest() {
                if day_off == 0 && target_local <= now_local {
                    target_local += Duration::days(1);
                }
                let task = clean_extracted_task(&normalized[consumed_end.min(normalized.len())..]);
                let sched = format!("{} {:02}:{:02} · 单次", day_kw, h, m);
                return ParsedScheduleResult {
                    ok: true,
                    trigger_type: "once".to_string(),
                    cron_expr: None,
                    run_at: Some(target_local.with_timezone(&Utc)),
                    schedule_text: sched.clone(),
                    next_run_label: Some(format_next_run_label(target_local, now_local)),
                    suggested_name: make_suggested_name(&task, &sched),
                    task_prompt: task,
                    hint: None,
                };
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Monthly recurring: "每月 1 号 9点"
    // -------------------------------------------------------------------------
    if let Some(m_pos) = normalized.find("每月") {
        let rest = &normalized[m_pos + "每月".len()..];
        let mut day_num: Option<u32> = None;
        let mut after_day_idx = m_pos + "每月".len();
        for marker in ["号", "日"] {
            if let Some(d_pos) = rest.find(marker) {
                if let Some(d) = parse_cn_or_ascii_num(rest[..d_pos].trim()) {
                    if (1..=31).contains(&d) {
                        day_num = Some(d);
                        after_day_idx = m_pos + "每月".len() + d_pos + marker.len();
                        break;
                    }
                }
            }
        }
        if let Some(dom) = day_num {
            let (h, m, end_idx) = extract_time_of_day(normalized).unwrap_or((9, 0, after_day_idx));
            let cron = format!("{} {} {} * *", m, h, dom);
            let sched = format!("每月 {} 号 {:02}:{:02}", dom, h, m);
            let task = clean_extracted_task(&normalized[end_idx.max(after_day_idx).min(normalized.len())..]);
            let next_lbl = next_cron_run_local(&cron, now_local)
                .map(|t| format_next_run_label(t, now_local));
            return ParsedScheduleResult {
                ok: true,
                trigger_type: "cron".to_string(),
                cron_expr: Some(cron),
                run_at: None,
                schedule_text: sched.clone(),
                next_run_label: next_lbl,
                suggested_name: make_suggested_name(&task, &sched),
                task_prompt: task,
                hint: None,
            };
        }
    }

    // -------------------------------------------------------------------------
    // 5. Workdays / Weekends / Weekly / Daily recurring
    // -------------------------------------------------------------------------
    let time_extracted = extract_time_of_day(normalized);
    let is_workday = normalized.contains("工作日")
        || normalized.contains("周一到周五")
        || normalized.contains("周一至周五")
        || lower.contains("weekday");
    let is_weekend = normalized.contains("周末") || lower.contains("weekend");
    let is_daily = normalized.contains("每天")
        || normalized.contains("每日")
        || lower.contains("every day")
        || lower.contains("daily");

    // Check specific weekdays ("每周五", "每周一、三、五", "every monday")
    let mut specific_dows: Vec<u32> = Vec::new();
    let has_weekly_cue = normalized.contains("每周")
        || normalized.contains("每逢")
        || normalized.contains("星期")
        || lower.contains("every ");
    if has_weekly_cue && !is_workday && !is_weekend {
        let dow_patterns: [(&[&str], u32); 7] = [
            (&["周一", "星期一", "礼拜一", "monday"], 1),
            (&["周二", "星期二", "礼拜二", "tuesday"], 2),
            (&["周三", "星期三", "礼拜三", "wednesday"], 3),
            (&["周四", "星期四", "礼拜四", "thursday"], 4),
            (&["周五", "星期五", "礼拜五", "friday"], 5),
            (&["周六", "星期六", "礼拜六", "saturday"], 6),
            (&["周日", "周天", "星期日", "星期天", "礼拜日", "sunday"], 0),
        ];
        for (pats, dow_val) in dow_patterns {
            if pats.iter().any(|p| normalized.contains(p) || lower.contains(p)) {
                specific_dows.push(dow_val);
            }
        }
        // Also support shorthand like "每周一、三、五"
        if normalized.contains("每周") && specific_dows.len() == 1 {
            if let Some(wz) = normalized.find("每周") {
                let seg = &normalized[wz + "每周".len()..];
                let head: String = seg.chars().take(12).collect();
                for (ch, v) in [('一', 1), ('二', 2), ('三', 3), ('四', 4), ('五', 5), ('六', 6), ('日', 0), ('天', 0)] {
                    if head.contains(ch) && !specific_dows.contains(&v) {
                        specific_dows.push(v);
                    }
                }
            }
        }
        specific_dows.sort();
        specific_dows.dedup();
    }

    if is_workday || is_weekend || is_daily || !specific_dows.is_empty() || time_extracted.is_some() {
        let (h, m, end_idx) = time_extracted.unwrap_or((9, 0, 0));
        let dow_field = if is_workday {
            "1-5".to_string()
        } else if is_weekend {
            "0,6".to_string()
        } else if !specific_dows.is_empty() {
            specific_dows
                .iter()
                .map(|d| d.to_string())
                .collect::<Vec<_>>()
                .join(",")
        } else {
            "*".to_string()
        };
        let cron = format!("{} {} * * {}", m, h, dow_field);
        let sched = describe_cron_human(&cron);
        let task = if end_idx > 0 && end_idx <= normalized.len() {
            clean_extracted_task(&normalized[end_idx..])
        } else {
            let mut stripped = normalized.to_string();
            for cue in ["每个工作日", "工作日", "每周末", "周末", "每天", "每日", "每周"] {
                stripped = stripped.replace(cue, "");
            }
            clean_extracted_task(&stripped)
        };
        let next_lbl = next_cron_run_local(&cron, now_local)
            .map(|t| format_next_run_label(t, now_local));
        return ParsedScheduleResult {
            ok: true,
            trigger_type: "cron".to_string(),
            cron_expr: Some(cron),
            run_at: None,
            schedule_text: sched.clone(),
            next_run_label: next_lbl,
            suggested_name: make_suggested_name(&task, &sched),
            task_prompt: task,
            hint: None,
        };
    }

    ParsedScheduleResult {
        ok: false,
        trigger_type: "cron".to_string(),
        cron_expr: None,
        run_at: None,
        schedule_text: String::new(),
        next_run_label: None,
        task_prompt: trimmed.to_string(),
        suggested_name: String::new(),
        hint: Some("试试这样说：「每天早上9点跑单测」「工作日18:30总结改动」「30分钟后检查构建」".to_string()),
    }
}

/// Verifies GitHub Webhook `X-Hub-Signature-256` (`sha256=<hex>`) using constant-time HMAC-SHA256.
pub fn verify_github_signature(secret: &str, body: &[u8], signature_header: Option<&str>) -> bool {
    if secret.trim().is_empty() {
        return true;
    }
    let Some(sig) = signature_header.and_then(|h| h.trim().strip_prefix("sha256=")) else {
        return false;
    };
    let Ok(sig_bytes) = hex::decode(sig) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&sig_bytes).is_ok()
}

/// Interpolates webhook JSON fields (`{{event}}`, `{{action}}`, `{{title}}`, `{{body}}`, `{{url}}`, `{{sender}}`) into `template`.
pub fn render_webhook_prompt(template: &str, event_name: &str, payload: &Value) -> String {
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("triggered");
    let title = payload
        .pointer("/issue/title")
        .or_else(|| payload.pointer("/pull_request/title"))
        .or_else(|| payload.pointer("/check_run/name"))
        .or_else(|| payload.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("Webhook Task");
    let body = payload
        .pointer("/comment/body")
        .or_else(|| payload.pointer("/issue/body"))
        .or_else(|| payload.pointer("/pull_request/body"))
        .or_else(|| payload.pointer("/check_run/output/summary"))
        .or_else(|| payload.get("body"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = payload
        .pointer("/comment/html_url")
        .or_else(|| payload.pointer("/issue/html_url"))
        .or_else(|| payload.pointer("/pull_request/html_url"))
        .or_else(|| payload.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sender = payload
        .pointer("/sender/login")
        .and_then(|v| v.as_str())
        .unwrap_or("external");

    template
        .replace("{{event}}", event_name)
        .replace("{{action}}", action)
        .replace("{{title}}", title)
        .replace("{{body}}", body)
        .replace("{{url}}", url)
        .replace("{{sender}}", sender)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_cron_matcher_and_hmac() {
        let dt = Utc.with_ymd_and_hms(2026, 11, 11, 9, 30, 0).unwrap();
        assert!(matches_cron_minute("30 9 * * *", &dt));
        assert!(matches_cron_minute("*/15 9-18 * * 1-5", &dt));
        assert!(!matches_cron_minute("0 9 * * *", &dt));

        let body = b"{\"action\":\"opened\",\"issue\":{\"title\":\"Fix login\"}}";
        let mut mac = HmacSha256::new_from_slice(b"mysecret").unwrap();
        mac.update(body);
        let sig_hdr = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
        assert!(verify_github_signature("mysecret", body, Some(&sig_hdr)));
        assert!(!verify_github_signature("wrong", body, Some(&sig_hdr)));
    }

    #[test]
    fn test_parse_natural_chinese_schedules() {
        let now = Local.with_ymd_and_hms(2026, 11, 22, 16, 0, 0).unwrap();

        let p1 = parse_natural_schedule("每天早上9点帮我跑一遍单测", now);
        assert!(p1.ok);
        assert_eq!(p1.trigger_type, "cron");
        assert_eq!(p1.cron_expr.as_deref(), Some("0 9 * * *"));
        assert_eq!(p1.schedule_text, "每天 09:00");
        assert_eq!(p1.task_prompt, "跑一遍单测");

        let p2 = parse_natural_schedule("每个工作日18:30总结代码改动", now);
        assert!(p2.ok);
        assert_eq!(p2.cron_expr.as_deref(), Some("30 18 * * 1-5"));
        assert_eq!(p2.schedule_text, "每个工作日 18:30");
        assert_eq!(p2.task_prompt, "总结代码改动");

        let p3 = parse_natural_schedule("每周五下午6点半生成周报", now);
        assert!(p3.ok);
        assert_eq!(p3.cron_expr.as_deref(), Some("30 18 * * 5"));
        assert_eq!(p3.schedule_text, "每周五 18:30");
        assert_eq!(p3.task_prompt, "生成周报");

        let p4 = parse_natural_schedule("每2小时检查服务健康", now);
        assert!(p4.ok);
        assert_eq!(p4.cron_expr.as_deref(), Some("0 */2 * * *"));
        assert_eq!(p4.schedule_text, "每 2 小时");
        assert_eq!(p4.task_prompt, "检查服务健康");

        let p5 = parse_natural_schedule("30分钟后检查构建结果", now);
        assert!(p5.ok);
        assert_eq!(p5.trigger_type, "once");
        assert!(p5.run_at.is_some());
        assert_eq!(p5.task_prompt, "检查构建结果");

        let p6 = parse_natural_schedule("明天上午10点提醒我看PR", now);
        assert!(p6.ok);
        assert_eq!(p6.trigger_type, "once");
        let run_local = p6.run_at.unwrap().with_timezone(&Local);
        assert_eq!(run_local.day(), 23);
        assert_eq!(run_local.hour(), 10);
        assert_eq!(p6.task_prompt, "看PR");
    }
}
