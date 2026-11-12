#!/usr/bin/env bash
set -euo pipefail

# Cross-compile static Linux x86_64 `velo-relay` binary on macOS and deploy to your own Linux SSH server.
# Automatically uses `hush ssh <host> --` if `hush` is installed, otherwise falls back to standard `ssh <host>`.
#
# Usage:
#   ./scripts/deploy-vps-relay.sh <ssh-host> <wss-url-or-domain>
# Example:
#   ./scripts/deploy-vps-relay.sh aliyun wss://daidaiyu.top/velo-relay

if [ $# -lt 2 ]; then
  echo "Usage: $0 <ssh-host> <wss-url-or-domain>"
  echo "Example: $0 aliyun wss://daidaiyu.top/velo-relay"
  exit 1
fi

SSH_HOST="$1"
RAW_ENDPOINT="$2"
if [[ "${RAW_ENDPOINT}" == wss://* || "${RAW_ENDPOINT}" == ws://* ]]; then
  WSS_URL="${RAW_ENDPOINT%/}"
else
  WSS_URL="wss://${RAW_ENDPOINT%/}"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="x86_64-unknown-linux-musl"
RUST_LLD="$(find "$(rustc --print sysroot)" -name rust-lld 2>/dev/null | head -n 1)"

echo "🦀 [1/4] Cross-compiling static Linux musl binary (velo-relay)..."
rustup target add "${TARGET}" >/dev/null 2>&1 || true
(
  cd "${ROOT_DIR}"
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="${RUST_LLD:-rust-lld}" \
    cargo build --release --target "${TARGET}" -p velo-relay --bin velo-relay
)

BIN_PATH="${ROOT_DIR}/target/${TARGET}/release/velo-relay"

run_remote() {
  if command -v hush >/dev/null 2>&1; then
    hush ssh "${SSH_HOST}" -- "$@"
  elif [ -x "$HOME/.local/bin/hush" ]; then
    "$HOME/.local/bin/hush" ssh "${SSH_HOST}" -- "$@"
  else
    ssh "${SSH_HOST}" "$@"
  fi
}

echo "🛰️  [2/4] Uploading static velo-relay binary to ${SSH_HOST}:/usr/local/bin/velo-relay..."
run_remote "cat > /usr/local/bin/velo-relay.new && chmod 0755 /usr/local/bin/velo-relay.new && mv -f /usr/local/bin/velo-relay.new /usr/local/bin/velo-relay" < "${BIN_PATH}"

echo "⚙️  [3/4] Ensuring systemd service velo-blind-relay.service is active on ${SSH_HOST}..."
run_remote "cat > /etc/systemd/system/velo-blind-relay.service <<'EOF'
[Unit]
Description=Velo Zero-Trust Blind E2EE Relay (ChaCha20-Poly1305)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/velo-relay --listen 127.0.0.1:6768
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable velo-blind-relay.service >/dev/null 2>&1 || true
systemctl restart velo-blind-relay.service
systemctl is-active velo-blind-relay.service"

echo "🔒 [4/4] Locking permanent relay endpoint in local Velo Daemon: ${WSS_URL}"
ENCODED_WSS="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "${WSS_URL}")"
PAIR_JSON="$(curl -fsS --noproxy '*' "http://127.0.0.1:6767/api/pair?relay=${ENCODED_WSS}")"
PAIR_URI="$(echo "${PAIR_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pairing_uri"])')"

echo "✅ Deployed & bound! Permanent E2EE Pairing URI:"
echo "   ${PAIR_URI}"
