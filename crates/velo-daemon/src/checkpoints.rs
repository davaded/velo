use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnCheckpointDto {
    pub id: String,
    pub turn_index: usize,
    pub prompt_preview: String,
    pub git_ref: String,
    pub head_short: String,
    pub had_dirty_changes: bool,
    pub created_at: DateTime<Utc>,
}

fn checkpoints_file(session_id: Uuid) -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join(".velo/checkpoints").join(format!("{session_id}.json")))
}

pub fn list_checkpoints(session_id: Uuid) -> Vec<TurnCheckpointDto> {
    let Some(path) = checkpoints_file(session_id) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<TurnCheckpointDto>>(&s).ok())
        .unwrap_or_default()
}

fn save_checkpoints(session_id: Uuid, items: &[TurnCheckpointDto]) {
    let Some(path) = checkpoints_file(session_id) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(items) {
        let _ = fs::write(path, raw);
    }
}

fn git_stdout(repo_path: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Captures a lightweight, non-invasive Git snapshot (`git stash create` or `HEAD`) before a turn mutates files.
/// Never touches the working tree, staging index, or user's visible `git stash list`.
pub fn capture_turn_checkpoint(
    session_id: Uuid,
    repo_path: &Path,
    prompt_preview: &str,
) -> Option<TurnCheckpointDto> {
    if !repo_path.is_dir() {
        return None;
    }
    // Verify it is a Git repository
    let inside = git_stdout(repo_path, &["rev-parse", "--is-inside-work-tree"])?;
    if inside != "true" {
        return None;
    }
    let head_full = git_stdout(repo_path, &["rev-parse", "HEAD"])?;
    let head_short = head_full.chars().take(7).collect::<String>();

    // `git stash create` produces a commit hash capturing tracked dirty state without altering the repo
    let stash_obj = git_stdout(repo_path, &["stash", "create", "velo-turn-checkpoint"]);
    let (git_ref, had_dirty_changes) = match stash_obj {
        Some(obj) => (obj, true),
        None => (head_full, false),
    };

    let mut list = list_checkpoints(session_id);
    let next_idx = list.last().map(|c| c.turn_index + 1).unwrap_or(1);
    let clean_preview: String = prompt_preview
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("执行前快照")
        .chars()
        .take(56)
        .collect();

    let cp = TurnCheckpointDto {
        id: format!("cp-{}", &Uuid::new_v4().simple().to_string()[..8]),
        turn_index: next_idx,
        prompt_preview: clean_preview,
        git_ref,
        head_short,
        had_dirty_changes,
        created_at: Utc::now(),
    };
    list.push(cp.clone());
    if list.len() > 25 {
        let drop_n = list.len() - 25;
        list.drain(0..drop_n);
    }
    save_checkpoints(session_id, &list);
    Some(cp)
}

/// Safely rewinds tracked workspace files back to the exact pre-turn Git snapshot.
pub fn rewind_to_checkpoint(
    session_id: Uuid,
    checkpoint_id: &str,
    repo_path: &Path,
) -> anyhow::Result<TurnCheckpointDto> {
    if !repo_path.is_dir() {
        anyhow::bail!("Workspace directory does not exist");
    }
    let list = list_checkpoints(session_id);
    let Some(target) = list.into_iter().find(|c| c.id == checkpoint_id) else {
        anyhow::bail!("Checkpoint `{}` not found", checkpoint_id);
    };

    // Verify commit object still exists in Git object store
    let verify = Command::new("git")
        .args(["cat-file", "-e", &format!("{}^{{commit}}", target.git_ref)])
        .current_dir(repo_path)
        .status()?;
    if !verify.success() {
        anyhow::bail!("Git snapshot `{}` is no longer available in object store", target.git_ref);
    }

    // Capture a safety backup checkpoint of the current state before rewinding so rewind is reversible!
    let _ = capture_turn_checkpoint(
        session_id,
        repo_path,
        &format!("回滚到第 {} 轮前自动备份", target.turn_index),
    );

    let out = Command::new("git")
        .args(["checkout", &target.git_ref, "--", "."])
        .current_dir(repo_path)
        .output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("Git rewind failed: {}", err.trim());
    }

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checkpoint_capture_and_rewind_in_temp_git_repo() {
        let dir = std::env::temp_dir().join(format!("velo-cp-test-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let st = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .status()
                .unwrap();
            assert!(st.success(), "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@velo.dev"]);
        run(&["config", "user.name", "Velo Test"]);
        fs::write(dir.join("hello.txt"), "v1\n").unwrap();
        run(&["add", "hello.txt"]);
        run(&["commit", "-q", "-m", "init"]);

        // Dirty v2 before turn
        fs::write(dir.join("hello.txt"), "v2\n").unwrap();
        let sid = Uuid::new_v4();
        let cp = capture_turn_checkpoint(sid, &dir, "修改 hello.txt 到 v3").expect("checkpoint");
        assert!(cp.had_dirty_changes);

        // Agent edits file to v3
        fs::write(dir.join("hello.txt"), "v3 broken\n").unwrap();
        assert_eq!(fs::read_to_string(dir.join("hello.txt")).unwrap(), "v3 broken\n");

        // Rewind restores v2!
        let restored = rewind_to_checkpoint(sid, &cp.id, &dir).expect("rewind");
        assert_eq!(restored.id, cp.id);
        assert_eq!(fs::read_to_string(dir.join("hello.txt")).unwrap(), "v2\n");

        let _ = fs::remove_dir_all(&dir);
        if let Some(p) = checkpoints_file(sid) {
            let _ = fs::remove_file(p);
        }
    }
}
