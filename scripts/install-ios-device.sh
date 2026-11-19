#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/velo-ios"
DERIVED="${IOS_DIR}/.build-device"

if [ $# -ge 1 ] && [ -n "$1" ]; then
  DEVICE_ID="$1"
else
  # Auto-detect first available paired physical iPhone via devicectl
  DETECTED="$(xcrun devicectl list devices 2>/dev/null | awk '/available \(paired\)/ && /iPhone/ { for(i=1;i<=NF;i++) if ($i ~ /^[0-9A-F-]{20,}$/) { print $i; exit } }')"
  DEVICE_ID="${DETECTED:-00008130-000938E41AA0001C}"
fi

echo "⚙️  [1/3] Regenerating Xcode project (VeloMobile + LiveActivityExtension)..."
(cd "${IOS_DIR}" && xcodegen generate)

echo "🔨 [2/3] Building & Signing VeloMobile.app for iPhone (${DEVICE_ID})..."
(cd "${IOS_DIR}" && xcodebuild \
  -project VeloMobile.xcodeproj \
  -scheme VeloMobile \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "${DERIVED}" \
  -allowProvisioningUpdates \
  -quiet \
  build)

APP_PATH="${DERIVED}/Build/Products/Debug-iphoneos/VeloMobile.app"
echo "📲 [3/3] Wirelessly Installing & Launching Velo onto iPhone (${DEVICE_ID})..."
if ! xcrun devicectl list devices 2>/dev/null | grep -q "${DEVICE_ID}.*available"; then
  killall CoreDeviceService 2>/dev/null || true
  sleep 2
fi
xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"
xcrun devicectl device process launch --device "${DEVICE_ID}" com.daiyudai.velo.mobile || true
echo "✅ VeloMobile is freshly signed, installed, and running on your iPhone!"
