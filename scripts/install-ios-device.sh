#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/velo-ios"
DERIVED="${IOS_DIR}/.build-device"
DEVICE_ID="${1:-00008130-000938E41AA0001C}"

echo "⚙️  [1/3] Regenerating Xcode project (Team: 76S2FLMS7Q)..."
(cd "${IOS_DIR}" && xcodegen generate)

echo "🔨 [2/3] Building & Signing Release VeloMobile.app for physical iPhone (${DEVICE_ID})..."
(cd "${IOS_DIR}" && xcodebuild \
  -project VeloMobile.xcodeproj \
  -scheme VeloMobile \
  -configuration Release \
  -destination "id=${DEVICE_ID}" \
  -derivedDataPath "${DERIVED}" \
  -allowProvisioningUpdates \
  -quiet \
  build)

APP_PATH="${DERIVED}/Build/Products/Release-iphoneos/VeloMobile.app"
echo "📲 [3/3] Installing & Launching Velo.app onto your iPhone..."
xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"
xcrun devicectl device process launch --device "${DEVICE_ID}" com.daiyudai.velo.mobile || true
echo "✅ Velo native iOS app is installed on your iPhone!"
