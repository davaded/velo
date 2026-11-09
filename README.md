# ⚡ Velo (`velo`)

**Velo** is a blazing-fast, native Rust control plane and orchestrator for parallel AI coding agents (`claude`, `codex`, `opencode`, and custom CLIs) backed by isolated Git worktrees.

## Workspace Architecture

- [`crates/velo-protocol`](./crates/velo-protocol): Unified `AgentEvent` stream protocol, RPC types, and WebSocket message envelopes.
- [`crates/velo-worktree`](./crates/velo-worktree): Automated Git worktree isolation engine (`~/.velo/worktrees/`), `.worktreeinclude` / `.env` file syncing, and live diff calculation.
- [`crates/velo-agent`](./crates/velo-agent): Dual-channel agent process supervisor supporting both structured NDJSON streams (`claude -p --output-format stream-json`) and full interactive PTY (`portable-pty`).
- [`crates/velo-daemon`](./crates/velo-daemon): Tokio + Axum background daemon managing sessions, real-time WebSocket event broadcasting, and cross-agent `/handoff`.
- [`crates/velo-cli`](./crates/velo-cli): Single-binary `velo` CLI with embedded daemon auto-start.

## Quick Start

```bash
# Build workspace
cargo build

# Check daemon status (or start with `velo up`)
./target/debug/velo up

# Run a coding agent in an isolated Git worktree
./target/debug/velo run --agent claude --branch feat/auth "Implement JWT middleware"

# List all active sessions & worktree diffs
./target/debug/velo ps

# Stream structured logs or inspect worktree diff
./target/debug/velo logs <session-id> --follow
./target/debug/velo diff <session-id>

# Hand off a session's branch & worktree to another agent
./target/debug/velo handoff <session-id> --to codex
```
