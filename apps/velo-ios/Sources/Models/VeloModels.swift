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
            ? Color(red: 0.043, green: 0.047, blue: 0.059) // #0B0C0F Obsidian
            : Color(red: 0.965, green: 0.969, blue: 0.980) // #F6F7FA Editorial Light
    }

    public static func cardSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.078, green: 0.084, blue: 0.108) // #14151B
            : Color.white
    }

    public static func elevatedSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.110, green: 0.118, blue: 0.150) // #1C1E26
            : Color(red: 0.941, green: 0.949, blue: 0.969) // #F0F2F7
    }

    public static func codeSurface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.055, green: 0.059, blue: 0.075) // #0E0F13
            : Color(red: 0.957, green: 0.963, blue: 0.978)
    }

    public static func codeHeader(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.092, green: 0.098, blue: 0.125)
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
            ?? "/Users/daiyudai/code/velo"
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
            updatedAtLabel: updatedLabel
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

    public init(
        id: String,
        label: String,
        shortLabel: String,
        family: String,
        agentKind: String,
        desc: String = "",
        installed: Bool = true,
        isDefault: Bool = false
    ) {
        self.id = id
        self.label = label
        self.shortLabel = shortLabel
        self.family = family
        self.agentKind = agentKind
        self.desc = desc
        self.installed = installed
        self.isDefault = isDefault
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
    public static func canonicalWorkspacePath(_ raw: String, macHomeHint: String? = nil) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "/Users/daiyudai/code/velo" }
        if s == "~" {
            return macHomeHint ?? "/Users/daiyudai"
        }
        if s.hasPrefix("~/") {
            let home = macHomeHint ?? "/Users/daiyudai"
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
