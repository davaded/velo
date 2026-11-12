import Foundation

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

        // Check query parameters for E2EE relay credentials (`velo://pair?...` or `http://.../?mobile=1&relay=...&room=...&key=...`)
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

        // Bare host or IP (`192.168.1.20` or `192.168.1.20:6767`)
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

public struct VeloSessionItem: Identifiable, Equatable, Sendable {
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
    public var approvalMode: String
    public var filesChanged: Int
    public var insertions: Int
    public var deletions: Int
    public var updatedAtLabel: String

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
            if let rawName, !rawName.isEmpty { return rawName }
            if let rawPrompt, !rawPrompt.isEmpty { return String(rawPrompt.prefix(48)) }
            return branch
        }()

        let defaultModel: String = {
            if agentKind == "codex" { return "gpt-6.1-sol" }
            if agentKind == "grok" || agentKind.contains("grok") { return "grok-4.6" }
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

        let statusStr = ((dict["status"] as? String) ?? "idle").lowercased()
        let status: SessionRunState = {
            if statusStr == "running" { return .running }
            if statusStr.contains("waiting") { return .waitingApproval }
            return .idle
        }()

        let diffStats = dict["diff_stats"] as? [String: Any]
        let filesChanged = (diffStats?["files_changed"] as? Int) ?? (dict["files_changed"] as? Int) ?? 0
        let insertions = (diffStats?["insertions"] as? Int) ?? (dict["insertions"] as? Int) ?? 0
        let deletions = (diffStats?["deletions"] as? Int) ?? (dict["deletions"] as? Int) ?? 0

        let repoRoot = (dict["repo_root"] as? String)
            ?? (dict["project_path"] as? String)
            ?? "/Users/daiyudai/code/velo"
        let worktreePath = (dict["worktree_path"] as? String) ?? repoRoot

        let updatedLabel: String = {
            if let rawUpdated = dict["updated_at"] as? String,
               let date = ISO8601DateFormatter().date(from: rawUpdated)
            {
                let f = DateFormatter()
                f.dateFormat = "HH:mm"
                return f.string(from: date)
            }
            return "now"
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
            approvalMode: approvalMode,
            filesChanged: filesChanged,
            insertions: insertions,
            deletions: deletions,
            updatedAtLabel: updatedLabel
        )
    }
}

public struct VeloModelOption: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let shortLabel: String
    public let family: String
    public let agentKind: String

    public static let defaults: [VeloModelOption] = [
        VeloModelOption(
            id: "claude-fable-5-2",
            label: "Claude Fable 5.2",
            shortLabel: "Claude Fable 5.2",
            family: "Anthropic",
            agentKind: "claude"
        ),
        VeloModelOption(
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            shortLabel: "Opus 5.5",
            family: "Anthropic",
            agentKind: "claude"
        ),
        VeloModelOption(
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            shortLabel: "Sonnet 5",
            family: "Anthropic",
            agentKind: "claude"
        ),
        VeloModelOption(
            id: "gpt-6.1-sol",
            label: "GPT-6.1-Sol (Codex)",
            shortLabel: "GPT-6.1-Sol",
            family: "OpenAI",
            agentKind: "codex"
        ),
        VeloModelOption(
            id: "gemini-4-carbon-high",
            label: "Gemini 4 Carbon (Antigravity agy)",
            shortLabel: "Gemini 4 Carbon High",
            family: "Google Antigravity",
            agentKind: "agy"
        ),
        VeloModelOption(
            id: "gemini-3.8-flash-high",
            label: "Gemini 3.8 Flash (Antigravity agy)",
            shortLabel: "Gemini 3.8 Flash",
            family: "Google Antigravity",
            agentKind: "agy"
        ),
        VeloModelOption(
            id: "grok-4.7",
            label: "Grok 4.7 (xAI Grok CLI)",
            shortLabel: "Grok 4.7",
            family: "xAI Grok",
            agentKind: "grok"
        ),
        VeloModelOption(
            id: "grok-4.6",
            label: "Grok 4.6 (xAI Grok CLI)",
            shortLabel: "Grok 4.6",
            family: "xAI Grok",
            agentKind: "grok"
        ),
        VeloModelOption(
            id: "cursor:auto",
            label: "Cursor Auto (cursor-agent)",
            shortLabel: "Cursor Auto",
            family: "Cursor",
            agentKind: "cursor"
        ),
        VeloModelOption(
            id: "cursor:composer",
            label: "Cursor Composer (cursor-agent)",
            shortLabel: "Cursor Composer",
            family: "Cursor",
            agentKind: "cursor"
        ),
    ]

    public static func shortLabel(for modelId: String) -> String {
        if let found = defaults.first(where: { $0.id == modelId }) {
            return found.shortLabel
        }
        return modelId
    }
}

public enum AgentLivePhase: Equatable, Sendable {
    case thinking
    case tool(verb: String)
    case working
    case writing
    case waiting(label: String)
}

public enum TimelineEventKind: Equatable, Sendable {
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
}

public struct TimelineEventItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var sessionId: String
    public var timestamp: String
    public var content: String
    public var kind: TimelineEventKind
    public var durationMs: Int?
    public var completedAt: String?
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
        return (
            toolName,
            "Running \(toolName)",
            shortPath.isEmpty ? (command.isEmpty ? query : command) : shortPath,
            "wrench.and.screwdriver"
        )
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
}
