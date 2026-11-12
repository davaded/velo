#!/usr/bin/env bash
set -euo pipefail

# Deploy Velo Zero-Trust Blind E2EE Relay (`velo relay`) to your own Linux SSH server + fixed domain (Caddy auto-TLS).
# Usage:
#   ./scripts/deploy-vps-relay.sh <ssh-host> <relay-domain>
# Example:
#   ./scripts/deploy-vps-relay.sh sub2api-prod relay.yourdomain.com

if [ $# -lt 2 ]; then
  echo "Usage: $0 <ssh-host> <relay-domain>"
  echo "Example: $0 sub2api-prod relay.yourdomain.com"
  exit 1
fi

SSH_HOST="$1"
RELAY_DOMAIN="$2"
WSS_URL="wss://${RELAY_DOMAIN}"

echo "🛰️  [1/3] Provisioning Velo Blind Relay source & systemd service on ${SSH_HOST}..."
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ssh "${SSH_HOST}" "mkdir -p /opt/velo-relay"
rsync -az --exclude 'target' --exclude 'node_modules' --exclude '.git' --exclude 'Velo.app' --exclude 'apps' \
  "${ROOT_DIR}/Cargo.toml" "${ROOT_DIR}/Cargo.lock" "${ROOT_DIR}/crates" "${SSH_HOST}:/opt/velo-relay/"

ssh "${SSH_HOST}" bash -s -- "${RELAY_DOMAIN}" <<'REMOTE_EOF'
set -euo pipefail
DOMAIN="$1"
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
source "$HOME/.cargo/env" 2>/dev/null || true
cd /opt/velo-relay
cargo build --release -p velo-cli
install -m 0755 target/release/velo /usr/local/bin/velo-relay

cat > /etc/systemd/system/velo-blind-relay.service <<EOF
[Unit]
Description=Velo Zero-Trust Blind E2EE Relay (ChaCha20-Poly1305)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/velo-relay relay --listen 127.0.0.1:6768
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now velo-blind-relay.service
echo "Remote velo-blind-relay.service active on 127.0.0.1:6768 (reverse-proxy ${DOMAIN} -> 127.0.0.1:6768 via Caddy/Nginx)."
REMOTE_EOF

echo "🔒 [2/3] Locking permanent relay endpoint in local Velo Daemon: ${WSS_URL}"
ENCODED_WSS="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${WSS_URL}")"
PAIR_JSON="$(curl -fsS "http://127.0.0.1:6767/api/pair?relay=${ENCODED_WSS}")"
PAIR_URI="$(echo "${PAIR_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pairing_uri"])')"

echo "📲 [3/3] Permanent E2EE Pairing URI: ${PAIR_URI}"
echo "✅ Done! Ensure ${RELAY_DOMAIN} TLS reverse-proxies WebSocket traffic to 127.0.0.1:6768 on ${SSH_HOST}."
