#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/velo-ios"
DERIVED="${IOS_DIR}/.build-sim"

SIM_UDID="$(xcrun simctl list devices available | grep -E "iPhone .*\([0-9A-F-]{36}\)" | head -n 1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
if [[ -z "${SIM_UDID}" ]]; then
  echo "❌ No available iPhone simulator found in Xcode."
  exit 1
fi

echo "📱 Booting iPhone Simulator (${SIM_UDID})..."
xcrun simctl boot "${SIM_UDID}" 2>/dev/null || true
if [[ -d "/Applications/Xcode.app/Contents/Applications/DeviceHub.app" ]]; then
  open "/Applications/Xcode.app/Contents/Applications/DeviceHub.app" || true
elif [[ -d "$(xcode-select -p)/Applications/Simulator.app" ]]; then
  open "$(xcode-select -p)/Applications/Simulator.app" || true
fi

echo "🔨 Building Native SwiftUI VeloMobile.app..."
(cd "${IOS_DIR}" && xcodegen generate >/dev/null && xcodebuild \
  -project VeloMobile.xcodeproj \
  -scheme VeloMobile \
  -destination "id=${SIM_UDID}" \
  -derivedDataPath "${DERIVED}" \
  -quiet \
  build)

APP_PATH="${DERIVED}/Build/Products/Debug-iphonesimulator/VeloMobile.app"
echo "🚀 Installing & Launching VeloMobile (${APP_PATH})..."
xcrun simctl install "${SIM_UDID}" "${APP_PATH}"
xcrun simctl launch "${SIM_UDID}" dev.velo.mobile
echo "✅ VeloMobile is live on Simulator and connected to http://127.0.0.1:6767!"
