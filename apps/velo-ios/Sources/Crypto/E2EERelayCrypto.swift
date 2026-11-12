import CryptoKit
import Foundation

public struct EncryptedRelayFrameDto: Codable, Sendable {
    public let sender_id: String
    public let nonce: UInt64
    public let nonce_hex: String
    public let ciphertext_hex: String
}

public enum E2EERelayCrypto {
    public static func hexDecode(_ hex: String) -> Data? {
        let clean = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count % 2 == 0 else { return nil }
        var data = Data(capacity: clean.count / 2)
        var idx = clean.startIndex
        while idx < clean.endIndex {
            let next = clean.index(idx, offsetBy: 2)
            guard let byte = UInt8(clean[idx..<next], radix: 16) else { return nil }
            data.append(byte)
            idx = next
        }
        return data
    }

    public static func hexEncode(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Generates an ephemeral X25519 keypair for Forward-Secrecy session key negotiation.
    public static func generateEphemeralKeypair() -> (
        privateKey: Curve25519.KeyAgreement.PrivateKey,
        publicHex: String
    ) {
        let priv = Curve25519.KeyAgreement.PrivateKey()
        let pubHex = hexEncode(priv.publicKey.rawRepresentation)
        return (priv, pubHex)
    }

    /// Matches Rust `X25519Keypair::derive_shared_key_hex` + `derive_ratcheted_session_key_hex`
    /// in `crates/velo-relay/src/lib.rs`:
    /// 1. `ecdh = SHA256("velo-x25519-v1:" || X25519(client_priv, daemon_pub))`
    /// 2. `ratcheted = SHA256("velo-e2ee-ratchet-v1:" || root_key_bytes || ecdh)`
    public static func deriveRatchetedKeyHex(
        rootSharedKeyHex: String,
        clientPrivateKey: Curve25519.KeyAgreement.PrivateKey,
        daemonPublicHex: String
    ) -> String? {
        guard let pubData = hexDecode(daemonPublicHex),
              pubData.count == 32,
              let daemonPubKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: pubData),
              let sharedSecret = try? clientPrivateKey.sharedSecretFromKeyAgreement(with: daemonPubKey)
        else {
            return nil
        }

        var ecdhInput = Data("velo-x25519-v1:".utf8)
        sharedSecret.withUnsafeBytes { rawBuf in
            ecdhInput.append(contentsOf: rawBuf)
        }
        let ecdhKeyBytes = Data(SHA256.hash(data: ecdhInput))

        let rootKeyBytes: Data = {
            if let raw = hexDecode(rootSharedKeyHex), raw.count == 32 {
                return raw
            }
            return Data(SHA256.hash(data: Data(rootSharedKeyHex.utf8)))
        }()

        var ratchetInput = Data("velo-e2ee-ratchet-v1:".utf8)
        ratchetInput.append(rootKeyBytes)
        ratchetInput.append(ecdhKeyBytes)
        return hexEncode(Data(SHA256.hash(data: ratchetInput)))
    }

    /// Matches Rust `derive_aead_key` in `crates/velo-relay/src/lib.rs`
    private static func deriveKey(_ keyHex: String) -> SymmetricKey {
        if let raw = hexDecode(keyHex), raw.count == 32 {
            return SymmetricKey(data: raw)
        }
        let digest = SHA256.hash(data: Data(keyHex.utf8))
        return SymmetricKey(data: Data(digest))
    }

    /// Matches Rust `build_nonce_bytes`: 4 zero bytes + 8-byte little-endian u64
    private static func buildNonceData(_ nonce: UInt64) -> Data {
        var bytes = Data(repeating: 0, count: 4)
        var le = nonce.littleEndian
        withUnsafeBytes(of: &le) { rawBuf in
            bytes.append(contentsOf: rawBuf)
        }
        return bytes
    }

    /// Seals JSON dictionary into RFC 8439 ChaCha20-Poly1305 `EncryptedRelayFrameDto` JSON string.
    public static func sealJSON(
        sharedKeyHex: String,
        senderId: String = "velo-ios",
        nonce: UInt64,
        payload: [String: Any]
    ) -> String? {
        guard let plaintext = try? JSONSerialization.data(withJSONObject: payload) else {
            return nil
        }
        let key = deriveKey(sharedKeyHex)
        let nonceData = buildNonceData(nonce)
        guard let chachaNonce = try? ChaChaPoly.Nonce(data: nonceData),
              let box = try? ChaChaPoly.seal(plaintext, using: key, nonce: chachaNonce)
        else {
            return nil
        }

        var combined = Data(box.ciphertext)
        combined.append(box.tag)

        let frame = EncryptedRelayFrameDto(
            sender_id: senderId,
            nonce: nonce,
            nonce_hex: hexEncode(nonceData),
            ciphertext_hex: hexEncode(combined)
        )
        guard let encoded = try? JSONEncoder().encode(frame) else { return nil }
        return String(data: encoded, encoding: .utf8)
    }

    /// Opens & authenticates incoming `EncryptedRelayFrameDto` JSON text.
    public static func openFrame(
        sharedKeyHex: String,
        rawFrameText: String
    ) -> (senderId: String, nonce: UInt64, json: [String: Any])? {
        guard let frameData = rawFrameText.data(using: .utf8),
              let frame = try? JSONDecoder().decode(EncryptedRelayFrameDto.self, from: frameData),
              let rawCipherAndTag = hexDecode(frame.ciphertext_hex),
              rawCipherAndTag.count >= 16
        else {
            return nil
        }

        let key = deriveKey(sharedKeyHex)
        let nonceData = buildNonceData(frame.nonce)
        let cipherLen = rawCipherAndTag.count - 16
        let ciphertext = rawCipherAndTag.prefix(cipherLen)
        let tag = rawCipherAndTag.suffix(16)

        guard let chachaNonce = try? ChaChaPoly.Nonce(data: nonceData),
              let box = try? ChaChaPoly.SealedBox(nonce: chachaNonce, ciphertext: ciphertext, tag: tag),
              let plaintext = try? ChaChaPoly.open(box, using: key),
              let jsonObj = (try? JSONSerialization.jsonObject(with: plaintext)) as? [String: Any]
        else {
            return nil
        }

        return (frame.sender_id, frame.nonce, jsonObj)
    }
}
