import CryptoKit
import Foundation
import UIKit

public enum AttachmentTier: String, Sendable {
    case thumb
    case full
}

public struct PendingComposerImage: Identifiable, Equatable {
    public let id: UUID
    public var preview: UIImage
    public var jpegData: Data
    public let filename: String
    public var uploadedPath: String?
    public var uploadFailed: Bool

    public var isUploading: Bool {
        uploadedPath == nil && !uploadFailed
    }

    public init(
        id: UUID = UUID(),
        preview: UIImage,
        jpegData: Data,
        filename: String = "photo.jpg",
        uploadedPath: String? = nil,
        uploadFailed: Bool = false
    ) {
        self.id = id
        self.preview = preview
        self.jpegData = jpegData
        self.filename = filename
        self.uploadedPath = uploadedPath
        self.uploadFailed = uploadFailed
    }

    public static func == (lhs: PendingComposerImage, rhs: PendingComposerImage) -> Bool {
        lhs.id == rhs.id
            && lhs.uploadedPath == rhs.uploadedPath
            && lhs.uploadFailed == rhs.uploadFailed
    }
}

public final class VeloAttachmentCache: @unchecked Sendable {
    public static let shared = VeloAttachmentCache()

    private let memCache = NSCache<NSString, UIImage>()
    private let ioQueue = DispatchQueue(label: "dev.velo.attachment-cache", qos: .utility)

    private init() {
        memCache.countLimit = 96
        memCache.totalCostLimit = 64 * 1024 * 1024
    }

    private func hashKey(for ref: String) -> String {
        let canonical: String = {
            let trimmed = ref.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasPrefix("/api/attachments/") {
                return URL(fileURLWithPath: trimmed).lastPathComponent
            }
            if trimmed.contains("/.velo/attachments/") {
                return URL(fileURLWithPath: trimmed).lastPathComponent
            }
            return trimmed
        }()
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private func fileURL(for ref: String, tier: AttachmentTier) -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = caches
            .appendingPathComponent("VeloAttachments", isDirectory: true)
            .appendingPathComponent(tier.rawValue, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(hashKey(for: ref)).img")
    }

    public func cachedImage(for ref: String, tier: AttachmentTier) -> UIImage? {
        let key = "\(tier.rawValue):\(hashKey(for: ref))" as NSString
        if let hit = memCache.object(forKey: key) {
            return hit
        }
        if tier == .thumb {
            let fullKey = "full:\(hashKey(for: ref))" as NSString
            if let hit = memCache.object(forKey: fullKey) {
                return hit
            }
        }
        if let url = fileURL(for: ref, tier: tier),
           let data = try? Data(contentsOf: url),
           let img = UIImage(data: data)
        {
            memCache.setObject(img, forKey: key, cost: data.count)
            return img
        }
        if tier == .thumb,
           let fullURL = fileURL(for: ref, tier: .full),
           let data = try? Data(contentsOf: fullURL),
           let img = UIImage(data: data)
        {
            memCache.setObject(img, forKey: key, cost: data.count)
            return img
        }
        return nil
    }

    @discardableResult
    public func store(data: Data, for ref: String, tier: AttachmentTier) -> UIImage? {
        guard !data.isEmpty, let img = UIImage(data: data) else { return nil }
        let key = "\(tier.rawValue):\(hashKey(for: ref))" as NSString
        memCache.setObject(img, forKey: key, cost: data.count)
        if let url = fileURL(for: ref, tier: tier) {
            ioQueue.async {
                try? data.write(to: url, options: .atomic)
            }
        }
        return img
    }

    public func storeUploaded(image: UIImage, jpegData: Data, refs: [String]) {
        for r in refs where !r.isEmpty {
            let h = hashKey(for: r)
            memCache.setObject(image, forKey: "thumb:\(h)" as NSString, cost: jpegData.count)
            memCache.setObject(image, forKey: "full:\(h)" as NSString, cost: jpegData.count)
            if let fullURL = fileURL(for: r, tier: .full) {
                ioQueue.async {
                    try? jpegData.write(to: fullURL, options: .atomic)
                }
            }
        }
    }

    /// Downscales mobile photos/screenshots to max `1600px` long-edge @ 82% JPEG (~140-220 KB),
    /// matching Claude / Codex / Gemini multimodal vision patch bounds while avoiding Paseo's
    /// HEIC-to-PNG multi-MB relay frame overflow pitfall.
    public static func compressForAgentUpload(
        _ source: UIImage,
        maxLongEdge: CGFloat = 1600,
        quality: CGFloat = 0.82
    ) -> (jpegData: Data, preview: UIImage)? {
        let pixelW = source.size.width * source.scale
        let pixelH = source.size.height * source.scale
        guard pixelW > 0, pixelH > 0 else { return nil }

        let longEdge = max(pixelW, pixelH)
        let ratio = longEdge > maxLongEdge ? (maxLongEdge / longEdge) : 1.0
        let targetSize = CGSize(
            width: max(1, (pixelW * ratio).rounded()),
            height: max(1, (pixelH * ratio).rounded())
        )

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let rendered = renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: targetSize))
            source.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: quality), !jpeg.isEmpty else {
            return nil
        }
        return (jpeg, rendered)
    }
}
