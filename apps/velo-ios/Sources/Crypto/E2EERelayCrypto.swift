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
    ) -> (senderId: String, json: [String: Any])? {
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

        return (frame.sender_id, jsonObj)
    }
}
