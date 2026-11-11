import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export interface EncryptedRelayFrameDto {
  sender_id: string;
  nonce: number;
  nonce_hex: string;
  ciphertext_hex: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function buildNonceBytes(nonce: number): Uint8Array {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  // Matches Rust `build_nonce_bytes`: 4 zero bytes + 8-byte little-endian u64
  view.setUint32(4, nonce >>> 0, true);
  view.setUint32(8, Math.floor(nonce / 0x100000000) >>> 0, true);
  return buf;
}

export function e2eeSealJson(
  sharedKeyHex: string,
  senderId: string,
  nonce: number,
  payload: unknown
): string {
  const key = hexToBytes(sharedKeyHex);
  const nonceBytes = buildNonceBytes(nonce);
  const cipher = chacha20poly1305(key, nonceBytes);
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ct = cipher.encrypt(pt);
  const frame: EncryptedRelayFrameDto = {
    sender_id: senderId,
    nonce,
    nonce_hex: bytesToHex(nonceBytes),
    ciphertext_hex: bytesToHex(ct),
  };
  return JSON.stringify(frame);
}

export function e2eeOpenFrame(
  sharedKeyHex: string,
  rawFrameJson: string
): { senderId: string; message: Record<string, unknown> } | null {
  try {
    const frame = JSON.parse(rawFrameJson) as EncryptedRelayFrameDto;
    if (!frame || typeof frame.ciphertext_hex !== "string") return null;
    const key = hexToBytes(sharedKeyHex);
    const nonceBytes = buildNonceBytes(frame.nonce);
    const cipher = chacha20poly1305(key, nonceBytes);
    const pt = cipher.decrypt(hexToBytes(frame.ciphertext_hex));
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    return { senderId: frame.sender_id, message: parsed };
  } catch {
    return null;
  }
}
