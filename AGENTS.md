# AGENTS.md

Repository guide for AI coding agents contributing to **Velo**.

## Workspace Structure

- `crates/velo-protocol` — Shared `AgentEvent`, session DTOs, and WebSocket/RPC protocol types.
- `crates/velo-worktree` — Git worktree provisioning, `.env` syncing, and unified diff calculation.
- `crates/velo-agent` — Native streaming drivers for Claude, Codex (`app-server`), Antigravity (`agy` ACP), Cursor, Grok, and `portable-pty`.
- `crates/velo-daemon` — Axum HTTP/WS control plane (`127.0.0.1:6767`), SQLite WAL store (`~/.velo/velo.db`), telemetry/pricing/quota engines, Git/PR automation, blind push, and E2EE relay bridge.
- `crates/velo-relay` — Zero-trust blind WebSocket relay (`X25519` + `ChaCha20-Poly1305`).
- `crates/velo-cli` — Unified `velo` CLI, stdio MCP server, and macOS `LaunchAgent` manager.
- `apps/velo-desktop` — React 19 + TypeScript + Tailwind CSS v4 frontend and native Swift `WKWebView` macOS shell (`macos-shell/VeloApp.swift`).
- `apps/velo-ios` — Native iOS 17+ SwiftUI app (`XcodeGen` project in `project.yml`) + WidgetKit Live Activities.

## Build & Test Commands

Use **`pnpm`** (never `npm` or `yarn`) inside `apps/velo-desktop`.

```bash
# Rust tests (full workspace)
cargo test --workspace

# Targeted Rust crate tests
cargo test -p velo-agent
cargo test -p velo-daemon
cargo test -p velo-worktree

# Desktop frontend typecheck & build
cd apps/velo-desktop && pnpm build

# Full macOS standalone bundle (Desktop UI + Rust release + Swift WKWebView -> /Applications/Velo.app + ~/.velo)
./scripts/build-macos-app.sh

# iOS unsigned build verification (requires Xcode + xcodegen)
cd apps/velo-ios && xcodegen generate && xcodebuild -project VeloMobile.xcodeproj -scheme VeloMobile -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

## Architecture & Engineering Guardrails

- **WKWebView 60fps Rule**: Never add `backdrop-filter` or `content-visibility: auto` to `.velo-chat-scroll` or scrolling message items. Keep animations GPU-only (`transform`, `opacity`).
- **Popovers & Overlays**: Avoid semi-transparent floating pickers/popovers where chat or sidebar text bleeds through; use opaque elevated `var(--v-bg-surface)` surfaces. Do not rely on `fixed inset-0` backdrops inside `backdrop-filter` ancestors—use `document.addEventListener("pointerdown", ..., true)` for click-outside dismissal.
- **Usage & Billing Accuracy**: Antigravity CLI emits cumulative conversation usage totals per step; `normalize_session_usage_turns` in `crates/velo-daemon/src/pricing.rs` converts cumulative snapshots into per-turn deltas. Keep pricing rate cards aligned with official API docs and preserve `~/.velo/pricing.json` hot-reload support.
- **Security**: Never log plaintext secrets, API keys, or E2EE session keys. Preserve zero-plaintext behavior on blind relay frames and Bark/Webhook wakeup notifications.
- **Verification**: Always run relevant `cargo test` and/or `pnpm build` (and `xcodebuild` if touching `apps/velo-ios`) before finishing a task.
