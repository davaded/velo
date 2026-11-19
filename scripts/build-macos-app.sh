#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/Velo.app"
MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"

echo "⚡ [1/5] Building Velo Desktop UI (React 19 + Tailwind CSS v4)..."
(cd "${ROOT_DIR}/apps/velo-desktop" && npm run build)

echo "🦀 [2/5] Compiling Release Velo Daemon & CLI (cargo build --release -p velo-cli)..."
(cd "${ROOT_DIR}" && cargo build --release -p velo-cli)

echo "🍎 [3/5] Compiling Native macOS WKWebView + Speech Shell (swiftc -O)..."
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"
cat > "${APP_BUNDLE}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Velo</string>
  <key>CFBundleDisplayName</key>
  <string>Velo</string>
  <key>CFBundleIdentifier</key>
  <string>dev.velo.desktop</string>
  <key>CFBundleShortVersionString</key>
  <string>0.6.0</string>
  <key>CFBundleVersion</key>
  <string>13</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Velo</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>用于录制语音指令并实时识别为对话输入</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>用于通过 macOS 原生语音引擎将语音实时识别为文字</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST
swiftc -O \
  "${ROOT_DIR}/apps/velo-desktop/macos-shell/VeloApp.swift" \
  -framework Cocoa \
  -framework WebKit \
  -framework AVFoundation \
  -framework Speech \
  -o "${MACOS_DIR}/Velo"

echo "📦 [4/5] Packaging Standalone Velo.app Bundle (Zero Source-Tree Dependency)..."
cp "${ROOT_DIR}/target/release/velo" "${MACOS_DIR}/velo-daemon.tmp"
chmod +x "${MACOS_DIR}/Velo" "${MACOS_DIR}/velo-daemon.tmp"
mv "${MACOS_DIR}/velo-daemon.tmp" "${MACOS_DIR}/velo-daemon"
rm -rf "${RESOURCES_DIR}/dist"
cp -R "${ROOT_DIR}/apps/velo-desktop/dist" "${RESOURCES_DIR}/dist"
/usr/bin/codesign --force --deep --sign - "${APP_BUNDLE}" >/dev/null 2>&1 || true

# Sync to /Applications/Velo.app when writable so Launchpad & Spotlight launch latest version
if [ -w "/Applications" ]; then
  echo "🚀 [5/5] Installing updated Velo.app into /Applications/Velo.app..."
  rm -rf "/Applications/Velo.app.tmp"
  cp -R "${APP_BUNDLE}" "/Applications/Velo.app.tmp"
  rm -rf "/Applications/Velo.app"
  mv "/Applications/Velo.app.tmp" "/Applications/Velo.app"
fi

# Keep macOS LaunchAgent (`com.velo.daemon`) binary & UI in sync if enabled
PLIST_PATH="${HOME}/Library/LaunchAgents/com.velo.daemon.plist"
if [ -f "${PLIST_PATH}" ]; then
  echo "🔄 Syncing updated daemon & UI into macOS LaunchAgent (~/.velo)..."
  mkdir -p "${HOME}/.velo/bin" "${HOME}/.velo/ui"
  cp "${ROOT_DIR}/target/release/velo" "${HOME}/.velo/bin/velo-daemon.tmp"
  chmod +x "${HOME}/.velo/bin/velo-daemon.tmp"
  /usr/bin/codesign --force --sign - "${HOME}/.velo/bin/velo-daemon.tmp" >/dev/null 2>&1 || true
  mv "${HOME}/.velo/bin/velo-daemon.tmp" "${HOME}/.velo/bin/velo-daemon"
  rm -rf "${HOME}/.velo/ui/dist.tmp"
  cp -R "${ROOT_DIR}/apps/velo-desktop/dist" "${HOME}/.velo/ui/dist.tmp"
  rm -rf "${HOME}/.velo/ui/dist"
  mv "${HOME}/.velo/ui/dist.tmp" "${HOME}/.velo/ui/dist"
  launchctl kickstart -k "gui/$(id -u)/com.velo.daemon" >/dev/null 2>&1 || true
fi

echo "✅ Standalone Release Bundle ready at: ${APP_BUNDLE} (and /Applications/Velo.app)"
ls -lh "${MACOS_DIR}/Velo" "${MACOS_DIR}/velo-daemon"
