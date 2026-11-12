#!/usr/bin/env bash
set -euo pipefail

# One-click deployer for Velo's Permanent Fixed-Domain Blind E2EE Relay on Cloudflare Workers + Durable Objects.
# Usage:
#   ./scripts/deploy-cloudflare-relay.sh
#   ./scripts/deploy-cloudflare-relay.sh relay.yourdomain.com   # Optional custom domain in your Cloudflare account

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="${ROOT_DIR}/deploy/cloudflare-blind-relay"
CUSTOM_DOMAIN="${1:-${VELO_RELAY_DOMAIN:-}}"

# Augment PATH with local fnm/nvm/Homebrew node if needed
for d in "$HOME/.local/share/fnm/node-versions"/*/installation/bin "$HOME/.nvm/versions/node"/*/bin "/opt/homebrew/bin" "/usr/local/bin"; do
  if [ -d "$d" ]; then
    export PATH="$d:$PATH"
  fi
done

echo "🔎 [1/4] Checking Cloudflare Wrangler authentication..."
if ! npx --yes wrangler whoami >/dev/null 2>&1; then
  echo "🌐 Opening browser for one-time Cloudflare login (`wrangler login`)..."
  npx --yes wrangler login
fi

TMP_CONFIG="${RELAY_DIR}/.wrangler.deploy.toml"
cp "${RELAY_DIR}/wrangler.toml" "${TMP_CONFIG}"
trap 'rm -f "${TMP_CONFIG}"' EXIT

if [ -n "${CUSTOM_DOMAIN}" ]; then
  echo "🔗 Binding custom Cloudflare domain: ${CUSTOM_DOMAIN}"
  cat >> "${TMP_CONFIG}" <<EOF

routes = [
  { pattern = "${CUSTOM_DOMAIN}", custom_domain = true }
]
EOF
fi

echo "🚀 [2/4] Deploying Zero-Trust Blind E2EE Relay (Durable Objects)..."
DEPLOY_OUT="$(cd "${RELAY_DIR}" && npx --yes wrangler deploy --config "${TMP_CONFIG}" 2>&1 | tee /dev/stderr)"

if [ -n "${CUSTOM_DOMAIN}" ]; then
  WSS_URL="wss://${CUSTOM_DOMAIN}"
else
  HTTPS_URL="$(echo "${DEPLOY_OUT}" | grep -Eo 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -n 1 || true)"
  if [ -z "${HTTPS_URL}" ]; then
    echo "❌ Could not auto-detect deployed workers.dev URL from output above."
    exit 1
  fi
  WSS_URL="${HTTPS_URL/#https:\/\//wss:\/\/}"
fi

echo "🔒 [3/4] Locking permanent relay endpoint in local Velo Daemon: ${WSS_URL}"
ENCODED_WSS="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${WSS_URL}")"
PAIR_JSON="$(curl -fsS "http://127.0.0.1:6767/api/pair?relay=${ENCODED_WSS}")"
PAIR_URI="$(echo "${PAIR_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pairing_uri"])')"

echo "📲 [4/4] Permanent E2EE Pairing URI ready (never changes across Mac reboots!):"
echo "   Relay: ${WSS_URL}"
echo "   URI:   ${PAIR_URI}"

# Auto-push updated permanent pairing URI to USB/Wi-Fi connected iPhone if present
if xcrun devicectl list devices 2>/dev/null | grep -q "00008130-000938E41AA0001C"; then
  echo "📱 Detected connected iPhone — pushing permanent pairing URI directly to VeloMobile.app..."
  xcrun devicectl device process launch --device 00008130-000938E41AA0001C --terminate-existing --payload-url "${PAIR_URI}" com.daiyudai.velo.mobile >/dev/null 2>&1 || true
fi

echo "✅ Done! Your Mac & iPhone are now permanently paired over ${WSS_URL}."
