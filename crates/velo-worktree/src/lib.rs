use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tracing::{debug, info, warn};
use uuid::Uuid;
use velo_protocol::GitDiffStats;

const DEFAULT_ENV_FILES: &[&str] = &[".env", ".env.local", ".env.development", ".env.test"];
const SHARED_DEP_DIRS: &[&str] = &["node_modules", ".venv", "venv"];

#[derive(Debug, Clone)]
pub struct SetupHookResult {
    pub command: String,
    pub output: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone)]
pub struct WorktreeProvision {
    pub repo_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub is_isolated_worktree: bool,
}

/// Manages isolated Git worktrees under `~/.velo/worktrees/`.
#[derive(Debug, Clone)]
pub struct WorktreeManager {
    base_dir: PathBuf,
}

impl Default for WorktreeManager {
    fn default() -> Self {
        Self::new(default_velo_home().join("worktrees"))
    }
}

pub fn default_velo_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".velo")
}

/// Returns the default general workspace (`~/.velo/workspace`), creating it if needed.
pub fn default_general_workspace() -> PathBuf {
    let dir = default_velo_home().join("workspace");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Expands empty paths, `"default"`, or leading `~/` references into concrete filesystem paths.
pub fn expand_tilde_path(raw: &Path) -> PathBuf {
    let s = raw.to_string_lossy();
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed == "default" || trimmed == "~/.velo/workspace" {
        return default_general_workspace();
    }
    if trimmed == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    raw.to_path_buf()
}

/// Ensures `path` resolves to an existing directory, auto-creating it or falling back to `~/.velo/workspace`.
pub async fn ensure_usable_workspace_dir(path: &Path) -> PathBuf {
    let expanded = expand_tilde_path(path);
    if tokio::fs::metadata(&expanded)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return expanded;
    }

    if tokio::fs::create_dir_all(&expanded).await.is_ok() {
        info!("Auto-created missing workspace directory: {}", expanded.display());
        return expanded;
    }

    let fallback = default_general_workspace();
    let _ = tokio::fs::create_dir_all(&fallback).await;
    warn!(
        "Workspace `{}` could not be created; falling back to {}",
        expanded.display(),
        fallback.display()
    );
    fallback
}

impl WorktreeManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Resolves the top-level Git repository root for `path`.
    pub async fn resolve_repo_root(path: &Path) -> Result<PathBuf> {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .await
            .context("Failed to execute git rev-parse")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Not a valid git repository ({}): {}", path.display(), stderr.trim());
        }

        let root_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(PathBuf::from(root_str))
    }

    /// Resolves an in-place workspace directly inside the real repository root (no isolated Git worktree).
    /// This ensures normal interactive sessions belong natively to the user's real project directory.
    pub async fn resolve_in_place_workspace(repo_path: &Path) -> WorktreeProvision {
        let usable_path = ensure_usable_workspace_dir(repo_path).await;
        let repo_root = match Self::resolve_repo_root(&usable_path).await {
            Ok(root) => root,
            Err(_) => usable_path,
        };

        let detected_branch = match Command::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if b.is_empty() {
                    "main".to_string()
                } else {
                    b
                }
            }
            _ => "main".to_string(),
        };

        WorktreeProvision {
            repo_root: repo_root.clone(),
            worktree_path: repo_root,
            branch: detected_branch,
            is_isolated_worktree: false,
        }
    }

    /// Provisions an isolated Git worktree for a session, or falls back to the directory if git is unavailable.
    pub async fn provision_worktree(
        &self,
        repo_path: &Path,
        session_id: Uuid,
        requested_branch: Option<&str>,
    ) -> Result<WorktreeProvision> {
        let repo_root = match Self::resolve_repo_root(repo_path).await {
            Ok(root) => root,
            Err(err) => {
                warn!("Using direct directory (git repo not detected): {}", err);
                return Ok(WorktreeProvision {
                    repo_root: repo_path.to_path_buf(),
                    worktree_path: repo_path.to_path_buf(),
                    branch: requested_branch.unwrap_or("main").to_string(),
                    is_isolated_worktree: false,
                });
            }
        };

        let short_id = &session_id.to_string()[..8];
        let branch = requested_branch
            .map(|b| b.to_string())
            .unwrap_or_else(|| format!("velo/agent-{}", short_id));

        let repo_name = repo_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("repo");

        let sanitized_branch = branch.replace('/', "-");
        let worktree_dir = self
            .base_dir
            .join(repo_name)
            .join(format!("{}-{}", sanitized_branch, short_id));

        if let Some(parent) = worktree_dir.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Check if the repo has at least one commit (HEAD exists)
        let head_check = Command::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args(["rev-parse", "--verify", "HEAD"])
            .output()
            .await?;

        if !head_check.status.success() {
            warn!("Repository has no commits yet; running directly in repo root");
            return Ok(WorktreeProvision {
                repo_root: repo_root.clone(),
                worktree_path: repo_root,
                branch,
                is_isolated_worktree: false,
            });
        }

        // If the requested branch is the primary workspace branch ("main" or "master"),
        // run directly inside repo_root so the user works against their live workspace without git worktree lock conflicts.
        if matches!(branch.as_str(), "main" | "master") {
            info!(
                "Session targets primary branch '{}'; running directly in repo root {}",
                branch,
                repo_root.display()
            );
            return Ok(WorktreeProvision {
                repo_root: repo_root.clone(),
                worktree_path: repo_root,
                branch,
                is_isolated_worktree: false,
            });
        }

        // Try creating worktree with a new branch `-b <branch>`, or attach to existing branch if it exists
        let create_new = Command::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args(["worktree", "add", "-b", &branch])
            .arg(&worktree_dir)
            .output()
            .await?;

        if !create_new.status.success() {
            debug!(
                "Branch {} may already exist, attempting worktree checkout without -b",
                branch
            );
            let attach_existing = Command::new("git")
                .arg("-C")
                .arg(&repo_root)
                .args(["worktree", "add", "--force"])
                .arg(&worktree_dir)
                .arg(&branch)
                .output()
                .await?;

            if !attach_existing.status.success() {
                let stderr = String::from_utf8_lossy(&attach_existing.stderr);
                warn!(
                    "Could not create isolated worktree for branch '{}' ({}); falling back to repo root {}",
                    branch,
                    stderr.trim(),
                    repo_root.display()
                );
                return Ok(WorktreeProvision {
                    repo_root: repo_root.clone(),
                    worktree_path: repo_root,
                    branch,
                    is_isolated_worktree: false,
                });
            }
        }

        info!(
            "Provisioned isolated git worktree at {} (branch: {})",
            worktree_dir.display(),
            branch
        );

        self.sync_worktree_include_files(&repo_root, &worktree_dir)
            .await?;
        self.symlink_shared_dependencies(&repo_root, &worktree_dir)
            .await;

        Ok(WorktreeProvision {
            repo_root,
            worktree_path: worktree_dir,
            branch,
            is_isolated_worktree: true,
        })
    }

    /// Symlinks heavy untracked dependency directories (`node_modules`, `.venv`, `venv`)
    /// from `repo_root` into `worktree_dir` so newly created worktrees can run tests & dev servers immediately.
    async fn symlink_shared_dependencies(&self, repo_root: &Path, worktree_dir: &Path) {
        for dir_name in SHARED_DEP_DIRS {
            let src = repo_root.join(dir_name);
            let dst = worktree_dir.join(dir_name);
            if !tokio::fs::try_exists(&src).await.unwrap_or(false) {
                continue;
            }
            if tokio::fs::symlink_metadata(&dst).await.is_ok() {
                continue;
            }
            // Only symlink if the directory is untracked/ignored by git
            let tracked = Command::new("git")
                .arg("-C")
                .arg(repo_root)
                .args(["ls-files", "--error-unmatch", dir_name])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false);
            if tracked {
                continue;
            }
            #[cfg(unix)]
            {
                if let Err(err) = std::os::unix::fs::symlink(&src, &dst) {
                    warn!("Failed to symlink {} into worktree: {}", dir_name, err);
                } else {
                    info!("Symlinked shared {} into worktree {}", dir_name, worktree_dir.display());
                }
            }
        }
    }

    /// Discovers (`.velo/setup.sh`, `.worktreesetup`, `.paseo/setup.sh`) or runs an explicit setup hook
    /// inside an isolated worktree after provisioning.
    pub async fn run_setup_hook(
        repo_root: &Path,
        worktree_path: &Path,
        branch: &str,
        explicit_command: Option<&str>,
    ) -> Option<SetupHookResult> {
        let cmd_str = if let Some(cmd) = explicit_command.map(str::trim).filter(|s| !s.is_empty()) {
            cmd.to_string()
        } else {
            let candidates = [".velo/setup.sh", ".worktreesetup", ".paseo/setup.sh"];
            let mut found = None;
            for rel in candidates {
                let candidate_in_wt = worktree_path.join(rel);
                let candidate_in_root = repo_root.join(rel);
                if tokio::fs::try_exists(&candidate_in_wt).await.unwrap_or(false) {
                    found = Some(format!("sh \"{}\"", candidate_in_wt.display()));
                    break;
                } else if tokio::fs::try_exists(&candidate_in_root).await.unwrap_or(false) {
                    found = Some(format!("sh \"{}\"", candidate_in_root.display()));
                    break;
                }
            }
            found?
        };

        info!(
            "Running worktree setup hook `{}` in {}",
            cmd_str,
            worktree_path.display()
        );
        let aug_path = format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string())
        );
        match Command::new("sh")
            .args(["-c", &cmd_str])
            .current_dir(worktree_path)
            .env("PATH", aug_path)
            .env("VELO_REPO_ROOT", repo_root.as_os_str())
            .env("VELO_WORKTREE_PATH", worktree_path.as_os_str())
            .env("VELO_BRANCH", branch)
            .output()
            .await
        {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                let combined = if stderr.trim().is_empty() {
                    stdout.trim().to_string()
                } else if stdout.trim().is_empty() {
                    stderr.trim().to_string()
                } else {
                    format!("{}\n{}", stdout.trim(), stderr.trim())
                };
                Some(SetupHookResult {
                    command: cmd_str,
                    output: combined,
                    exit_code: out.status.code().unwrap_or(-1),
                })
            }
            Err(err) => Some(SetupHookResult {
                command: cmd_str,
                output: format!("Failed to spawn setup hook: {}", err),
                exit_code: -1,
            }),
        }
    }

    /// Copies untracked environment files specified in `.worktreeinclude` or defaults (`.env*`)
    /// so agents have immediate access to local secrets/configs inside their worktree.
    async fn sync_worktree_include_files(&self, repo_root: &Path, worktree_dir: &Path) -> Result<()> {
        let mut files_to_copy: Vec<String> = DEFAULT_ENV_FILES.iter().map(|s| s.to_string()).collect();

        let include_file = repo_root.join(".worktreeinclude");
        if tokio::fs::try_exists(&include_file).await.unwrap_or(false) {
            if let Ok(content) = tokio::fs::read_to_string(&include_file).await {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('#') {
                        files_to_copy.push(trimmed.to_string());
                    }
                }
            }
        }

        for rel_path in files_to_copy {
            let src = repo_root.join(&rel_path);
            let dst = worktree_dir.join(&rel_path);
            if tokio::fs::try_exists(&src).await.unwrap_or(false) {
                if let Some(parent) = dst.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                if let Err(err) = tokio::fs::copy(&src, &dst).await {
                    warn!("Failed to copy {} into worktree: {}", rel_path, err);
                } else {
                    debug!("Synced {} into worktree", rel_path);
                }
            }
        }

        Ok(())
    }

    /// Canonical Git empty-tree hash used as diff base for freshly initialized repos with no HEAD commit yet.
    const EMPTY_TREE_SHA: &'static str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const MAX_UNTRACKED_FILES: usize = 80;
    const MAX_UNTRACKED_FILE_BYTES: u64 = 256 * 1024;
    const MAX_UNTRACKED_DIFF_LINES: usize = 1200;

    /// Returns true if `path` is inside a Git work tree.
    async fn is_git_repo(path: &Path) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .await
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
            .unwrap_or(false)
    }

    /// Resolves the best Git diff base ref:
    /// 1. Fresh `git init` repo with no `HEAD` yet -> `EMPTY_TREE_SHA`.
    /// 2. Working tree has uncommitted tracked/untracked changes -> `"HEAD"`.
    /// 3. Working tree is clean on a non-default feature/worktree branch -> `merge-base(<default>, HEAD)`
    ///    so committed changes on a worktree branch stay visible in `+X -Y` and the Diff drawer.
    async fn resolve_diff_base(worktree_path: &Path, has_dirty_working_tree: bool) -> String {
        let head_ok = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !head_ok {
            return Self::EMPTY_TREE_SHA.to_string();
        }
        if has_dirty_working_tree {
            return "HEAD".to_string();
        }

        // Clean working tree: if on a feature/worktree branch ahead of main/master, diff against merge-base
        let cur_branch = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        if !cur_branch.is_empty()
            && cur_branch != "main"
            && cur_branch != "master"
            && cur_branch != "HEAD"
        {
            let head_sha = Command::new("git")
                .arg("-C")
                .arg(worktree_path)
                .args(["rev-parse", "HEAD"])
                .output()
                .await
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            for candidate in ["main", "master", "origin/main", "origin/master"] {
                if let Ok(mb) = Command::new("git")
                    .arg("-C")
                    .arg(worktree_path)
                    .args(["merge-base", candidate, "HEAD"])
                    .output()
                    .await
                {
                    if mb.status.success() {
                        let base_sha = String::from_utf8_lossy(&mb.stdout).trim().to_string();
                        if !base_sha.is_empty() && base_sha != head_sha {
                            return base_sha;
                        }
                    }
                }
            }
        }

        "HEAD".to_string()
    }

    /// Skips sensitive/OS noise files (`.env*` secrets auto-synced into worktrees, `.DS_Store`) from untracked diffs.
    fn is_ignored_untracked_noise(rel_path: &str) -> bool {
        let base = rel_path.rsplit('/').next().unwrap_or(rel_path);
        if base == ".DS_Store" || base == "Thumbs.db" {
            return true;
        }
        if base == ".env" || base.starts_with(".env.") {
            let lower = base.to_lowercase();
            let is_template = lower.ends_with(".example")
                || lower.ends_with(".sample")
                || lower.ends_with(".template");
            return !is_template;
        }
        false
    }

    /// Lists non-ignored untracked files (`git ls-files --others --exclude-standard`), capped for safety.
    async fn list_untracked_files(worktree_path: &Path) -> Vec<String> {
        let out = match Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["ls-files", "--others", "--exclude-standard"])
            .output()
            .await
        {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !Self::is_ignored_untracked_noise(l))
            .take(Self::MAX_UNTRACKED_FILES)
            .collect()
    }

    /// Reads an untracked text file safely (skips directories, binaries containing NUL, and files >256KB).
    async fn read_untracked_text_lines(worktree_path: &Path, rel_path: &str) -> Option<Vec<String>> {
        let full_path = worktree_path.join(rel_path);
        let meta = tokio::fs::metadata(&full_path).await.ok()?;
        if !meta.is_file() || meta.len() > Self::MAX_UNTRACKED_FILE_BYTES {
            return None;
        }
        let bytes = tokio::fs::read(&full_path).await.ok()?;
        // Skip binary files (NUL byte check in first 8KB)
        let probe_len = bytes.len().min(8192);
        if bytes[..probe_len].contains(&0) {
            return None;
        }
        let text = String::from_utf8_lossy(&bytes);
        Some(text.lines().map(|l| l.to_string()).collect())
    }

    /// Computes live diff stats (modified files, insertions, deletions) inside a worktree.
    /// Accurately includes:
    /// - Tracked unstaged & staged edits (`git diff <base> --numstat`)
    /// - Untracked new text files (respecting `.gitignore`)
    /// - Fresh `git init` repos before their first commit (`EMPTY_TREE_SHA`)
    /// - Committed feature/worktree branch diffs against `merge-base(main, HEAD)` when working tree is clean
    pub async fn compute_diff_stats(worktree_path: &Path) -> Result<GitDiffStats> {
        if !Self::is_git_repo(worktree_path).await {
            return Ok(GitDiffStats::default());
        }

        let status_out = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["status", "--porcelain", "-uall"])
            .output()
            .await?;

        if !status_out.status.success() {
            return Ok(GitDiffStats::default());
        }

        let status_str = String::from_utf8_lossy(&status_out.stdout);
        let mut modified_files: Vec<String> = Vec::new();
        for line in status_str.lines() {
            if line.len() > 3 {
                let raw = line[3..].trim();
                // Handle renames (`old -> new`) cleanly
                let path = raw
                    .rsplit_once(" -> ")
                    .map(|(_, new_p)| new_p)
                    .unwrap_or(raw)
                    .trim_matches('"')
                    .to_string();
                if !path.is_empty() && !modified_files.contains(&path) {
                    modified_files.push(path);
                }
            }
        }

        let has_dirty = !modified_files.is_empty();
        let base_ref = Self::resolve_diff_base(worktree_path, has_dirty).await;

        let mut insertions = 0usize;
        let mut deletions = 0usize;

        let numstat_out = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["diff", &base_ref, "--numstat"])
            .output()
            .await?;

        if numstat_out.status.success() {
            let numstat_str = String::from_utf8_lossy(&numstat_out.stdout);
            for line in numstat_str.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 3 {
                    insertions += parts[0].trim().parse::<usize>().unwrap_or(0);
                    deletions += parts[1].trim().parse::<usize>().unwrap_or(0);
                    let fpath = parts[2].trim().to_string();
                    if !fpath.is_empty() && !modified_files.contains(&fpath) {
                        modified_files.push(fpath);
                    }
                }
            }
        }

        // Count untracked non-ignored new text files so freshly written files never show `+0 -0`
        let untracked = Self::list_untracked_files(worktree_path).await;
        for rel in untracked {
            if !modified_files.contains(&rel) {
                modified_files.push(rel.clone());
            }
            if let Some(lines) = Self::read_untracked_text_lines(worktree_path, &rel).await {
                insertions += lines.len();
            }
        }

        Ok(GitDiffStats {
            files_changed: modified_files.len(),
            insertions,
            deletions,
            modified_files,
        })
    }

    /// Returns the full unified git diff for a session's worktree, including:
    /// - Tracked unstaged & staged changes (or committed worktree branch diff vs `merge-base`)
    /// - Synthetic `new file mode 100644` unified diffs for untracked text files (respecting `.gitignore`)
    pub async fn get_unified_diff(worktree_path: &Path) -> Result<String> {
        if !Self::is_git_repo(worktree_path).await {
            return Ok(String::new());
        }

        let status_dirty = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["status", "--porcelain"])
            .output()
            .await
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false);

        let base_ref = Self::resolve_diff_base(worktree_path, status_dirty).await;

        let output = Command::new("git")
            .arg("-C")
            .arg(worktree_path)
            .args(["diff", &base_ref])
            .output()
            .await
            .context("Failed to run git diff")?;

        let mut combined = String::from_utf8_lossy(&output.stdout).to_string();

        // Append standard unified diff blocks for untracked new text files
        let untracked = Self::list_untracked_files(worktree_path).await;
        for rel in untracked {
            let Some(lines) = Self::read_untracked_text_lines(worktree_path, &rel).await else {
                continue;
            };
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            let total = lines.len();
            let shown = total.min(Self::MAX_UNTRACKED_DIFF_LINES);
            combined.push_str(&format!(
                "diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n"
            ));
            if shown > 0 {
                combined.push_str(&format!("@@ -0,0 +1,{shown} @@\n"));
                for line in lines.iter().take(shown) {
                    combined.push('+');
                    combined.push_str(line);
                    combined.push('\n');
                }
                if total > shown {
                    combined.push_str(&format!(
                        "+// ... ({} more lines omitted from preview)\n",
                        total - shown
                    ));
                }
            }
        }

        Ok(combined)
    }

    /// Removes an isolated worktree cleanly.
    pub async fn remove_worktree(&self, repo_root: &Path, worktree_path: &Path) -> Result<()> {
        if repo_root == worktree_path {
            return Ok(());
        }

        let output = Command::new("git")
            .arg("-C")
            .arg(repo_root)
            .args(["worktree", "remove", "--force"])
            .arg(worktree_path)
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("git worktree remove warning: {}", stderr.trim());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_worktree_provision_env_sync_and_diff() -> Result<()> {
        let temp_base = std::env::temp_dir().join(format!("velo-wt-test-{}", Uuid::new_v4()));
        let repo_dir = temp_base.join("sample-repo");
        let wt_store = temp_base.join("worktrees");
        tokio::fs::create_dir_all(&repo_dir).await?;

        // Initialize git repo and make initial commit
        Command::new("git").arg("init").current_dir(&repo_dir).output().await?;
        Command::new("git")
            .args(["config", "user.email", "test@velo.dev"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["config", "user.name", "Velo Test"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        tokio::fs::write(repo_dir.join("README.md"), "# Sample\n").await?;
        tokio::fs::write(repo_dir.join(".env"), "SECRET_KEY=velo123\n").await?;
        Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        let mgr = WorktreeManager::new(wt_store);
        let sid = Uuid::new_v4();
        let prov = mgr
            .provision_worktree(&repo_dir, sid, Some("feat/test-branch"))
            .await?;

        assert!(prov.is_isolated_worktree);
        assert_eq!(prov.branch, "feat/test-branch");
        // Verify .env was automatically synced to isolated worktree
        let env_copied = tokio::fs::read_to_string(prov.worktree_path.join(".env")).await?;
        assert_eq!(env_copied, "SECRET_KEY=velo123\n");

        // Modify a tracked file inside the worktree and verify diff stats
        tokio::fs::write(
            prov.worktree_path.join("README.md"),
            "# Sample\nAdded by Velo agent\n",
        )
        .await?;

        let stats = WorktreeManager::compute_diff_stats(&prov.worktree_path).await?;
        assert!(stats.files_changed >= 1);
        assert_eq!(stats.insertions, 1);

        let diff_text = WorktreeManager::get_unified_diff(&prov.worktree_path).await?;
        assert!(diff_text.contains("+Added by Velo agent"));

        mgr.remove_worktree(&prov.repo_root, &prov.worktree_path).await?;
        let _ = tokio::fs::remove_dir_all(&temp_base).await;
        Ok(())
    }

    #[tokio::test]
    async fn test_worktree_node_modules_symlink_and_setup_hook() -> Result<()> {
        let temp_base = std::env::temp_dir().join(format!("velo-wt-hook-{}", Uuid::new_v4()));
        let repo_dir = temp_base.join("app-repo");
        let wt_store = temp_base.join("worktrees");
        tokio::fs::create_dir_all(repo_dir.join("node_modules/pkg")).await?;
        tokio::fs::create_dir_all(repo_dir.join(".velo")).await?;
        tokio::fs::write(repo_dir.join("node_modules/pkg/index.js"), "module.exports = 42;\n").await?;
        tokio::fs::write(
            repo_dir.join(".velo/setup.sh"),
            "#!/bin/sh\necho \"bootstrapped:$VELO_BRANCH\" > .setup_done\n",
        )
        .await?;

        Command::new("git").arg("init").current_dir(&repo_dir).output().await?;
        Command::new("git")
            .args(["config", "user.email", "test@velo.dev"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["config", "user.name", "Velo Test"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        tokio::fs::write(repo_dir.join(".gitignore"), "node_modules/\n.setup_done\n").await?;
        Command::new("git")
            .args(["add", ".gitignore", ".velo/setup.sh"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        let mgr = WorktreeManager::new(wt_store);
        let prov = mgr
            .provision_worktree(&repo_dir, Uuid::new_v4(), Some("feat/hook-test"))
            .await?;

        // Verify node_modules was symlinked automatically
        let nm_meta = tokio::fs::symlink_metadata(prov.worktree_path.join("node_modules")).await?;
        assert!(nm_meta.file_type().is_symlink());

        // Verify .velo/setup.sh auto-discovery & execution
        let hook_res = WorktreeManager::run_setup_hook(
            &prov.repo_root,
            &prov.worktree_path,
            &prov.branch,
            None,
        )
        .await
        .expect("setup hook discovered");
        assert_eq!(hook_res.exit_code, 0);
        let marker = tokio::fs::read_to_string(prov.worktree_path.join(".setup_done")).await?;
        assert_eq!(marker.trim(), "bootstrapped:feat/hook-test");

        mgr.remove_worktree(&prov.repo_root, &prov.worktree_path).await?;
        let _ = tokio::fs::remove_dir_all(&temp_base).await;
        Ok(())
    }

    #[tokio::test]
    async fn test_untracked_no_head_and_committed_worktree_diff() -> Result<()> {
        let temp_base = std::env::temp_dir().join(format!("velo-diff-test-{}", Uuid::new_v4()));
        let repo_dir = temp_base.join("fresh-repo");
        tokio::fs::create_dir_all(repo_dir.join("server")).await?;

        // 1. Fresh `git init` with NO HEAD commit yet + untracked nested file
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["config", "user.email", "test@velo.dev"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["config", "user.name", "Velo Test"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        tokio::fs::write(
            repo_dir.join("server/index.ts"),
            "export const hello = 'world';\nconsole.log(hello);\n",
        )
        .await?;

        let stats_no_head = WorktreeManager::compute_diff_stats(&repo_dir).await?;
        assert_eq!(stats_no_head.files_changed, 1);
        assert_eq!(stats_no_head.insertions, 2);
        assert_eq!(stats_no_head.deletions, 0);

        let diff_no_head = WorktreeManager::get_unified_diff(&repo_dir).await?;
        assert!(diff_no_head.contains("diff --git a/server/index.ts b/server/index.ts"));
        assert!(diff_no_head.contains("new file mode 100644"));
        assert!(diff_no_head.contains("+export const hello = 'world';"));

        // 2. Make initial commit on main, create a feature branch, commit changes -> clean working tree
        Command::new("git")
            .args(["add", "."])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["checkout", "-b", "feat/demo"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        tokio::fs::write(repo_dir.join("notes.txt"), "line1\nline2\nline3\n").await?;
        Command::new("git")
            .args(["add", "notes.txt"])
            .current_dir(&repo_dir)
            .output()
            .await?;
        Command::new("git")
            .args(["commit", "-m", "add notes"])
            .current_dir(&repo_dir)
            .output()
            .await?;

        // Even after commit (clean working tree), feature branch shows committed diff vs main!
        let stats_committed = WorktreeManager::compute_diff_stats(&repo_dir).await?;
        assert_eq!(stats_committed.files_changed, 1);
        assert_eq!(stats_committed.insertions, 3);
        let diff_committed = WorktreeManager::get_unified_diff(&repo_dir).await?;
        assert!(diff_committed.contains("diff --git a/notes.txt b/notes.txt"));
        assert!(diff_committed.contains("+line3"));

        let _ = tokio::fs::remove_dir_all(&temp_base).await;
        Ok(())
    }
}
