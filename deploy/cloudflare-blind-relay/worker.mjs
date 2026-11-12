/**
 * Velo Zero-Trust Blind E2EE Relay — Cloudflare Durable Object Edge Worker
 *
 * Security Invariants:
 * 1. ZERO storage: never calls `ctx.storage.put(...)` or logs payload contents.
 * 2. Strict Blind Ciphertext Gate: rejects any frame that is not a valid
 *    `EncryptedRelayFrame` JSON envelope with a 96-bit nonce and >=128-bit Poly1305 tag.
 * 3. Hibernatable WebSocket API: scales to zero cost on Cloudflare Workers Free Plan.
 */

const MAX_BLIND_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PEERS_PER_ROOM = 8;
const HEX_RE = /^[0-9a-fA-F]+$/;

function isValidBlindCiphertextEnvelope(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BLIND_FRAME_BYTES) {
    return false;
  }
  try {
    const f = JSON.parse(raw);
    return (
      typeof f.sender_id === "string" &&
      f.sender_id.length > 0 &&
      typeof f.nonce === "number" &&
      typeof f.nonce_hex === "string" &&
      f.nonce_hex.length === 24 &&
      HEX_RE.test(f.nonce_hex) &&
      typeof f.ciphertext_hex === "string" &&
      f.ciphertext_hex.length >= 32 &&
      f.ciphertext_hex.length % 2 === 0 &&
      HEX_RE.test(f.ciphertext_hex)
    );
  } catch {
    return false;
  }
}

export class BlindRelayRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426 });
    }
    const existing = this.ctx.getWebSockets();
    if (existing.length >= MAX_PEERS_PER_ROOM) {
      return new Response("Room peer limit reached", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    if (!isValidBlindCiphertextEnvelope(message)) return;

    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(message);
        } catch {
          // Peer disconnected
        }
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({
        status: "ok",
        service: "velo-blind-relay-edge",
        mode: "zero-trust-blind-e2ee",
        cipher: "X25519-ChaCha20-Poly1305-RFC8439",
        stores_plaintext: false,
      });
    }

    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{8,128})$/);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const roomId = match[1];
    const id = env.BLIND_ROOMS.idFromName(roomId);
    const stub = env.BLIND_ROOMS.get(id);
    return stub.fetch(request);
  },
};
