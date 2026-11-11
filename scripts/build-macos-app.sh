#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/Velo.app"
MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"

echo "⚡ [1/4] Building Velo Desktop UI (React 19 + Tailwind CSS v4)..."
(cd "${ROOT_DIR}/apps/velo-desktop" && npm run build)

echo "🦀 [2/4] Compiling Release Velo Daemon & CLI (cargo build --release -p velo-cli)..."
(cd "${ROOT_DIR}" && cargo build --release -p velo-cli)

echo "🍎 [3/4] Compiling Native macOS WKWebView Shell (swiftc -O)..."
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"
swiftc -O \
  "${ROOT_DIR}/apps/velo-desktop/macos-shell/VeloApp.swift" \
  -framework Cocoa \
  -framework WebKit \
  -o "${MACOS_DIR}/Velo"

echo "📦 [4/4] Packaging Standalone Velo.app Bundle (Zero Source-Tree Dependency)..."
cp "${ROOT_DIR}/target/release/velo" "${MACOS_DIR}/velo-daemon"
chmod +x "${MACOS_DIR}/Velo" "${MACOS_DIR}/velo-daemon"
rm -rf "${RESOURCES_DIR}/dist"
cp -R "${ROOT_DIR}/apps/velo-desktop/dist" "${RESOURCES_DIR}/dist"

echo "✅ Standalone Release Bundle ready at: ${APP_BUNDLE}"
ls -lh "${MACOS_DIR}/Velo" "${MACOS_DIR}/velo-daemon"
