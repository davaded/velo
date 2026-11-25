import Foundation
import SwiftUI

// MARK: - 1. Engine Categories & Adaptive Design Tokens (Beautiful UI / Rare UI / BeUI)

public enum VeloEngineCategory: String, CaseIterable, Identifiable, Sendable {
    case claude
    case codex
    case agy
    case grok
    case cursor
    case other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "OpenAI Codex"
        case .agy: return "Antigravity"
        case .grok: return "Grok CLI"
        case .cursor: return "Cursor Agent"
        case .other: return "ACP / Custom"
        }
    }

    public var vendor: String {
        switch self {
        case .claude: return "Anthropic"
        case .codex: return "OpenAI"
        case .agy: return "Google"
        case .grok: return "xAI"
        case .cursor: return "Cursor"
        case .other: return "Custom"
        }
    }

    public var shortBadge: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .agy: return "AGY"
        case .grok: return "Grok"
        case .cursor: return "Cursor"
        case .other: return "ACP"
        }
    }

    public var iconName: String {
        switch self {
        case .claude: return "sparkles"
        case .codex: return "terminal.fill"
        case .agy: return "atom"
        case .grok: return "bolt.fill"
        case .cursor: return "cursorarrow.rays"
        case .other: return "cpu"
        }
    }

    public var accentColor: Color {
        switch self {
        case .claude:
            return Color(red: 0.88, green: 0.53, blue: 0.35) // Anthropic Terracotta
        case .codex:
            return Color(red: 0.16, green: 0.78, blue: 0.56) // OpenAI Emerald
        case .agy:
            return Color(red: 0.35, green: 0.60, blue: 0.98) // Google Cobalt
        case .grok:
            return Color(red: 0.64, green: 0.48, blue: 0.98) // xAI Electric Violet
        case .cursor:
            return Color(red: 0.18, green: 0.76, blue: 0.88) // Cursor Cyan
        case .other:
            return Color.secondary
        }
    }

    public var supportedEfforts: [String] {
        switch self {
        case .claude, .codex:
            return ["low", "medium", "high", "max"]
        case .agy, .grok, .other:
            return ["low", "medium", "high"]
        case .cursor:
            return ["medium", "high"]
        }
    }

    public static var primaryCategories: [VeloEngineCategory] {
        [.claude, .codex, .agy, .grok, .cursor]
    }

    public static func from(agentKind: String, family: String = "") -> VeloEngineCategory {
        let k = agentKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let f = family.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if k == "claude" || f.contains("anthropic") { return .claude }
        if k == "codex" || f.contains("openai") { return .codex }
        if k == "agy" || k.contains("antigravity") || f.contains("antigravity") { return .agy }
        if k == "grok" || f.contains("grok") || f.contains("xai") { return .grok }
        if k == "cursor" || k.contains("cursor") || f.contains("cursor") { return .cursor }
        return .other
    }
}

public enum VeloTheme {
    public static let accentViolet = Color(red: 0.545, green: 0.361, blue: 0.965) // #8B5CF6
    public static let accentVioletSoft = Color(red: 0.655, green: 0.545, blue: 0.980) // #A78BFA
    public static let emerald = Color(red: 0.204, green: 0.827, blue: 0.600) // #34D399
    public static let coral = Color(red: 0.973, green: 0.443, blue: 0.443) // #F87171
    public static let amber = Color(red: 0.984, green: 0.749, blue: 0.141) // #FBBF24

    public static func canvas(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.028, green: 0.031, blue: 0.043) // #07080B Deep Obsidian
            : Color(red: 0.962, green: 0.966, blue: 0.978) // #F5F6FA Editorial Light
    }

    public static func cardSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.064, green: 0.070, blue: 0.094) // #101218 Crisp Obsidian Card
            : Color.white
    }

    public static func elevatedSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.096, green: 0.105, blue: 0.141) // #181B24 Elevated Control
            : Color(red: 0.935, green: 0.944, blue: 0.966) // #EEF1F6
    }

    public static func codeSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.043, green: 0.047, blue: 0.067) // #0B0C11 Code Bed
            : Color(red: 0.955, green: 0.961, blue: 0.976)
    }

    public static func codeHeader(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.078, green: 0.084, blue: 0.114)
            : Color(red: 0.922, green: 0.931, blue: 0.955)
    }

    public static func userBubble(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.128, green: 0.133, blue: 0.178)
            : Color(red: 0.922, green: 0.929, blue: 0.961)
    }

    public static func hairline(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color.white.opacity(0.085)
            : Color.black.opacity(0.075)
    }

    public static func specularRim(_ scheme: ColorScheme) -> LinearGradient {
        if scheme == .dark {
            return LinearGradient(
                colors: [
                    Color.white.opacity(0.16),
                    Color.white.opacity(0.05),
                    Color.white.opacity(0.03),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
            return LinearGradient(
                colors: [
                    Color.black.opacity(0.09),
                    Color.black.opacity(0.04),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }
}

// MARK: - 2. Pairing & Session Models

public enum ConnectionModeConfig: Codable, Equatable, Sendable {
    case direct(baseURL: String)
    case e2eeRelay(relayWsURL: String, roomId: String, sharedKeyHex: String)

    public var displayTitle: String {
        switch self {
        case .direct(let baseURL):
            return baseURL
                .replacingOccurrences(of: "http://", with: "")
                .replacingOccurrences(of: "https://", with: "")
        case .e2eeRelay(let relayWsURL, let roomId, _):
            let short = String(roomId.prefix(6))
            if relayWsURL.contains(".lhr.life") || relayWsURL.contains(".trycloudflare.com") {
                return "E2EE 盲中继 · Cloud (\(short))"
            }
            let cleanHost = URLComponents(string: relayWsURL)?.host ?? relayWsURL
            return "E2EE 盲中继 · \(cleanHost) (\(short))"
        }
    }

    public var isEncryptedRelay: Bool {
        if case .e2eeRelay = self { return true }
        return false
    }

    public var directBaseURL: String? {
        if case .direct(let base) = self { return base }
        return nil
    }

    public static func parse(_ rawInput: String) -> ConnectionModeConfig? {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let comp = URLComponents(string: trimmed) {
            let items = comp.queryItems ?? []
            let relay = items.first(where: { $0.name == "relay" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
            let room = items.first(where: { $0.name == "room" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = items.first(where: { $0.name == "key" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)

            if let relay, !relay.isEmpty,
               let room, !room.isEmpty,
               let key, !key.isEmpty
            {
                let normalizedRelay = relay
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    .replacingOccurrences(of: "https://", with: "wss://")
                    .replacingOccurrences(of: "http://", with: "ws://")
                return .e2eeRelay(
                    relayWsURL: normalizedRelay,
                    roomId: room,
                    sharedKeyHex: key
                )
            }

            if let scheme = comp.scheme?.lowercased(), scheme == "http" || scheme == "https",
               let host = comp.host, !host.isEmpty
            {
                let portPart = comp.port.map { ":\($0)" } ?? ""
                return .direct(baseURL: "\(scheme)://\(host)\(portPart)")
            }
        }

        var hostPort = trimmed
            .replacingOccurrences(of: "ws://", with: "http://")
            .replacingOccurrences(of: "wss://", with: "https://")
        if !hostPort.hasPrefix("http://") && !hostPort.hasPrefix("https://") {
            if !hostPort.contains(":") {
                hostPort += ":6767"
            }
            hostPort = "http://\(hostPort)"
        }
        if let comp = URLComponents(string: hostPort), let scheme = comp.scheme, let host = comp.host {
            let portPart = comp.port.map { ":\($0)" } ?? ":6767"
            return .direct(baseURL: "\(scheme)://\(host)\(portPart)")
        }
        return nil
    }
}

public enum SessionRunState: String, Codable, Sendable {
    case running
    case waitingApproval
    case idle
}

public struct VeloQueuedPromptItem: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public var input: String
    public var images: [String]

    public static func fromJSON(_ dict: [String: Any]) -> VeloQueuedPromptItem? {
        guard let id = dict["id"] as? String, !id.isEmpty else { return nil }
        let inp = (dict["input"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let imgs = (dict["images"] as? [String]) ?? []
        guard !inp.isEmpty || !imgs.isEmpty else { return nil }
        return VeloQueuedPromptItem(id: id, input: inp, images: imgs)
    }
}

public struct VeloExternalCliSessionItem: Identifiable, Equatable, Sendable {
    public var id: String { "\(provider)-\(cliSessionId)" }
    public let provider: String
    public let cliSessionId: String
    public let title: String
    public let cwd: String
    public let projectName: String
    public let updatedAtLabel: String
    public let messageCount: Int
    public let lastPreview: String
    public let importedSessionId: String?
    public let isEphemeral: Bool
    public let ephemeralReason: String?

    public static func fromJSON(_ dict: [String: Any]) -> VeloExternalCliSessionItem? {
        guard let cSid = dict["cli_session_id"] as? String, !cSid.isEmpty else { return nil }
        let prov = ((dict["provider"] as? String) ?? "claude").lowercased()
        let title = (dict["title"] as? String) ?? cSid
        let cwd = (dict["cwd"] as? String) ?? ""
        let proj = (dict["project_name"] as? String) ?? "workspace"
        let msgCount = VeloSessionItem.intValue(dict["message_count"]) ?? 0
        let preview = (dict["last_preview"] as? String) ?? ""
        let impSid = (dict["imported_session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let isEph = (dict["is_ephemeral"] as? Bool) ?? false
        let ephReason = (dict["ephemeral_reason"] as? String).flatMap { $0.isEmpty ? nil : $0 }

        let timeLabel: String = {
            if let raw = dict["updated_at"] as? String {
                let isoFrac = ISO8601DateFormatter()
                isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let isoPlain = ISO8601DateFormatter()
                if let d = isoFrac.date(from: raw) ?? isoPlain.date(from: raw) {
                    let f = DateFormatter()
                    f.dateFormat = "MM-dd HH:mm"
                    return f.string(from: d)
                }
            }
            return ""
        }()

        return VeloExternalCliSessionItem(
            provider: prov,
            cliSessionId: cSid,
            title: title,
            cwd: cwd,
            projectName: proj,
            updatedAtLabel: timeLabel,
            messageCount: msgCount,
            lastPreview: preview,
            importedSessionId: impSid,
            isEphemeral: isEph,
            ephemeralReason: ephReason
        )
    }
}

public struct VeloSessionItem: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var agentKind: String
    public var model: String
    public var modelShort: String
    public var effort: String
    public var status: SessionRunState
    public var branchName: String
    public var repoRoot: String
    public var worktreePath: String
    public var parentSessionId: String?
    public var approvalMode: String
    public var filesChanged: Int
    public var insertions: Int
    public var deletions: Int
    public var tokensUsed: Int
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var contextWindow: Int
    public var costUsd: Double
    public var updatedAtLabel: String
    public var queuedPrompts: [VeloQueuedPromptItem]?
    public var archived: Bool?

    public var isArchived: Bool {
        archived ?? false
    }

    public var activeQueuedPrompts: [VeloQueuedPromptItem] {
        queuedPrompts ?? []
    }

    public var engineCategory: VeloEngineCategory {
        VeloEngineCategory.from(agentKind: agentKind)
    }

    public var projectName: String {
        let name = URL(fileURLWithPath: repoRoot).lastPathComponent
        return name.isEmpty ? "workspace" : name
    }

    public var isIsolatedWorktree: Bool {
        worktreePath != repoRoot && worktreePath.contains("/.velo/worktrees/")
    }

    public static func cleanDisplayTitle(_ raw: String, fallback: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("<conversation_history>") {
            if let userRange = s.range(of: "User:", options: .backwards) {
                s = String(s[userRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                s = fallback
            }
        }
        let firstLine = s.components(separatedBy: .newlines).first?.trimmingCharacters(in: .whitespaces) ?? ""
        return firstLine.isEmpty ? fallback : String(firstLine.prefix(54))
    }

    public static func fromJSON(_ dict: [String: Any]) -> VeloSessionItem? {
        guard let rawId = dict["id"] else { return nil }
        let id = String(describing: rawId)
        guard !id.isEmpty else { return nil }

        let branch = (dict["branch"] as? String)
            ?? (dict["branch_name"] as? String)
            ?? "main"

        var agentKind = "claude"
        if let ak = dict["agent_kind"] as? String, !ak.isEmpty {
            agentKind = ak
        } else if let provStr = dict["provider"] as? String, !provStr.isEmpty {
            agentKind = provStr.lowercased()
        } else if let provDict = dict["provider"] as? [String: Any] {
            if let acpCmd = provDict["acp"] as? String {
                agentKind = "acp:\(acpCmd)"
            } else if let customCmd = provDict["custom"] as? String {
                agentKind = customCmd
            }
        }

        let rawName = (dict["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawPrompt = (dict["prompt"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title: String = {
            if let rawName, !rawName.isEmpty {
                return cleanDisplayTitle(rawName, fallback: branch)
            }
            if let rawPrompt, !rawPrompt.isEmpty {
                return cleanDisplayTitle(rawPrompt, fallback: branch)
            }
            return "新对话"
        }()

        let defaultModel: String = {
            if agentKind == "codex" { return "gpt-6.1-sol" }
            if agentKind == "grok" || agentKind.contains("grok") { return "grok-4.7" }
            if agentKind == "cursor" || agentKind.contains("cursor") { return "cursor:auto" }
            if agentKind == "agy" || agentKind.contains("antigravity") || agentKind.contains("gemini") {
                return "gemini-4-carbon-high"
            }
            return "claude-fable-5-2"
        }()
        let model = (dict["model"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultModel
        let modelShort = VeloModelOption.shortLabel(for: model)
        let effort = (dict["effort"] as? String)
            ?? ((agentKind == "codex" || agentKind == "grok") ? "high" : "medium")
        let approvalMode = (dict["approval_mode"] as? String) ?? "auto_edit"
        let parentSessionId = (dict["parent_session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }

        let statusStr = ((dict["status"] as? String) ?? "idle").lowercased()
        let status: SessionRunState = {
            if statusStr == "running" { return .running }
            if statusStr.contains("waiting") { return .waitingApproval }
            return .idle
        }()

        let diffStats = dict["diff_stats"] as? [String: Any]
        let filesChanged = Self.intValue(diffStats?["files_changed"]) ?? Self.intValue(dict["files_changed"]) ?? 0
        let insertions = Self.intValue(diffStats?["insertions"]) ?? Self.intValue(dict["insertions"]) ?? 0
        let deletions = Self.intValue(diffStats?["deletions"]) ?? Self.intValue(dict["deletions"]) ?? 0

        let inputTokens = Self.intValue(dict["input_tokens"]) ?? 0
        let outputTokens = Self.intValue(dict["output_tokens"]) ?? 0
        let tokensUsed = Self.intValue(dict["tokens_used"]) ?? (inputTokens + outputTokens)
        let cacheReadTokens = Self.intValue(dict["cache_read_tokens"]) ?? 0
        let contextWindow = Self.intValue(dict["context_window"]) ?? 0
        let costUsd = Self.doubleValue(dict["cost_usd"]) ?? 0.0

        let rawRepoRoot = (dict["repo_root"] as? String)
            ?? (dict["project_path"] as? String)
            ?? "~/workspace"
        let repoRoot = VeloFormatting.canonicalWorkspacePath(rawRepoRoot)
        let rawWorktree = (dict["worktree_path"] as? String) ?? repoRoot
        let worktreePath = VeloFormatting.canonicalWorkspacePath(rawWorktree)

        let updatedLabel: String = {
            let isoFrac = ISO8601DateFormatter()
            isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let isoPlain = ISO8601DateFormatter()
            if let rawUpdated = dict["updated_at"] as? String,
               let date = isoFrac.date(from: rawUpdated) ?? isoPlain.date(from: rawUpdated)
            {
                let f = DateFormatter()
                f.dateFormat = "HH:mm"
                return f.string(from: date)
            }
            return "刚刚"
        }()

        let parsedQueue: [VeloQueuedPromptItem] = (dict["queued_prompts"] as? [[String: Any]])?
            .compactMap(VeloQueuedPromptItem.fromJSON) ?? []
        let isArchived = (dict["archived"] as? Bool) ?? false

        return VeloSessionItem(
            id: id,
            title: title,
            agentKind: agentKind,
            model: model,
            modelShort: modelShort,
            effort: effort,
            status: status,
            branchName: branch,
            repoRoot: repoRoot,
            worktreePath: worktreePath,
            parentSessionId: parentSessionId,
            approvalMode: approvalMode,
            filesChanged: filesChanged,
            insertions: insertions,
            deletions: deletions,
            tokensUsed: tokensUsed,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheReadTokens: cacheReadTokens,
            contextWindow: contextWindow,
            costUsd: costUsd,
            updatedAtLabel: updatedLabel,
            queuedPrompts: parsedQueue,
            archived: isArchived
        )
    }

    public static func intValue(_ any: Any?) -> Int? {
        if let i = any as? Int { return i }
        if let n = any as? NSNumber { return n.intValue }
        if let s = any as? String, let i = Int(s) { return i }
        return nil
    }

    public static func doubleValue(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let n = any as? NSNumber { return n.doubleValue }
        if let s = any as? String, let d = Double(s) { return d }
        return nil
    }
}

public struct VeloModelOption: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let shortLabel: String
    public let family: String
    public let agentKind: String
    public let desc: String
    public let installed: Bool
    public let isDefault: Bool
    public let supportedEfforts: [String]?
    public let defaultEffort: String?

    public init(
        id: String,
        label: String,
        shortLabel: String,
        family: String,
        agentKind: String,
        desc: String = "",
        installed: Bool = true,
        isDefault: Bool = false,
        supportedEfforts: [String]? = nil,
        defaultEffort: String? = nil
    ) {
        self.id = id
        self.label = label
        self.shortLabel = shortLabel
        self.family = family
        self.agentKind = agentKind
        self.desc = desc
        self.installed = installed
        self.isDefault = isDefault
        self.supportedEfforts = supportedEfforts
        self.defaultEffort = defaultEffort
    }

    public var resolvedSupportedEfforts: [String] {
        if let supportedEfforts {
            return supportedEfforts
        }
        return category.supportedEfforts
    }

    public func alignedEffort(from current: String) -> String {
        let supported = resolvedSupportedEfforts
        guard !supported.isEmpty else { return "medium" }
        if supported.contains(current) { return current }
        if let def = defaultEffort, supported.contains(def) { return def }
        if supported.contains("high") { return "high" }
        if supported.contains("medium") { return "medium" }
        return supported[0]
    }

    public var category: VeloEngineCategory {
        VeloEngineCategory.from(agentKind: agentKind, family: family)
    }

    public var cleanTitle: String {
        var s = label
            .replacingOccurrences(of: " (Antigravity agy)", with: "")
            .replacingOccurrences(of: " (xAI Grok CLI)", with: "")
            .replacingOccurrences(of: " (Codex)", with: "")
            .replacingOccurrences(of: " (cursor-agent)", with: "")
        if category == .cursor, s.hasPrefix("Cursor · ") {
            s = String(s.dropFirst("Cursor · ".count))
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var cleanSubtitle: String {
        let d = desc
            .replacingOccurrences(of: "Installed · ", with: "")
            .replacingOccurrences(of: "Default in ~/.codex/config.toml · ", with: "")
            .replacingOccurrences(of: "Default in ~/.grok/config.toml · ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !d.isEmpty { return d }
        return "\(category.vendor) · \(id)"
    }

    public static func groupedByCategory(
        _ options: [VeloModelOption]
    ) -> [(category: VeloEngineCategory, models: [VeloModelOption])] {
        var result: [(VeloEngineCategory, [VeloModelOption])] = []
        for cat in VeloEngineCategory.allCases {
            let matching = options.filter { $0.category == cat }
            if !matching.isEmpty {
                result.append((cat, matching))
            }
        }
        return result
    }

    public static let defaults: [VeloModelOption] = [
        VeloModelOption(
            id: "claude-fable-5-2",
            label: "Claude Fable 5.2",
            shortLabel: "Fable 5.2",
            family: "Anthropic",
            agentKind: "claude",
            desc: "Anthropic 旗舰全栈编码与架构推理模型",
            isDefault: true
        ),
        VeloModelOption(
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            shortLabel: "Opus 5.5",
            family: "Anthropic",
            agentKind: "claude",
            desc: "深度多文件自主重构与复杂问题求解"
        ),
        VeloModelOption(
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            shortLabel: "Sonnet 5",
            family: "Anthropic",
            agentKind: "claude",
            desc: "高速均衡日常研发与工具执行"
        ),
        VeloModelOption(
            id: "gpt-6.1-sol",
            label: "GPT-6.1-Sol",
            shortLabel: "GPT-6.1-Sol",
            family: "OpenAI",
            agentKind: "codex",
            desc: "Codex 默认高阶代码生成与仓库级验证",
            isDefault: true
        ),
        VeloModelOption(
            id: "gemini-4-carbon-high",
            label: "Gemini 4 Carbon (High)",
            shortLabel: "Gemini 4 Carbon",
            family: "Google Antigravity",
            agentKind: "agy",
            desc: "Google Antigravity 深度推理旗舰模型",
            isDefault: true
        ),
        VeloModelOption(
            id: "gemini-3.8-flash-high",
            label: "Gemini 3.8 Flash (High)",
            shortLabel: "Gemini 3.8 Flash",
            family: "Google Antigravity",
            agentKind: "agy",
            desc: "超低延迟响应与多模态工具协同"
        ),
        VeloModelOption(
            id: "grok-4.7",
            label: "Grok 4.7",
            shortLabel: "Grok 4.7",
            family: "xAI Grok",
            agentKind: "grok",
            desc: "xAI 最新一代编码与推理模型",
            isDefault: true
        ),
        VeloModelOption(
            id: "grok-4.6",
            label: "Grok 4.6",
            shortLabel: "Grok 4.6",
            family: "xAI Grok",
            agentKind: "grok",
            desc: "稳健高速工具调用与代码改动"
        ),
        VeloModelOption(
            id: "cursor:auto",
            label: "Cursor Auto",
            shortLabel: "Cursor Auto",
            family: "Cursor",
            agentKind: "cursor",
            desc: "Cursor CLI 智能自动路由模型",
            isDefault: true
        ),
        VeloModelOption(
            id: "cursor:composer",
            label: "Cursor Composer",
            shortLabel: "Composer",
            family: "Cursor",
            agentKind: "cursor",
            desc: "Cursor 原生多文件极速编辑模型"
        ),
    ]

    public static func shortLabel(for modelId: String) -> String {
        if let found = defaults.first(where: { $0.id == modelId }) {
            return found.shortLabel
        }
        if modelId.hasPrefix("cursor:") {
            return String(modelId.dropFirst("cursor:".count)).capitalized
        }
        return modelId
            .replacingOccurrences(of: "-high", with: "")
            .replacingOccurrences(of: "-medium", with: "")
    }
}

// MARK: - 3. Timeline, Diff & Formatting Helpers

public enum AgentLivePhase: Equatable, Sendable {
    case thinking
    case tool(verb: String)
    case working
    case writing
    case waiting(label: String)
}

public enum TimelineEventKind: Codable, Equatable, Sendable {
    case user(images: [String])
    case thinking(startedAt: Date?, durationMs: Int?, isStreaming: Bool)
    case toolCall(
        toolName: String,
        displayName: String,
        workingVerb: String,
        summary: String,
        output: String?,
        isError: Bool
    )
    case assistant(isStreaming: Bool)
    case error(
        isAuthRequired: Bool,
        provider: String,
        loginCommand: String,
        authURL: String?
    )
}

public struct TurnUsageTelemetry: Codable, Equatable, Sendable {
    public var tps: Double?
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    public var contextWindow: Int
    public var costUsd: Double

    public init(
        tps: Double? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        contextWindow: Int = 0,
        costUsd: Double = 0.0
    ) {
        self.tps = tps
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.contextWindow = contextWindow
        self.costUsd = costUsd
    }

    public var totalTokens: Int {
        inputTokens + outputTokens
    }

    public var cacheHitPercent: Int? {
        guard inputTokens > 0, cacheReadTokens > 0 else { return nil }
        return min(100, Int((Double(cacheReadTokens) / Double(inputTokens) * 100.0).rounded()))
    }
}

public struct TimelineEventItem: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var timestamp: String
    public var content: String
    public var kind: TimelineEventKind
    public var durationMs: Int?
    public var completedAt: String?
    public var telemetry: TurnUsageTelemetry? = nil
    public var inlineDiffOld: String? = nil
    public var inlineDiffNew: String? = nil
    public var subagentRole: String? = nil
    public var subagentPrompt: String? = nil
    public var clientMsgId: String? = nil
}

public enum VeloInlineDiffExtractor {
    public static func extract(
        toolName: String,
        inputObj: Any?
    ) -> (oldText: String?, newText: String?, subagentRole: String?, subagentPrompt: String?) {
        let lower = toolName.lowercased()
        let dict: [String: Any]? = {
            if let d = inputObj as? [String: Any] { return d }
            if let str = inputObj as? String,
               str.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{"),
               let data = str.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                return obj
            }
            return nil
        }()

        guard let dict else { return (nil, nil, nil, nil) }

        // 1. Subagent delegation (`Task`, `invoke_subagent`, `Agent`)
        if lower == "task" || lower == "agent" || lower.contains("subagent") {
            let role = (dict["subagent_type"] as? String)
                ?? (dict["Role"] as? String)
                ?? (dict["role"] as? String)
                ?? (dict["description"] as? String)
                ?? "Subagent"
            let prompt = (dict["prompt"] as? String)
                ?? (dict["Prompt"] as? String)
                ?? (dict["description"] as? String)
                ?? ""
            return (nil, nil, String(role.prefix(64)), String(prompt.prefix(400)))
        }

        // 2. Edit / Replace (`old_string` / `new_string` or `Target` / `Replacement`)
        let oldStr = (dict["old_string"] as? String)
            ?? (dict["old_str"] as? String)
            ?? (dict["Target"] as? String)
        let newStr = (dict["new_string"] as? String)
            ?? (dict["new_str"] as? String)
            ?? (dict["Replacement"] as? String)
        if oldStr != nil || newStr != nil {
            let o = oldStr.map { String($0.prefix(1200)) }
            let n = newStr.map { String($0.prefix(1200)) }
            return (o, n, nil, nil)
        }

        // 3. MultiEdit (`edits: [{ old_string, new_string }]`)
        if let edits = dict["edits"] as? [[String: Any]], !edits.isEmpty {
            var oldParts: [String] = []
            var newParts: [String] = []
            for e in edits.prefix(4) {
                if let eo = e["old_string"] as? String, !eo.isEmpty { oldParts.append(eo) }
                if let en = e["new_string"] as? String, !en.isEmpty { newParts.append(en) }
            }
            if !oldParts.isEmpty || !newParts.isEmpty {
                return (
                    String(oldParts.joined(separator: "\n").prefix(1200)),
                    String(newParts.joined(separator: "\n").prefix(1200)),
                    nil,
                    nil
                )
            }
        }

        // 4. Unified patch (`apply_patch` / `patch`)
        if let patch = (dict["patch"] as? String) ?? (dict["diff"] as? String) {
            var dels: [String] = []
            var adds: [String] = []
            for line in patch.components(separatedBy: .newlines).prefix(60) {
                if line.hasPrefix("-") && !line.hasPrefix("---") {
                    dels.append(String(line.dropFirst()))
                } else if line.hasPrefix("+") && !line.hasPrefix("+++") {
                    adds.append(String(line.dropFirst()))
                }
            }
            if !dels.isEmpty || !adds.isEmpty {
                return (
                    dels.isEmpty ? nil : String(dels.joined(separator: "\n").prefix(1000)),
                    adds.isEmpty ? nil : String(adds.joined(separator: "\n").prefix(1000)),
                    nil,
                    nil
                )
            }
        }

        // 5. Write file (`content`)
        if lower == "write" || lower == "write_file",
           let content = (dict["content"] as? String) ?? (dict["Content"] as? String),
           !content.isEmpty
        {
            let firstLines = content.components(separatedBy: .newlines).prefix(18).joined(separator: "\n")
            return (nil, String(firstLines.prefix(900)), nil, nil)
        }

        return (nil, nil, nil, nil)
    }
}

public struct VeloLocalCacheSnapshot: Codable, Sendable {
    public var sessions: [VeloSessionItem]
    public var workspaces: [String]
    public var models: [VeloModelOption]
    public var activeSessionId: String?
    public var eventsBySession: [String: [TimelineEventItem]]

    public init(
        sessions: [VeloSessionItem],
        workspaces: [String],
        models: [VeloModelOption],
        activeSessionId: String?,
        eventsBySession: [String: [TimelineEventItem]]
    ) {
        self.sessions = sessions
        self.workspaces = workspaces
        self.models = models
        self.activeSessionId = activeSessionId
        self.eventsBySession = eventsBySession
    }

    private static var cacheFileURL: URL? {
        guard let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }
        let dir = base.appendingPathComponent("VeloLocalCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("state-v1.json")
    }

    public static func load() -> VeloLocalCacheSnapshot? {
        guard let url = cacheFileURL,
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(VeloLocalCacheSnapshot.self, from: data)
    }

    public func trimmedForDisk() -> VeloLocalCacheSnapshot {
        let keepSessionIds = Set(sessions.prefix(40).map(\.id))
        var compactEvents: [String: [TimelineEventItem]] = [:]
        for (sid, list) in eventsBySession {
            guard keepSessionIds.isEmpty || keepSessionIds.contains(sid) else { continue }
            let slice = list.suffix(240).map { item -> TimelineEventItem in
                var copy = item
                if copy.content.count > 12_000 {
                    copy.content = String(copy.content.prefix(12_000))
                }
                if case .toolCall(let tn, let dn, let wv, let sum, let out, let err) = copy.kind,
                   let out, out.count > 3_000
                {
                    copy.kind = .toolCall(
                        toolName: tn,
                        displayName: dn,
                        workingVerb: wv,
                        summary: sum,
                        output: String(out.prefix(3_000)) + "\n…",
                        isError: err
                    )
                }
                return copy
            }
            compactEvents[sid] = Array(slice)
        }
        return VeloLocalCacheSnapshot(
            sessions: Array(sessions.prefix(60)),
            workspaces: workspaces,
            models: models,
            activeSessionId: activeSessionId,
            eventsBySession: compactEvents
        )
    }

    public func writeToDisk() {
        guard let url = Self.cacheFileURL else { return }
        let slim = trimmedForDisk()
        guard let data = try? JSONEncoder().encode(slim) else { return }
        try? data.write(to: url, options: .atomic)
    }

    public static func clear() {
        guard let url = cacheFileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

public struct ConversationTurnBlock: Identifiable, Equatable, Sendable {
    public let id: String
    public var userEvent: TimelineEventItem?
    public var items: [TimelineEventItem]
}

public struct PendingApprovalPrompt: Identifiable, Equatable, Sendable {
    public let id: String
    public let toolName: String
    public let commandPreview: String
    public let reason: String
}

public struct PendingQuestionPrompt: Identifiable, Equatable, Sendable {
    public let id: String
    public let question: String
    public let options: [String]
    public let allowMultiple: Bool
}

public struct DiffLineRow: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public enum Kind: Sendable {
        case context
        case addition
        case deletion
        case header
    }
    public let kind: Kind
    public let text: String
}

public struct DiffFileSection: Identifiable, Equatable, Sendable {
    public var id: String { path }
    public let path: String
    public var additions: Int
    public var deletions: Int
    public var lines: [DiffLineRow]
}

public enum VeloFormatting {
    public static func shortenHomePath(_ raw: String) -> String {
        if raw.hasPrefix("/Users/") {
            let parts = raw.split(separator: "/", omittingEmptySubsequences: true)
            if parts.count >= 2 {
                let tail = parts.dropFirst(2).joined(separator: "/")
                return tail.isEmpty ? "~" : "~/\(tail)"
            }
        }
        return raw
    }

    public static func canonicalWorkspacePath(_ raw: String, macHomeHint: String? = nil) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return macHomeHint ?? "~/workspace" }
        if s == "~", let hint = macHomeHint {
            return hint
        }
        if s.hasPrefix("~/"), let home = macHomeHint {
            s = home + String(s.dropFirst(1))
        }
        while s.count > 1 && s.hasSuffix("/") {
            s.removeLast()
        }
        return s
    }

    public static func formatCompactTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000.0)
        }
        if count >= 1_000 {
            let k = Double(count) / 1_000.0
            return k >= 100 ? String(format: "%.0fk", k) : String(format: "%.1fk", k)
        }
        return "\(count)"
    }

    public static func formatUsd(_ usd: Double) -> String {
        if usd >= 0.10 {
            return String(format: "$%.2f", usd)
        }
        if usd >= 0.001 {
            return String(format: "$%.3f", usd)
        }
        return String(format: "$%.4f", usd)
    }

    public static func formatDuration(ms: Int) -> String {
        let totalSec = max(1, Int((Double(ms) / 1000.0).rounded()))
        if totalSec < 60 {
            return "\(totalSec)s"
        }
        let mins = totalSec / 60
        let secs = totalSec % 60
        return secs > 0 ? "\(mins)m \(secs)s" : "\(mins)m"
    }

    public static func parseReasoning(_ raw: String) -> (summary: String, lines: [String]) {
        let lines = raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter {
                !$0.isEmpty
                    && !$0.hasPrefix("正在分析工作区上下文")
                    && !$0.hasPrefix("推理完成（思考")
            }
        guard !lines.isEmpty else { return ("", []) }

        for line in lines.reversed() {
            if line.hasPrefix("**"), line.hasSuffix("**"), line.count > 4 {
                let clean = String(line.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
                return (clean, lines)
            }
        }
        let fallback = lines.last?.replacingOccurrences(of: "**", with: "") ?? ""
        return (fallback, lines)
    }

    public static func presentTool(
        toolName: String,
        argsDict: [String: Any]?,
        output: String?
    ) -> (displayName: String, workingVerb: String, summary: String, iconSystemName: String) {
        let lower = toolName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let command = (argsDict?["command"] as? String)
            ?? (argsDict?["CommandLine"] as? String)
            ?? (argsDict?["cmd"] as? String)
            ?? ""
        let rawPath = (argsDict?["file_path"] as? String)
            ?? (argsDict?["path"] as? String)
            ?? (argsDict?["Path"] as? String)
            ?? (argsDict?["TargetFile"] as? String)
            ?? (argsDict?["AbsolutePath"] as? String)
            ?? (argsDict?["DirectoryPath"] as? String)
            ?? (argsDict?["target"] as? String)
            ?? ""
        let shortPath = rawPath.split(separator: "/").suffix(2).joined(separator: "/")

        var query = (argsDict?["pattern"] as? String)
            ?? (argsDict?["Pattern"] as? String)
            ?? (argsDict?["query"] as? String)
            ?? (argsDict?["Query"] as? String)
            ?? ""
        if query.isEmpty, let output {
            let firstLine = output.components(separatedBy: .newlines).first ?? ""
            if firstLine.lowercased().hasPrefix("searched:") {
                query = String(firstLine.dropFirst(9)).trimmingCharacters(in: .whitespaces)
            }
        }

        if lower == "call_mcp_tool" || lower.hasPrefix("mcp_") {
            let rawServer = (argsDict?["ServerName"] as? String)
                ?? (argsDict?["server_name"] as? String)
                ?? (lower.hasPrefix("mcp_") ? toolName.split(separator: "_").dropFirst().dropLast().joined(separator: "_") : "MCP")
            let rawTool = (argsDict?["ToolName"] as? String)
                ?? (argsDict?["tool_name"] as? String)
                ?? (lower.hasPrefix("mcp_") ? String(toolName.split(separator: "_").last ?? "") : toolName)
            let serverLabel: String = {
                let sl = rawServer.lowercased()
                if sl.contains("chrome-devtools") { return "Chrome DevTools" }
                if sl.contains("playwright") { return "Playwright" }
                if sl.contains("github") { return "GitHub" }
                if sl.contains("figma") { return "Figma" }
                return rawServer
                    .replacingOccurrences(of: "_", with: " ")
                    .replacingOccurrences(of: "-", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }()
            let actionMap: [String: String] = [
                "take_screenshot": "Screenshot",
                "take_snapshot": "Snapshot",
                "click": "Click",
                "evaluate_script": "Evaluate",
                "list_console_messages": "Console",
                "list_pages": "Pages",
                "navigate_page": "Navigate",
                "new_page": "New page",
                "fill": "Fill",
                "fill_form": "Fill form",
                "hover": "Hover",
                "wait_for": "Wait",
                "list_network_requests": "Network",
            ]
            let actionLabel = actionMap[rawTool.lowercased()] ?? rawTool.replacingOccurrences(of: "_", with: " ")
            let srv = serverLabel.isEmpty ? "MCP" : serverLabel
            return (
                srv,
                "\(srv) · \(actionLabel)",
                actionLabel,
                "sparkles"
            )
        }

        if lower == "bash" || lower.contains("shell") || lower.contains("exec") || lower.contains("command") {
            let shortCmd = command.isEmpty ? "" : String(command.prefix(42))
            return (
                "Shell",
                shortCmd.isEmpty ? "Running command" : "Running `\(shortCmd)`",
                command,
                "terminal"
            )
        }
        if lower == "read" || lower.contains("read_file") || lower.contains("view") {
            return (
                "Read",
                shortPath.isEmpty ? "Reading file" : "Reading \(shortPath)",
                shortPath.isEmpty ? rawPath : shortPath,
                "doc.text"
            )
        }
        if lower == "edit" || lower == "write" || lower.contains("patch") || lower.contains("replace") {
            return (
                "Edit",
                shortPath.isEmpty ? "Editing code" : "Editing \(shortPath)",
                shortPath.isEmpty ? rawPath : shortPath,
                "pencil.line"
            )
        }
        if lower.contains("search") || lower.contains("grep") || lower.contains("glob") || lower.contains("find") {
            let qShort = String(query.prefix(34))
            return (
                "Search",
                qShort.isEmpty ? "Searching" : "Searching \"\(qShort)\"",
                query.isEmpty ? shortPath : query,
                "magnifyingglass"
            )
        }
        if lower.hasPrefix("mcp__") || lower.hasPrefix("mcp:") || lower.contains(":") {
            let cleanMcp: String = {
                if toolName.hasPrefix("mcp__") {
                    let parts = toolName.dropFirst(5).components(separatedBy: "__")
                    if parts.count >= 2 {
                        return "\(parts[0]):\(parts.dropFirst().joined(separator: "_"))"
                    }
                    return String(toolName.dropFirst(5))
                }
                if toolName.lowercased().hasPrefix("mcp:") {
                    return String(toolName.dropFirst(4))
                }
                return toolName
            }()
            let argSnippet = shortPath.isEmpty ? (command.isEmpty ? query : String(command.prefix(36))) : shortPath
            return (
                "MCP · \(cleanMcp)",
                "MCP · \(cleanMcp)",
                argSnippet,
                "puzzlepiece.extension"
            )
        }
        return (
            toolName,
            "Running \(toolName)",
            shortPath.isEmpty ? (command.isEmpty ? query : command) : shortPath,
            "wrench.and.screwdriver"
        )
    }

    public static func summarizeExecutionTrace(_ items: [TimelineEventItem]) -> (
        title: String,
        activeLabel: String?,
        hasError: Bool,
        isRunning: Bool,
        thoughtCount: Int,
        toolCount: Int
    ) {
        var thoughts = 0
        var mcpCount = 0
        var reads = 0
        var edits = 0
        var commands = 0
        var searches = 0
        var others = 0
        var hasError = false
        var activeLabel: String?

        for item in items {
            switch item.kind {
            case .thinking(_, _, let isStreaming):
                thoughts += 1
                if isStreaming {
                    let parsed = parseReasoning(item.content)
                    activeLabel = parsed.summary.isEmpty ? "正在思考…" : "思考中 · \(parsed.summary)"
                }
            case .toolCall(_, let displayName, let verb, _, let output, let err):
                if err { hasError = true }
                if output == nil { activeLabel = verb }
                if displayName.hasPrefix("MCP") {
                    mcpCount += 1
                } else {
                    switch displayName {
                    case "Read": reads += 1
                    case "Edit": edits += 1
                    case "Shell": commands += 1
                    case "Search": searches += 1
                    default: others += 1
                    }
                }
            default:
                break
            }
        }

        let toolTotal = mcpCount + reads + edits + commands + searches + others
        var parts: [String] = []
        if thoughts > 0 { parts.append("思考 \(thoughts) 次") }
        if mcpCount > 0 { parts.append("MCP \(mcpCount) 次") }
        if reads > 0 { parts.append("读取 \(reads)") }
        if searches > 0 { parts.append("搜索 \(searches)") }
        if edits > 0 { parts.append("编辑 \(edits)") }
        if commands > 0 { parts.append("命令 \(commands)") }
        if others > 0 { parts.append("工具 \(others)") }

        let summaryDetail = parts.isEmpty ? "执行完毕" : parts.joined(separator: " · ")
        let title = "已收起 \(items.count) 步 · \(summaryDetail)"
        return (title, activeLabel, hasError, activeLabel != nil, thoughts, toolTotal)
    }

    public static func summarizeToolBatch(_ items: [TimelineEventItem]) -> (title: String, activeVerb: String?, hasError: Bool, isRunning: Bool) {
        var reads = 0
        var edits = 0
        var commands = 0
        var searches = 0
        var others = 0
        var hasError = false
        var activeVerb: String?

        for item in items {
            guard case .toolCall(_, let displayName, let verb, _, let output, let err) = item.kind else { continue }
            if err { hasError = true }
            if output == nil { activeVerb = verb }
            switch displayName {
            case "Read": reads += 1
            case "Edit": edits += 1
            case "Shell": commands += 1
            case "Search": searches += 1
            default: others += 1
            }
        }

        var parts: [String] = []
        if reads > 0 { parts.append("读取 \(reads) 个文件") }
        if searches > 0 { parts.append("搜索 \(searches) 次") }
        if edits > 0 { parts.append("编辑 \(edits) 处") }
        if commands > 0 { parts.append("执行 \(commands) 条命令") }
        if others > 0 { parts.append("其他 \(others) 项") }

        let detail = parts.isEmpty ? "已完成" : parts.joined(separator: " · ")
        let title = "已调用 \(items.count) 个工具 · \(detail)"
        return (title, activeVerb, hasError, activeVerb != nil)
    }

    public static func parseUnifiedDiff(_ rawDiff: String) -> [DiffFileSection] {
        guard !rawDiff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var files: [DiffFileSection] = []
        var currentPath: String?
        var currentAdds = 0
        var currentDels = 0
        var currentLines: [DiffLineRow] = []

        func flushCurrent() {
            if let path = currentPath {
                files.append(
                    DiffFileSection(
                        path: path,
                        additions: currentAdds,
                        deletions: currentDels,
                        lines: currentLines
                    )
                )
            }
            currentPath = nil
            currentAdds = 0
            currentDels = 0
            currentLines = []
        }

        for rawLine in rawDiff.components(separatedBy: "\n") {
            if rawLine.hasPrefix("diff --git ") {
                flushCurrent()
                let parts = rawLine.components(separatedBy: " b/")
                currentPath = parts.count > 1 ? parts[1] : rawLine
            } else if rawLine.hasPrefix("+++ b/") {
                currentPath = String(rawLine.dropFirst(6))
            } else if rawLine.hasPrefix("--- ") || rawLine.hasPrefix("index ") {
                continue
            } else if rawLine.hasPrefix("@@") {
                currentLines.append(DiffLineRow(kind: .header, text: rawLine))
            } else if rawLine.hasPrefix("+") {
                currentAdds += 1
                currentLines.append(DiffLineRow(kind: .addition, text: rawLine))
            } else if rawLine.hasPrefix("-") {
                currentDels += 1
                currentLines.append(DiffLineRow(kind: .deletion, text: rawLine))
            } else if currentPath != nil {
                currentLines.append(DiffLineRow(kind: .context, text: rawLine))
            }
        }
        flushCurrent()
        return files
    }

    public static func defaultLoginCommand(for provider: String) -> String {
        let p = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if p == "cursor" || p.contains("cursor") { return "cursor-agent login" }
        if p == "agy" || p.contains("antigravity") || p.contains("gemini") { return "agy -i \"hi\"" }
        if p == "claude" || p.contains("anthropic") { return "claude login" }
        if p == "codex" || p.contains("openai") { return "codex login" }
        if p == "grok" || p.contains("xai") { return "export XAI_API_KEY=..." }
        return "\(p.isEmpty ? "agy" : p) login"
    }

    public static func providerDisplayName(_ provider: String) -> String {
        let p = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if p == "agy" || p.contains("antigravity") || p.contains("gemini") { return "Antigravity CLI (agy)" }
        if p == "cursor" || p.contains("cursor") { return "Cursor CLI" }
        if p == "claude" { return "Claude Code" }
        if p == "codex" { return "OpenAI Codex" }
        if p == "grok" { return "xAI Grok CLI" }
        return provider.uppercased()
    }

    public static func parseAgentError(
        _ raw: String,
        fallbackProvider: String
    ) -> (message: String, isAuthRequired: Bool, provider: String, loginCommand: String, authURL: String?) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var provider = fallbackProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if provider.isEmpty { provider = "agy" }

        if trimmed.hasPrefix("[AUTH_REQUIRED|"),
           let closeRange = trimmed.range(of: "]")
        {
            let header = String(trimmed[trimmed.index(trimmed.startIndex, offsetBy: 15)..<closeRange.lowerBound])
            let parts = header.components(separatedBy: "|")
            let prov = (parts.first ?? provider).trimmingCharacters(in: .whitespacesAndNewlines)
            if !prov.isEmpty { provider = prov }
            let cmd = parts.count > 1 && !parts[1].trimmingCharacters(in: .whitespaces).isEmpty
                ? parts[1].trimmingCharacters(in: .whitespaces)
                : defaultLoginCommand(for: provider)
            let urlStr: String? = {
                guard parts.count > 2 else { return nil }
                let u = parts[2].trimmingCharacters(in: .whitespacesAndNewlines)
                return u.hasPrefix("http") ? u : nil
            }()
            let body = String(trimmed[closeRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanBody = cleanErrorText(body, provider: provider, isAuth: true)
            return (cleanBody, true, provider, cmd, urlStr ?? extractFirstAuthURL(from: body))
        }

        let lower = trimmed.lowercased()
        let isAuth = lower.contains("authentication required")
            || lower.contains("authentication timed out")
            || lower.contains("waiting for authentication")
            || lower.contains("please visit the url to log in")
            || lower.contains("agent login")
            || lower.contains("not logged in")
            || lower.contains("login required")
            || lower.contains("re-authenticate")
            || lower.contains("unauthenticated")
            || lower.contains("401 unauthorized")
            || lower.contains("invalid_api_key")
            || lower.contains("missing api key")
            || lower.contains("xai_api_key")
            || lower.contains("openai_api_key")
            || lower.contains("anthropic_api_key")

        if lower.contains("cursor-agent") || lower.contains("agent login") {
            provider = "cursor"
        } else if lower.contains("accounts.google.com") || lower.contains("antigravity") || lower.contains("agy") {
            provider = "agy"
        }

        let cmd = defaultLoginCommand(for: provider)
        let urlStr = isAuth ? extractFirstAuthURL(from: trimmed) : nil
        let cleanMsg = cleanErrorText(trimmed, provider: provider, isAuth: isAuth)
        return (cleanMsg, isAuth, provider, cmd, urlStr)
    }

    private static func extractFirstAuthURL(from text: String) -> String? {
        for token in text.components(separatedBy: .whitespacesAndNewlines) {
            let clean = token.trimmingCharacters(in: CharacterSet(charactersIn: "()[]<>\"'.,;"))
            if (clean.hasPrefix("https://") || clean.hasPrefix("http://"))
                && !clean.contains("127.0.0.1")
                && !clean.contains("localhost")
            {
                return clean
            }
        }
        return nil
    }

    private static func cleanErrorText(_ raw: String, provider: String, isAuth: Bool) -> String {
        let lines = raw
            .components(separatedBy: .newlines)
            .map {
                $0.replacingOccurrences(of: "[stderr]", with: "")
                    .replacingOccurrences(of: "⚠️", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { line in
                guard !line.isEmpty else { return false }
                let l = line.lowercased()
                if l.hasPrefix("http://") || l.hasPrefix("https://") { return false }
                if l.hasPrefix("waiting for authentication") { return false }
                return true
            }

        if isAuth {
            let provName = providerDisplayName(provider)
            if lines.isEmpty {
                return "\(provName) 登录态已失效或网络刷新令牌超时，请在 Mac 终端重新完成登录授权。"
            }
            let joined = lines.prefix(2).joined(separator: " ")
            if joined.lowercased().contains("authentication timed out")
                || joined.lowercased().contains("please visit the url to log in")
            {
                return "\(provName) 认证已过期（或代理未就绪导致 OAuth 刷新失败），请点击下方按钮在 Mac 终端完成登录。"
            }
            return joined
        }
        return lines.isEmpty ? "CLI 进程异常退出，未返回有效响应。" : lines.prefix(3).joined(separator: "\n")
    }
}

// MARK: - Analytics, Search, PR, Push & Automations DTOs

public struct VeloUsageBucket: Identifiable, Equatable {
    public var id: String { key }
    public let key: String
    public let label: String
    public let sessionsCount: Int
    public let turnsCount: Int
    public let inputTokens: Int
    public let cacheReadTokens: Int
    public let outputTokens: Int
    public let cacheHitPct: Double
    public let avgTps: Double
    public let costUsd: Double

    public static func fromJSON(_ d: [String: Any]) -> VeloUsageBucket {
        VeloUsageBucket(
            key: (d["key"] as? String) ?? UUID().uuidString,
            label: (d["label"] as? String) ?? "—",
            sessionsCount: VeloSessionItem.intValue(d["sessions_count"]) ?? 0,
            turnsCount: VeloSessionItem.intValue(d["turns_count"]) ?? 0,
            inputTokens: VeloSessionItem.intValue(d["input_tokens"]) ?? 0,
            cacheReadTokens: VeloSessionItem.intValue(d["cache_read_tokens"]) ?? 0,
            outputTokens: VeloSessionItem.intValue(d["output_tokens"]) ?? 0,
            cacheHitPct: VeloSessionItem.doubleValue(d["cache_hit_pct"]) ?? 0,
            avgTps: VeloSessionItem.doubleValue(d["avg_tps"]) ?? 0,
            costUsd: VeloSessionItem.doubleValue(d["cost_usd"]) ?? 0
        )
    }
}

public struct VeloModelCostBucket: Identifiable, Equatable {
    public var id: String { "\(provider)-\(model)" }
    public let model: String
    public let provider: String
    public let turnsCount: Int
    public let inputTokens: Int
    public let uncachedInputTokens: Int
    public let cacheReadTokens: Int
    public let outputTokens: Int
    public let inputPerM: Double
    public let cachedInputPerM: Double
    public let outputPerM: Double
    public let costUsd: Double

    public static func fromJSON(_ d: [String: Any]) -> VeloModelCostBucket {
        VeloModelCostBucket(
            model: (d["model"] as? String) ?? "unknown",
            provider: (d["provider"] as? String) ?? "agent",
            turnsCount: VeloSessionItem.intValue(d["turns_count"]) ?? 0,
            inputTokens: VeloSessionItem.intValue(d["input_tokens"]) ?? 0,
            uncachedInputTokens: VeloSessionItem.intValue(d["uncached_input_tokens"]) ?? 0,
            cacheReadTokens: VeloSessionItem.intValue(d["cache_read_tokens"]) ?? 0,
            outputTokens: VeloSessionItem.intValue(d["output_tokens"]) ?? 0,
            inputPerM: VeloSessionItem.doubleValue(d["input_per_m"]) ?? 0,
            cachedInputPerM: VeloSessionItem.doubleValue(d["cached_input_per_m"]) ?? 0,
            outputPerM: VeloSessionItem.doubleValue(d["output_per_m"]) ?? 0,
            costUsd: VeloSessionItem.doubleValue(d["cost_usd"]) ?? 0
        )
    }
}

public struct VeloUsageAnalytics: Equatable {
    public let sessionsCount: Int
    public let turnsCount: Int
    public let inputTokens: Int
    public let cacheReadTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int
    public let cacheHitPct: Double
    public let avgTps: Double
    public let totalCostUsd: Double
    public let todayCostUsd: Double
    public let todayTokens: Int
    public let byProvider: [VeloUsageBucket]
    public let byModel: [VeloModelCostBucket]
    public let byWorkspace: [VeloUsageBucket]

    public static func fromJSON(_ d: [String: Any]) -> VeloUsageAnalytics {
        let provArr = (d["by_provider"] as? [[String: Any]]) ?? []
        let modelArr = (d["by_model"] as? [[String: Any]]) ?? []
        let wsArr = (d["by_workspace"] as? [[String: Any]]) ?? []
        return VeloUsageAnalytics(
            sessionsCount: VeloSessionItem.intValue(d["sessions_count"]) ?? 0,
            turnsCount: VeloSessionItem.intValue(d["turns_count"]) ?? 0,
            inputTokens: VeloSessionItem.intValue(d["input_tokens"]) ?? 0,
            cacheReadTokens: VeloSessionItem.intValue(d["cache_read_tokens"]) ?? 0,
            outputTokens: VeloSessionItem.intValue(d["output_tokens"]) ?? 0,
            totalTokens: VeloSessionItem.intValue(d["total_tokens"]) ?? 0,
            cacheHitPct: VeloSessionItem.doubleValue(d["cache_hit_pct"]) ?? 0,
            avgTps: VeloSessionItem.doubleValue(d["avg_tps"]) ?? 0,
            totalCostUsd: VeloSessionItem.doubleValue(d["total_cost_usd"]) ?? 0,
            todayCostUsd: VeloSessionItem.doubleValue(d["today_cost_usd"]) ?? 0,
            todayTokens: VeloSessionItem.intValue(d["today_tokens"]) ?? 0,
            byProvider: provArr.map(VeloUsageBucket.fromJSON),
            byModel: modelArr.map(VeloModelCostBucket.fromJSON),
            byWorkspace: wsArr.map(VeloUsageBucket.fromJSON)
        )
    }
}

public struct VeloSearchHit: Identifiable, Equatable {
    public let id: String
    public let sessionId: String
    public let sessionName: String
    public let repoRoot: String
    public let provider: String
    public let kind: String
    public let snippet: String
    public let timestampMs: Int64

    public static func fromJSON(_ d: [String: Any], index: Int) -> VeloSearchHit? {
        guard let sid = d["session_id"] as? String, !sid.isEmpty else { return nil }
        let ts = Int64(VeloSessionItem.intValue(d["timestamp_ms"]) ?? 0)
        return VeloSearchHit(
            id: "\(sid)-\(ts)-\(index)",
            sessionId: sid,
            sessionName: (d["session_name"] as? String) ?? "会话",
            repoRoot: (d["repo_root"] as? String) ?? "",
            provider: (d["provider"] as? String) ?? "agent",
            kind: (d["kind"] as? String) ?? "message",
            snippet: (d["snippet"] as? String) ?? "",
            timestampMs: ts
        )
    }
}

public struct VeloPushConfig: Codable, Equatable {
    public var enabled: Bool
    public var barkTarget: String
    public var webhookUrl: String
    public var blindMode: Bool
    public var notifyOnPermission: Bool
    public var notifyOnComplete: Bool
    public var notifyOnError: Bool

    public init(
        enabled: Bool = false,
        barkTarget: String = "",
        webhookUrl: String = "",
        blindMode: Bool = true,
        notifyOnPermission: Bool = true,
        notifyOnComplete: Bool = true,
        notifyOnError: Bool = true
    ) {
        self.enabled = enabled
        self.barkTarget = barkTarget
        self.webhookUrl = webhookUrl
        self.blindMode = blindMode
        self.notifyOnPermission = notifyOnPermission
        self.notifyOnComplete = notifyOnComplete
        self.notifyOnError = notifyOnError
    }

    public static func fromJSON(_ d: [String: Any]) -> VeloPushConfig {
        VeloPushConfig(
            enabled: (d["enabled"] as? Bool) ?? false,
            barkTarget: (d["bark_target"] as? String) ?? "",
            webhookUrl: (d["webhook_url"] as? String) ?? "",
            blindMode: (d["blind_mode"] as? Bool) ?? true,
            notifyOnPermission: (d["notify_on_permission"] as? Bool) ?? true,
            notifyOnComplete: (d["notify_on_complete"] as? Bool) ?? true,
            notifyOnError: (d["notify_on_error"] as? Bool) ?? true
        )
    }

    public func toJSON() -> [String: Any] {
        [
            "enabled": enabled,
            "bark_target": barkTarget,
            "webhook_url": webhookUrl,
            "blind_mode": blindMode,
            "notify_on_permission": notifyOnPermission,
            "notify_on_complete": notifyOnComplete,
            "notify_on_error": notifyOnError,
        ]
    }
}

public struct VeloPrCheckItem: Identifiable, Equatable {
    public var id: String { name }
    public let name: String
    public let status: String
    public let conclusion: String
}

public struct VeloPrSnapshot: Equatable {
    public let exists: Bool
    public let number: Int?
    public let title: String
    public let url: String
    public let state: String
    public let isDraft: Bool
    public let mergeable: String
    public let checks: [VeloPrCheckItem]
    public let message: String?

    public static func fromJSON(_ d: [String: Any]) -> VeloPrSnapshot {
        let exists = (d["exists"] as? Bool) ?? false
        let prObj = (d["pr"] as? [String: Any]) ?? [:]
        let rawChecks = (d["checks"] as? [[String: Any]]) ?? []
        let checks = rawChecks.map { c in
            VeloPrCheckItem(
                name: (c["name"] as? String) ?? "check",
                status: (c["status"] as? String) ?? "",
                conclusion: (c["conclusion"] as? String) ?? ""
            )
        }
        return VeloPrSnapshot(
            exists: exists,
            number: VeloSessionItem.intValue(prObj["number"]),
            title: (prObj["title"] as? String) ?? "",
            url: (prObj["url"] as? String) ?? "",
            state: (prObj["state"] as? String) ?? "",
            isDraft: (prObj["isDraft"] as? Bool) ?? false,
            mergeable: (prObj["mergeable"] as? String) ?? "",
            checks: checks,
            message: d["message"] as? String ?? d["error"] as? String
        )
    }
}

public struct VeloAutomationItem: Identifiable, Equatable {
    public let id: String
    public let name: String
    public var enabled: Bool
    public let cronExpr: String
    public let scheduleText: String
    public let repoPath: String
    public let provider: String
    public let promptTemplate: String
    public let runCount: Int

    public static func fromJSON(_ d: [String: Any]) -> VeloAutomationItem? {
        guard let id = d["id"] as? String else { return nil }
        let prov: String = {
            if let p = d["provider"] as? String { return p }
            if let obj = d["provider"] as? [String: Any], let k = obj.keys.first { return k }
            return "claude"
        }()
        let cron = (d["cron_expr"] as? String) ?? ""
        let schedRaw = (d["schedule_text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let schedDisplay: String = {
            if !schedRaw.isEmpty { return schedRaw }
            let t = (d["trigger_type"] as? String) ?? "cron"
            if t == "github_webhook" { return "GitHub Webhook" }
            if t == "generic_webhook" { return "Webhook 触发" }
            if t == "once" { return "单次定时" }
            return cron.isEmpty ? "定时任务" : "定时 \(cron)"
        }()
        return VeloAutomationItem(
            id: id,
            name: (d["name"] as? String) ?? "定时任务",
            enabled: (d["enabled"] as? Bool) ?? true,
            cronExpr: cron,
            scheduleText: schedDisplay,
            repoPath: (d["repo_path"] as? String) ?? "",
            provider: prov,
            promptTemplate: (d["prompt_template"] as? String) ?? "",
            runCount: VeloSessionItem.intValue(d["run_count"]) ?? 0
        )
    }
}

// MARK: - 5. Subscription Rate-Limit Quotas & Multi-Host / SSH Nodes (v0.5.0)

public struct VeloQuotaWindowItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let usedPercent: Double
    public let remainingPercent: Double
    public let resetInSeconds: Int64?
    public let detailText: String?
    public let status: String

    public var resetCountdownLabel: String {
        guard let sec = resetInSeconds, sec > 0 else { return "" }
        let hrs = sec / 3600
        let mins = (sec % 3600) / 60
        if hrs >= 24 {
            return "\(hrs / 24)d \(hrs % 24)h 后重置"
        }
        if hrs > 0 {
            return "\(hrs)h \(mins)m 后重置"
        }
        return "\(max(1, mins))m 后重置"
    }

    public static func fromJSON(_ d: [String: Any]) -> VeloQuotaWindowItem? {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        let label = (d["label"] as? String) ?? id
        let used = VeloSessionItem.doubleValue(d["used_percent"]) ?? 0
        let rem = VeloSessionItem.doubleValue(d["remaining_percent"]) ?? max(0, 100 - used)
        let resetSec = VeloSessionItem.intValue(d["reset_in_seconds"]).map { Int64($0) }
        let detail = d["detail_text"] as? String
        let st = (d["status"] as? String) ?? "healthy"
        return VeloQuotaWindowItem(
            id: id,
            label: label,
            usedPercent: used,
            remainingPercent: rem,
            resetInSeconds: resetSec,
            detailText: detail,
            status: st
        )
    }
}

public struct VeloProviderQuotaCard: Identifiable, Equatable, Sendable {
    public var id: String { provider }
    public let provider: String
    public let label: String
    public let planBadge: String
    public let mode: String
    public let summaryText: String?
    public let windows: [VeloQuotaWindowItem]

    public static func fromJSON(_ d: [String: Any]) -> VeloProviderQuotaCard? {
        guard let provider = d["provider"] as? String, !provider.isEmpty else { return nil }
        let label = (d["label"] as? String) ?? provider.capitalized
        let badge = (d["plan_badge"] as? String) ?? "Subscription"
        let mode = (d["mode"] as? String) ?? "subscription"
        let summary = d["summary_text"] as? String
        let wins = ((d["windows"] as? [[String: Any]]) ?? []).compactMap(VeloQuotaWindowItem.fromJSON)
        return VeloProviderQuotaCard(
            provider: provider,
            label: label,
            planBadge: badge,
            mode: mode,
            summaryText: summary,
            windows: wins
        )
    }
}

public struct VeloRemoteHostItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let sshTarget: String
    public let defaultCwd: String
    public let isLocal: Bool
    public let status: String
    public let osInfo: String?
    public let detectedAgents: [String]

    public static func fromJSON(_ d: [String: Any]) -> VeloRemoteHostItem? {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        return VeloRemoteHostItem(
            id: id,
            label: (d["label"] as? String) ?? id,
            sshTarget: (d["ssh_target"] as? String) ?? "localhost",
            defaultCwd: (d["default_cwd"] as? String) ?? "~",
            isLocal: (d["is_local"] as? Bool) ?? (id == "local"),
            status: (d["status"] as? String) ?? "unknown",
            osInfo: d["os_info"] as? String,
            detectedAgents: (d["detected_agents"] as? [String]) ?? []
        )
    }
}

public struct VeloSavedHostProfile: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var config: ConnectionModeConfig
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, name: String, config: ConnectionModeConfig, updatedAt: Date = Date()) {
        self.id = id
        self.name = name
        self.config = config
        self.updatedAt = updatedAt
    }
}

// MARK: - 6. Turn Checkpoints, Local Extensions (MCP/Skills) & Offline Outbox (v0.6.0)

public struct VeloTurnCheckpointItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let turnIndex: Int
    public let promptPreview: String
    public let gitRef: String
    public let headShort: String
    public let hadDirtyChanges: Bool
    public let createdAtLabel: String

    public static func fromJSON(_ d: [String: Any]) -> VeloTurnCheckpointItem? {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        let turnIdx = VeloSessionItem.intValue(d["turn_index"]) ?? 1
        let preview = (d["prompt_preview"] as? String) ?? "执行前快照"
        let gitRef = (d["git_ref"] as? String) ?? ""
        let headShort = (d["head_short"] as? String) ?? String(gitRef.prefix(7))
        let dirty = (d["had_dirty_changes"] as? Bool) ?? false

        let createdLabel: String = {
            if let raw = d["created_at"] as? String {
                let isoFrac = ISO8601DateFormatter()
                isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let isoPlain = ISO8601DateFormatter()
                if let dt = isoFrac.date(from: raw) ?? isoPlain.date(from: raw) {
                    let f = DateFormatter()
                    f.dateFormat = "MM-dd HH:mm:ss"
                    return f.string(from: dt)
                }
            }
            return ""
        }()

        return VeloTurnCheckpointItem(
            id: id,
            turnIndex: turnIdx,
            promptPreview: preview,
            gitRef: gitRef,
            headShort: headShort,
            hadDirtyChanges: dirty,
            createdAtLabel: createdLabel
        )
    }
}

public struct VeloMcpServerItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let engine: String
    public let transport: String
    public let target: String
    public let enabled: Bool

    public static func fromJSON(_ d: [String: Any]) -> VeloMcpServerItem? {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        return VeloMcpServerItem(
            id: id,
            name: (d["name"] as? String) ?? id,
            engine: (d["engine"] as? String) ?? "local",
            transport: (d["transport"] as? String) ?? "stdio",
            target: (d["target"] as? String) ?? "",
            enabled: (d["enabled"] as? Bool) ?? true
        )
    }
}

public struct VeloSkillItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let engine: String
    public let scope: String
    public let editable: Bool
    public let description: String
    public let path: String

    public static func fromJSON(_ d: [String: Any]) -> VeloSkillItem? {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        return VeloSkillItem(
            id: id,
            name: (d["name"] as? String) ?? id,
            engine: (d["engine"] as? String) ?? "local",
            scope: (d["scope"] as? String) ?? "global",
            editable: (d["editable"] as? Bool) ?? false,
            description: (d["description"] as? String) ?? "",
            path: (d["path"] as? String) ?? ""
        )
    }

    /// `/Name` plus any task already in the composer. The skill file is attached on send.
    public func composerText(keeping current: String) -> String {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        let skill = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let task: String
        if trimmed.hasPrefix("/") {
            let body = String(trimmed.dropFirst())
            let lower = body.lowercased()
            let key = skill.lowercased()
            if lower == key {
                task = ""
            } else if !key.isEmpty, lower.hasPrefix(key + " ") {
                task = String(body.dropFirst(skill.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } else if let space = body.firstIndex(of: " ") {
                task = String(body[body.index(after: space)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                task = ""
            }
        } else {
            task = trimmed
        }
        if task.isEmpty {
            return "/\(skill) "
        }
        return "/\(skill) \(task)"
    }
}

public struct VeloOfflineQueuedPrompt: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let text: String
    public let model: String
    public let effort: String
    public let images: [String]
    public let approvalMode: String
    public let createdAt: Date

    public init(
        id: String = "off-\(UUID().uuidString.prefix(8))",
        sessionId: String,
        text: String,
        model: String,
        effort: String,
        images: [String] = [],
        approvalMode: String = "auto_edit",
        createdAt: Date = Date()
    ) {
        self.id = id
        self.sessionId = sessionId
        self.text = text
        self.model = model
        self.effort = effort
        self.images = images
        self.approvalMode = approvalMode
        self.createdAt = createdAt
    }
}
