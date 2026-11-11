use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use velo_agent::discover_augmented_path;

#[derive(Debug, Clone, Deserialize)]
pub struct CreatePrRequest {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub base: Option<String>,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MergePrRequest {
    /// "squash" | "merge" | "rebase"
    #[serde(default = "default_merge_method")]
    pub method: String,
}

fn default_merge_method() -> String {
    "squash".to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct PrCheckSummary {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub details_url: Option<String>,
}

pub async fn get_pr_status(worktree_path: &Path) -> Value {
    let aug_path = discover_augmented_path();
    let fields = "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,baseRefName,additions,deletions,comments";
    let out = Command::new("gh")
        .args(["pr", "view", "--json", fields])
        .current_dir(worktree_path)
        .env("PATH", &aug_path)
        .output()
        .await;

    match out {
        Ok(res) if res.status.success() => {
            let stdout = String::from_utf8_lossy(&res.stdout);
            if let Ok(pr_val) = serde_json::from_str::<Value>(&stdout) {
                let checks = extract_normalized_checks(&pr_val);
                return json!({
                    "ok": true,
                    "exists": true,
                    "pr": pr_val,
                    "checks": checks,
                });
            }
            json!({ "ok": true, "exists": false })
        }
        Ok(res) => {
            let stderr = String::from_utf8_lossy(&res.stderr).trim().to_string();
            let no_pr = stderr.contains("no pull requests found")
                || stderr.contains("Could not resolve to a PullRequest");
            json!({
                "ok": true,
                "exists": false,
                "message": if no_pr { "No pull request open for this branch yet.".to_string() } else { stderr }
            })
        }
        Err(err) => json!({
            "ok": false,
            "exists": false,
            "error": format!("GitHub CLI (`gh`) unavailable: {}", err)
        }),
    }
}

fn extract_normalized_checks(pr_val: &Value) -> Vec<PrCheckSummary> {
    let mut list = Vec::new();
    if let Some(arr) = pr_val.get("statusCheckRollup").and_then(|v| v.as_array()) {
        for item in arr {
            let name = item
                .get("name")
                .or_else(|| item.get("context"))
                .and_then(|v| v.as_str())
                .unwrap_or("check")
                .to_string();
            let status = item
                .get("status")
                .or_else(|| item.get("state"))
                .and_then(|v| v.as_str())
                .unwrap_or("COMPLETED")
                .to_uppercase();
            let conclusion = item
                .get("conclusion")
                .or_else(|| item.get("state"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_uppercase();
            let details_url = item
                .get("detailsUrl")
                .or_else(|| item.get("targetUrl"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            list.push(PrCheckSummary {
                name,
                status,
                conclusion,
                details_url,
            });
        }
    }
    list
}

pub async fn create_pull_request(worktree_path: &Path, req: CreatePrRequest) -> Value {
    let aug_path = discover_augmented_path();

    // 1. Push current branch upstream first
    let push_out = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(worktree_path)
        .env("PATH", &aug_path)
        .output()
        .await;

    if let Ok(p) = &push_out {
        if !p.status.success() {
            let err_s = String::from_utf8_lossy(&p.stderr).trim().to_string();
            return json!({
                "ok": false,
                "error": format!("git push -u origin HEAD failed: {}", err_s)
            });
        }
    }

    // 2. Create PR via `gh pr create`
    let mut cmd = Command::new("gh");
    cmd.args([
        "pr",
        "create",
        "--title",
        req.title.trim(),
        "--body",
        &req.body,
    ]);
    if let Some(base) = req.base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.args(["--base", base]);
    }
    if req.draft {
        cmd.arg("--draft");
    }
    let out = cmd
        .current_dir(worktree_path)
        .env("PATH", &aug_path)
        .output()
        .await;

    match out {
        Ok(res) if res.status.success() => {
            let pr_url = String::from_utf8_lossy(&res.stdout).trim().to_string();
            let status = get_pr_status(worktree_path).await;
            json!({
                "ok": true,
                "url": pr_url,
                "status": status,
            })
        }
        Ok(res) => json!({
            "ok": false,
            "error": String::from_utf8_lossy(&res.stderr).trim().to_string()
        }),
        Err(err) => json!({
            "ok": false,
            "error": format!("Failed to invoke gh pr create: {}", err)
        }),
    }
}

pub async fn merge_pull_request(worktree_path: &Path, req: MergePrRequest) -> Value {
    let aug_path = discover_augmented_path();
    let flag = match req.method.as_str() {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    let out = Command::new("gh")
        .args(["pr", "merge", flag])
        .current_dir(worktree_path)
        .env("PATH", &aug_path)
        .output()
        .await;

    match out {
        Ok(res) if res.status.success() => json!({
            "ok": true,
            "output": String::from_utf8_lossy(&res.stdout).trim().to_string()
        }),
        Ok(res) => json!({
            "ok": false,
            "error": String::from_utf8_lossy(&res.stderr).trim().to_string()
        }),
        Err(err) => json!({
            "ok": false,
            "error": format!("Failed to invoke gh pr merge: {}", err)
        }),
    }
}

pub async fn get_pr_checks_report(worktree_path: &Path) -> Value {
    let aug_path = discover_augmented_path();
    let out = Command::new("gh")
        .args(["pr", "checks"])
        .current_dir(worktree_path)
        .env("PATH", &aug_path)
        .output()
        .await;

    match out {
        Ok(res) => {
            let stdout = String::from_utf8_lossy(&res.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&res.stderr).trim().to_string();
            json!({
                "ok": true,
                "report": if !stdout.is_empty() { stdout } else { stderr }
            })
        }
        Err(err) => json!({
            "ok": false,
            "error": err.to_string()
        }),
    }
}
