use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use uuid::Uuid;
use velo_protocol::{AgentEvent, MeshInvocationInfo, SessionInfo, SessionStatus};

#[derive(Clone)]
pub struct VeloSqliteStore {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventsPageDto {
    pub session_id: Uuid,
    pub events: Vec<AgentEvent>,
    pub oldest_seq: Option<i64>,
    pub newest_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_ts_ms: Option<i64>,
    pub event_count: usize,
    pub has_more: bool,
    #[serde(default)]
    pub incremental: bool,
    #[serde(default)]
    pub unchanged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHitDto {
    pub session_id: Uuid,
    pub session_name: String,
    pub repo_root: String,
    pub provider: String,
    pub kind: String,
    pub snippet: String,
    pub timestamp_ms: i64,
}

fn extract_event_metadata(ev: &AgentEvent) -> (&'static str, i64, String) {
    match ev {
        AgentEvent::UserMessage {
            text, timestamp, ..
        } => ("user_message", timestamp.timestamp_millis(), text.clone()),
        AgentEvent::MessageDelta {
            text, timestamp, ..
        } => ("message_delta", timestamp.timestamp_millis(), text.clone()),
        AgentEvent::ThinkingDelta {
            text, timestamp, ..
        } => ("thinking_delta", timestamp.timestamp_millis(), text.clone()),
        AgentEvent::ToolCallRequested {
            tool_name,
            arguments,
            timestamp,
            ..
        } => (
            "tool_call_requested",
            timestamp.timestamp_millis(),
            format!("{} {}", tool_name, arguments),
        ),
        AgentEvent::ToolCallCompleted {
            output, timestamp, ..
        } => {
            let short: String = output.chars().take(600).collect();
            ("tool_call_completed", timestamp.timestamp_millis(), short)
        }
        AgentEvent::UsageUpdated { timestamp, .. } => {
            ("usage_updated", timestamp.timestamp_millis(), String::new())
        }
        AgentEvent::StatusChanged {
            message, timestamp, ..
        } => (
            "status_changed",
            timestamp.timestamp_millis(),
            message.clone().unwrap_or_default(),
        ),
        AgentEvent::Error {
            error, timestamp, ..
        } => ("error", timestamp.timestamp_millis(), error.clone()),
        AgentEvent::PermissionRequested {
            tool_name,
            description,
            timestamp,
            ..
        } => (
            "permission_requested",
            timestamp.timestamp_millis(),
            format!("{} {}", tool_name, description),
        ),
        AgentEvent::PermissionResolved {
            decision,
            timestamp,
            ..
        } => (
            "permission_resolved",
            timestamp.timestamp_millis(),
            decision.clone(),
        ),
        AgentEvent::UserQuestionRequested {
            question,
            timestamp,
            ..
        } => (
            "user_question_requested",
            timestamp.timestamp_millis(),
            question.clone(),
        ),
        AgentEvent::UserQuestionAnswered {
            answers, timestamp, ..
        } => (
            "user_question_answered",
            timestamp.timestamp_millis(),
            answers.join(", "),
        ),
        AgentEvent::SetupHookOutput {
            command, timestamp, ..
        } => (
            "setup_hook_output",
            timestamp.timestamp_millis(),
            command.clone(),
        ),
        AgentEvent::DiffUpdated { timestamp, .. } => {
            ("diff_updated", timestamp.timestamp_millis(), String::new())
        }
        AgentEvent::MeshInvocationUpdated {
            invocation,
            timestamp,
            ..
        } => (
            "mesh_invocation_updated",
            timestamp.timestamp_millis(),
            format!(
                "{} -> {} {}",
                invocation.caller_session_name, invocation.callee_session_name, invocation.prompt
            ),
        ),
        AgentEvent::ProviderSessionBound { timestamp, .. } => (
            "provider_session_bound",
            timestamp.timestamp_millis(),
            String::new(),
        ),
        AgentEvent::PtyOutput { timestamp, .. } => {
            ("pty_output", timestamp.timestamp_millis(), String::new())
        }
        AgentEvent::ThinkingChunk { timestamp, .. } => (
            "thinking_chunk",
            timestamp.timestamp_millis(),
            String::new(),
        ),
        AgentEvent::MessageChunk { timestamp, .. } => {
            ("message_chunk", timestamp.timestamp_millis(), String::new())
        }
        AgentEvent::TerminalOutput { timestamp, .. } => (
            "terminal_output",
            timestamp.timestamp_millis(),
            String::new(),
        ),
        AgentEvent::BrowserCommand { timestamp, .. } => (
            "browser_command",
            timestamp.timestamp_millis(),
            String::new(),
        ),
        AgentEvent::RateLimitsUpdated { timestamp, .. } => (
            "rate_limits_updated",
            timestamp.timestamp_millis(),
            String::new(),
        ),
    }
}

impl VeloSqliteStore {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -16000;
             PRAGMA wal_checkpoint(TRUNCATE);
             CREATE TABLE IF NOT EXISTS sessions (
                 id TEXT PRIMARY KEY,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 repo_root TEXT NOT NULL,
                 name TEXT NOT NULL,
                 prompt TEXT NOT NULL,
                 json_blob TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS session_events (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 session_id TEXT NOT NULL,
                 event_type TEXT NOT NULL,
                 ts_ms INTEGER NOT NULL,
                 search_text TEXT NOT NULL,
                 json_blob TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_session_events_sid_seq
                 ON session_events(session_id, seq);
             CREATE TABLE IF NOT EXISTS kv_meta (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS session_invocations (
                 id TEXT PRIMARY KEY,
                 caller_session_id TEXT NOT NULL,
                 callee_session_id TEXT,
                 root_invocation_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 created_at_ms INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 json_blob TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_invocations_caller
                 ON session_invocations(caller_session_id, created_at_ms);
             CREATE INDEX IF NOT EXISTS idx_invocations_callee
                 ON session_invocations(callee_session_id, created_at_ms);
             CREATE INDEX IF NOT EXISTS idx_invocations_root
                 ON session_invocations(root_invocation_id);",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    #[inline]
    fn lock_conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn migrate_from_legacy_json_if_needed(
        &self,
        state_file: &Path,
        events_dir: &Path,
    ) -> Result<bool> {
        let mut conn = self.lock_conn();
        let already: Option<String> = conn
            .query_row(
                "SELECT value FROM kv_meta WHERE key = 'migrated_legacy_json_v1'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if already.is_some() {
            return Ok(false);
        }

        let existing_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;
        if existing_count == 0 && state_file.exists() {
            if let Ok(raw) = std::fs::read_to_string(state_file) {
                if let Ok(saved) = serde_json::from_str::<Vec<SessionInfo>>(&raw) {
                    let tx = conn.transaction()?;
                    for mut s in saved {
                        s.repo_root = crate::canonical_workspace_path(&s.repo_root);
                        s.worktree_path = crate::canonical_workspace_path(&s.worktree_path);
                        if matches!(
                            s.status,
                            SessionStatus::Starting
                                | SessionStatus::Running
                                | SessionStatus::WaitingForPermission
                        ) {
                            s.status = SessionStatus::Stopped;
                        }
                        let ev_path = events_dir.join(format!("{}.json", s.id));
                        if let Ok(ev_raw) = std::fs::read_to_string(&ev_path) {
                            if let Ok(evs) = serde_json::from_str::<Vec<AgentEvent>>(&ev_raw) {
                                let enriched = crate::enrich_history_turn_metrics(&evs);
                                let mut sum_out = 0u64;
                                let mut sum_cost = 0.0f64;
                                for e in &enriched {
                                    if let AgentEvent::UsageUpdated {
                                        output_tokens,
                                        cost_usd,
                                        ..
                                    } = e
                                    {
                                        sum_out += *output_tokens;
                                        sum_cost += *cost_usd;
                                    }
                                    let (etype, ts_ms, stext) = extract_event_metadata(e);
                                    if let Ok(blob) = serde_json::to_string(e) {
                                        tx.execute(
                                            "INSERT INTO session_events (session_id, event_type, ts_ms, search_text, json_blob)
                                             VALUES (?1, ?2, ?3, ?4, ?5)",
                                            params![s.id.to_string(), etype, ts_ms, stext, blob],
                                        )?;
                                    }
                                }
                                if sum_out > s.output_tokens {
                                    s.output_tokens = sum_out;
                                }
                                if sum_cost > s.cost_usd {
                                    s.cost_usd = sum_cost;
                                }
                            }
                        }
                        let blob = serde_json::to_string(&s)?;
                        tx.execute(
                            "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, repo_root, name, prompt, json_blob)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                s.id.to_string(),
                                s.created_at.to_rfc3339(),
                                s.updated_at.to_rfc3339(),
                                s.repo_root,
                                s.name,
                                s.prompt,
                                blob
                            ],
                        )?;
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('migrated_legacy_json_v1', '1')",
                        [],
                    )?;
                    tx.commit()?;
                    return Ok(true);
                }
            }
        }

        conn.execute(
            "INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('migrated_legacy_json_v1', '1')",
            [],
        )?;
        Ok(false)
    }

    pub fn load_all(&self) -> Result<(HashMap<Uuid, SessionInfo>, HashMap<Uuid, Vec<AgentEvent>>)> {
        let conn = self.lock_conn();
        let mut sessions = HashMap::new();
        let mut event_history: HashMap<Uuid, Vec<AgentEvent>> = HashMap::new();

        {
            let mut stmt = conn.prepare("SELECT json_blob FROM sessions")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for r in rows {
                if let Ok(blob) = r {
                    if let Ok(mut s) = serde_json::from_str::<SessionInfo>(&blob) {
                        s.repo_root = crate::canonical_workspace_path(&s.repo_root);
                        s.worktree_path = crate::canonical_workspace_path(&s.worktree_path);
                        if matches!(
                            s.status,
                            SessionStatus::Starting
                                | SessionStatus::Running
                                | SessionStatus::WaitingForPermission
                        ) {
                            s.status = SessionStatus::Stopped;
                        }
                        sessions.insert(s.id, s);
                    }
                }
            }
        }

        {
            let mut stmt = conn
                .prepare("SELECT session_id, json_blob FROM session_events ORDER BY seq ASC")?;
            let rows =
                stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            for r in rows {
                if let Ok((sid_str, blob)) = r {
                    if let (Ok(sid), Ok(ev)) = (
                        Uuid::parse_str(&sid_str),
                        serde_json::from_str::<AgentEvent>(&blob),
                    ) {
                        event_history.entry(sid).or_default().push(ev);
                    }
                }
            }
        }

        for (sid, evs) in event_history.iter_mut() {
            let enriched = crate::enrich_history_turn_metrics(evs);
            if let Some(s) = sessions.get_mut(sid) {
                let mut sum_out = 0u64;
                let mut sum_cost = 0.0f64;
                for e in &enriched {
                    if let AgentEvent::UsageUpdated {
                        output_tokens,
                        cost_usd,
                        ..
                    } = e
                    {
                        sum_out += *output_tokens;
                        sum_cost += *cost_usd;
                    }
                }
                if sum_out > s.output_tokens {
                    s.output_tokens = sum_out;
                }
                if sum_cost > s.cost_usd {
                    s.cost_usd = sum_cost;
                }
            }
            *evs = enriched;
        }

        Ok((sessions, event_history))
    }

    pub fn upsert_session(&self, s: &SessionInfo) -> Result<()> {
        let blob = serde_json::to_string(s)?;
        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, repo_root, name, prompt, json_blob)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                s.id.to_string(),
                s.created_at.to_rfc3339(),
                s.updated_at.to_rfc3339(),
                s.repo_root,
                s.name,
                s.prompt,
                blob
            ],
        )?;
        Ok(())
    }

    pub fn upsert_sessions_batch(&self, list: &[SessionInfo]) -> Result<()> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        for s in list {
            let blob = serde_json::to_string(s)?;
            tx.execute(
                "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, repo_root, name, prompt, json_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    s.id.to_string(),
                    s.created_at.to_rfc3339(),
                    s.updated_at.to_rfc3339(),
                    s.repo_root,
                    s.name,
                    s.prompt,
                    blob
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_session(&self, session_id: Uuid) -> Result<()> {
        let sid_s = session_id.to_string();
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![&sid_s])?;
        tx.execute(
            "DELETE FROM session_events WHERE session_id = ?1",
            params![&sid_s],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_event_seq(&self, session_id: Uuid, seq: i64) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM session_events WHERE seq = ?1 AND session_id = ?2",
            params![seq, session_id.to_string()],
        )?;
        Ok(())
    }

    /// Insert a new event, or replace the provisional streamed message row.
    pub fn upsert_event_seq(
        &self,
        session_id: Uuid,
        seq: Option<i64>,
        ev: &AgentEvent,
    ) -> Result<i64> {
        if let Some(seq) = seq {
            let (etype, ts_ms, stext) = extract_event_metadata(ev);
            let blob = serde_json::to_string(ev)?;
            let conn = self.lock_conn();
            let updated = conn.execute(
                "UPDATE session_events
                 SET event_type = ?1, ts_ms = ?2, search_text = ?3, json_blob = ?4
                 WHERE seq = ?5 AND session_id = ?6",
                params![etype, ts_ms, stext, blob, seq, session_id.to_string()],
            )?;
            if updated > 0 {
                return Ok(seq);
            }
        }
        self.append_event(session_id, ev)
    }

    /// O(1) single-row incremental append in WAL mode.
    pub fn append_event(&self, session_id: Uuid, ev: &AgentEvent) -> Result<i64> {
        let (etype, ts_ms, stext) = extract_event_metadata(ev);
        let blob = serde_json::to_string(ev)?;
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO session_events (session_id, event_type, ts_ms, search_text, json_blob)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id.to_string(), etype, ts_ms, stext, blob],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// O(1) upsert of the active turn's single authoritative `UsageUpdated` row.
    pub fn upsert_turn_usage_event(&self, session_id: Uuid, usage_ev: &AgentEvent) -> Result<()> {
        let sid_s = session_id.to_string();
        let (_, ts_ms, _) = extract_event_metadata(usage_ev);
        let blob = serde_json::to_string(usage_ev)?;
        let conn = self.lock_conn();

        let last_user_seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM session_events
                 WHERE session_id = ?1 AND event_type = 'user_message'",
                params![&sid_s],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let existing_usage_seq: Option<i64> = conn
            .query_row(
                "SELECT seq FROM session_events
                 WHERE session_id = ?1 AND seq > ?2 AND event_type = 'usage_updated'
                 ORDER BY seq DESC LIMIT 1",
                params![&sid_s, last_user_seq],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(seq) = existing_usage_seq {
            conn.execute(
                "UPDATE session_events SET ts_ms = ?1, json_blob = ?2 WHERE seq = ?3",
                params![ts_ms, blob, seq],
            )?;
            conn.execute(
                "DELETE FROM session_events
                 WHERE session_id = ?1 AND seq > ?2 AND event_type = 'usage_updated' AND seq != ?3",
                params![&sid_s, last_user_seq, seq],
            )?;
        } else {
            conn.execute(
                "INSERT INTO session_events (session_id, event_type, ts_ms, search_text, json_blob)
                 VALUES (?1, 'usage_updated', ?2, '', ?3)",
                params![&sid_s, ts_ms, blob],
            )?;
        }
        Ok(())
    }

    pub fn replace_session_events(&self, session_id: Uuid, events: &[AgentEvent]) -> Result<()> {
        let sid_s = session_id.to_string();
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM session_events WHERE session_id = ?1",
            params![&sid_s],
        )?;
        for ev in events {
            let (etype, ts_ms, stext) = extract_event_metadata(ev);
            let blob = serde_json::to_string(ev)?;
            tx.execute(
                "INSERT INTO session_events (session_id, event_type, ts_ms, search_text, json_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![&sid_s, etype, ts_ms, stext, blob],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn query_events_page(
        &self,
        session_id: Uuid,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<EventsPageDto> {
        let sid_s = session_id.to_string();
        let capped = limit.clamp(10, 500);
        let conn = self.lock_conn();

        let mut rows_desc: Vec<(i64, AgentEvent)> = Vec::new();
        if let Some(b_seq) = before_seq {
            let mut stmt = conn.prepare(
                "SELECT seq, json_blob FROM session_events
                 WHERE session_id = ?1 AND seq < ?2
                 ORDER BY seq DESC LIMIT ?3",
            )?;
            let mapped = stmt.query_map(params![&sid_s, b_seq, (capped + 1) as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for item in mapped.flatten() {
                if let Ok(ev) = serde_json::from_str::<AgentEvent>(&item.1) {
                    rows_desc.push((item.0, ev));
                }
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT seq, json_blob FROM session_events
                 WHERE session_id = ?1
                 ORDER BY seq DESC LIMIT ?2",
            )?;
            let mapped = stmt.query_map(params![&sid_s, (capped + 1) as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for item in mapped.flatten() {
                if let Ok(ev) = serde_json::from_str::<AgentEvent>(&item.1) {
                    rows_desc.push((item.0, ev));
                }
            }
        }

        let has_more = rows_desc.len() > capped;
        if has_more {
            rows_desc.truncate(capped);
        }
        rows_desc.reverse();

        let (event_count, latest_ts_ms): (usize, Option<i64>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(ts_ms) FROM session_events WHERE session_id = ?1",
                params![&sid_s],
                |r| Ok((r.get::<_, i64>(0).unwrap_or(0).max(0) as usize, r.get::<_, Option<i64>>(1)?)),
            )
            .unwrap_or((0, None));

        let oldest_seq = rows_desc.first().map(|(seq, _)| *seq);
        let newest_seq = rows_desc.last().map(|(seq, _)| *seq);
        let events: Vec<AgentEvent> = rows_desc.into_iter().map(|(_, ev)| ev).collect();

        Ok(EventsPageDto {
            session_id,
            events: crate::enrich_history_turn_metrics(&events),
            oldest_seq,
            newest_seq,
            latest_ts_ms,
            event_count,
            has_more,
            incremental: false,
            unchanged: false,
        })
    }

    /// Lightweight incremental catch-up query for focus/foreground resyncs.
    /// Returns `unchanged = true` with zero event deserialization when nothing changed,
    /// `incremental = true` with only newly appended tail rows when safe, or gracefully
    /// falls back to a full latest page if history was rewritten/rewound or an in-place
    /// tail row was mutated.
    pub fn query_events_incremental(
        &self,
        session_id: Uuid,
        after_seq: i64,
        known_count: Option<usize>,
        known_ts_ms: Option<i64>,
        limit: usize,
    ) -> Result<EventsPageDto> {
        let sid_s = session_id.to_string();
        let capped = limit.clamp(10, 500);
        let (event_count, max_seq, latest_ts_ms, after_row_ts_ms) = {
            let conn = self.lock_conn();
            let (cnt, m_seq, m_ts): (usize, Option<i64>, Option<i64>) = conn
                .query_row(
                    "SELECT COUNT(*), MAX(seq), MAX(ts_ms) FROM session_events WHERE session_id = ?1",
                    params![&sid_s],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0).unwrap_or(0).max(0) as usize,
                            r.get::<_, Option<i64>>(1)?,
                            r.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .unwrap_or((0, None, None));

            let after_ts: Option<i64> = conn
                .query_row(
                    "SELECT ts_ms FROM session_events WHERE session_id = ?1 AND seq = ?2",
                    params![&sid_s, after_seq],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .unwrap_or(None);
            (cnt, m_seq, m_ts, after_ts)
        };

        // Fast-path 1: mathematically identical (zero events changed, zero rows added/deleted)
        if known_count == Some(event_count)
            && max_seq == Some(after_seq)
            && known_ts_ms.is_some()
            && latest_ts_ms == known_ts_ms
        {
            return Ok(EventsPageDto {
                session_id,
                events: Vec::new(),
                oldest_seq: None,
                newest_seq: max_seq,
                latest_ts_ms,
                event_count,
                has_more: false,
                incremental: true,
                unchanged: true,
            });
        }

        // Fast-path 2: strictly append-only tail growth since `after_seq`
        let rewound_or_shrunk = known_count.is_some_and(|kc| event_count < kc);
        let tail_mutated_in_place = known_ts_ms
            .zip(after_row_ts_ms)
            .is_some_and(|(kt, at)| at > kt);

        if !rewound_or_shrunk
            && !tail_mutated_in_place
            && max_seq.is_some_and(|m| m > after_seq)
        {
            let conn = self.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT seq, json_blob FROM session_events
                 WHERE session_id = ?1 AND seq > ?2
                 ORDER BY seq ASC LIMIT ?3",
            )?;
            let mapped = stmt.query_map(params![&sid_s, after_seq, (capped + 1) as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut rows_asc: Vec<(i64, AgentEvent)> = Vec::new();
            for item in mapped.flatten() {
                if let Ok(ev) = serde_json::from_str::<AgentEvent>(&item.1) {
                    rows_asc.push((item.0, ev));
                }
            }
            if rows_asc.len() <= capped {
                let oldest_seq = rows_asc.first().map(|(seq, _)| *seq);
                let newest_seq = rows_asc.last().map(|(seq, _)| *seq).or(max_seq);
                let events: Vec<AgentEvent> = rows_asc.into_iter().map(|(_, ev)| ev).collect();
                return Ok(EventsPageDto {
                    session_id,
                    events: crate::enrich_history_turn_metrics(&events),
                    oldest_seq,
                    newest_seq,
                    latest_ts_ms,
                    event_count,
                    has_more: false,
                    incremental: true,
                    unchanged: false,
                });
            }
        }

        // Fallback: full latest page guarantees 100% consistency after rewinds/in-place updates
        self.query_events_page(session_id, None, limit)
    }

    pub fn search_global(&self, query: &str, limit: usize) -> Result<Vec<SearchHitDto>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let capped = limit.clamp(5, 80);
        let pattern = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
        let conn = self.lock_conn();

        let mut hits: Vec<SearchHitDto> = Vec::new();

        // 1. Match session titles & initial prompts
        {
            let mut stmt = conn.prepare(
                "SELECT json_blob FROM sessions
                 WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![&pattern, capped as i64], |r| r.get::<_, String>(0))?;
            for blob in rows.flatten() {
                if let Ok(s) = serde_json::from_str::<SessionInfo>(&blob) {
                    let snippet = if s.prompt.trim().is_empty() {
                        s.name.clone()
                    } else {
                        s.prompt.chars().take(160).collect()
                    };
                    hits.push(SearchHitDto {
                        session_id: s.id,
                        session_name: s.name,
                        repo_root: s.repo_root,
                        provider: format!("{:?}", s.provider).to_lowercase(),
                        kind: "session".to_string(),
                        snippet,
                        timestamp_ms: s.updated_at.timestamp_millis(),
                    });
                }
            }
        }

        // 2. Match conversation events (`user_message`, `message_delta`, `thinking_delta`, `error`)
        if hits.len() < capped {
            let rem = (capped - hits.len()) as i64;
            let mut stmt = conn.prepare(
                "SELECT e.session_id, e.event_type, e.ts_ms, e.search_text, s.json_blob
                 FROM session_events e
                 JOIN sessions s ON s.id = e.session_id
                 WHERE e.event_type IN ('user_message', 'message_delta', 'thinking_delta', 'error')
                   AND e.search_text LIKE ?1 ESCAPE '\\'
                 ORDER BY e.ts_ms DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![&pattern, rem], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?;
            for item in rows.flatten() {
                if let (Ok(sid), Ok(s)) = (
                    Uuid::parse_str(&item.0),
                    serde_json::from_str::<SessionInfo>(&item.4),
                ) {
                    let snippet = build_match_snippet(&item.3, q, 160);
                    hits.push(SearchHitDto {
                        session_id: sid,
                        session_name: s.name,
                        repo_root: s.repo_root,
                        provider: format!("{:?}", s.provider).to_lowercase(),
                        kind: item.1,
                        snippet,
                        timestamp_ms: item.2,
                    });
                }
            }
        }

        Ok(hits)
    }

    pub fn get_kv(&self, key: &str) -> Result<Option<String>> {
        let conn = self.lock_conn();
        let val = conn
            .query_row("SELECT value FROM kv_meta WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        Ok(val)
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO kv_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn upsert_invocation(&self, inv: &MeshInvocationInfo) -> Result<()> {
        let conn = self.lock_conn();
        let blob = serde_json::to_string(inv)?;
        let status_str = serde_json::to_value(inv.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "running".to_string());
        let updated_ms = inv
            .completed_at
            .unwrap_or(inv.created_at)
            .timestamp_millis();
        conn.execute(
            "INSERT INTO session_invocations
                (id, caller_session_id, callee_session_id, root_invocation_id, status, created_at_ms, updated_at_ms, json_blob)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                callee_session_id = excluded.callee_session_id,
                status = excluded.status,
                updated_at_ms = excluded.updated_at_ms,
                json_blob = excluded.json_blob",
            params![
                inv.id,
                inv.caller_session_id.to_string(),
                inv.callee_session_id.map(|u| u.to_string()),
                inv.root_invocation_id,
                status_str,
                inv.created_at.timestamp_millis(),
                updated_ms,
                blob
            ],
        )?;
        Ok(())
    }

    pub fn load_invocations(&self, limit: usize) -> Result<Vec<MeshInvocationInfo>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT json_blob FROM session_invocations ORDER BY created_at_ms DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for blob in rows.flatten() {
            if let Ok(inv) = serde_json::from_str::<MeshInvocationInfo>(&blob) {
                out.push(inv);
            }
        }
        Ok(out)
    }
}

fn build_match_snippet(text: &str, query: &str, max_chars: usize) -> String {
    let clean = text.replace('\n', " ");
    let lower_text = clean.to_lowercase();
    let lower_q = query.to_lowercase();
    if let Some(byte_pos) = lower_text.find(&lower_q) {
        let char_pos = lower_text[..byte_pos].chars().count();
        let start = char_pos.saturating_sub(36);
        let slice: String = clean.chars().skip(start).take(max_chars).collect();
        if start > 0 {
            format!("…{}", slice)
        } else {
            slice
        }
    } else {
        clean.chars().take(max_chars).collect()
    }
}
