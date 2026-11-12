import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
public final class VeloStore: ObservableObject {
    @Published public var connectionConfig: ConnectionModeConfig?
    @Published public var isConnected: Bool = false
    @Published public var connectionError: String?

    @Published public var sessions: [VeloSessionItem] = []
    @Published public var activeSessionId: String?
    @Published public var eventsBySession: [String: [TimelineEventItem]] = [:]
    @Published public var pendingApprovals: [String: PendingApprovalPrompt] = [:]
    @Published public var pendingQuestions: [String: PendingQuestionPrompt] = [:]
    @Published public var diffsBySession: [String: [DiffFileSection]] = [:]
    @Published public var turnStartedAtBySession: [String: Date] = [:]
    @Published public var models: [VeloModelOption] = VeloModelOption.defaults

    private var wsTask: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var stepStartedAtBySession: [String: Date] = [:]
    private var e2eeNonceCounter: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)

    private static let savedConfigKey = "velo.ios.connectionConfig.v1"

    public init() {
        if let data = UserDefaults.standard.data(forKey: Self.savedConfigKey),
           let decoded = try? JSONDecoder().decode(ConnectionModeConfig.self, from: data)
        {
            self.connectionConfig = decoded
        } else {
            #if targetEnvironment(simulator)
            let simDefault = ConnectionModeConfig.direct(baseURL: "http://127.0.0.1:6767")
            self.connectionConfig = simDefault
            #else
            // Pre-configured with your Mac's LAN daemon address (can also scan QR anytime)
            let lanDefault = ConnectionModeConfig.direct(baseURL: "http://192.168.10.3:6767")
            self.connectionConfig = lanDefault
            #endif
        }

        requestNotificationPermissionIfNeeded()
        if connectionConfig != nil {
            connect()
        }
    }

    public var activeSession: VeloSessionItem? {
        guard let activeSessionId else { return sessions.first }
        return sessions.first(where: { $0.id == activeSessionId }) ?? sessions.first
    }

    // MARK: - Pairing & Connection Lifecycle

    @discardableResult
    public func applyPairingString(_ raw: String) -> Bool {
        guard let parsed = ConnectionModeConfig.parse(raw) else {
            connectionError = "无法识别配对地址，请扫描 Velo 桌面端二维码或输入 IP:6767"
            return false
        }
        saveAndConnect(parsed)
        triggerHaptic(.medium)
        return true
    }

    public func saveAndConnect(_ config: ConnectionModeConfig) {
        self.connectionConfig = config
        self.connectionError = nil
        if let encoded = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(encoded, forKey: Self.savedConfigKey)
        }
        connect()
    }

    public func disconnectAndClear() {
        reconnectTask?.cancel()
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        isConnected = false
        connectionConfig = nil
        UserDefaults.standard.removeObject(forKey: Self.savedConfigKey)
    }

    public func ensureConnectedOnForeground() {
        guard connectionConfig != nil else { return }
        if !isConnected || wsTask == nil || wsTask?.state != .running {
            connect()
        } else {
            Task { await refreshSessionsAndActiveEvents() }
        }
    }

    public func connect() {
        reconnectTask?.cancel()
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil

        guard let config = connectionConfig else { return }

        let wsURLString: String
        switch config {
        case .direct(let baseURL):
            let wsBase = baseURL
                .replacingOccurrences(of: "https://", with: "wss://")
                .replacingOccurrences(of: "http://", with: "ws://")
            wsURLString = "\(wsBase)/ws"
        case .e2eeRelay(let relayWsURL, let roomId, _):
            wsURLString = "\(relayWsURL)/room/\(roomId)"
        }

        guard let url = URL(string: wsURLString) else {
            connectionError = "无效的 WebSocket 地址: \(wsURLString)"
            return
        }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.wsTask = task
        task.resume()

        listenLoop(for: task, config: config)

        Task {
            switch config {
            case .direct:
                await fetchModelsIfDirect()
                await refreshSessionsAndActiveEvents()
            case .e2eeRelay:
                try? await Task.sleep(nanoseconds: 180_000_000)
                sendEncryptedCommand(["cmd": "sync"])
            }
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func listenLoop(for task: URLSessionWebSocketTask, config: ConnectionModeConfig) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.wsTask === task else { return }
                switch result {
                case .success(let message):
                    self.isConnected = true
                    self.connectionError = nil
                    let rawText: String? = {
                        switch message {
                        case .string(let s): return s
                        case .data(let d): return String(data: d, encoding: .utf8)
                        @unknown default: return nil
                        }
                    }()
                    if let rawText {
                        self.handleIncomingSocketText(rawText, config: config)
                    }
                    self.listenLoop(for: task, config: config)

                case .failure(let err):
                    self.isConnected = false
                    self.connectionError = err.localizedDescription
                    self.scheduleReconnect()
                }
            }
        }
    }

    // MARK: - REST & E2EE Dispatchers

    public func refreshSessionsAndActiveEvents() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions") else { return }
            do {
                let (data, resp) = try await URLSession.shared.data(from: url)
                if let http = resp as? HTTPURLResponse, http.statusCode == 200,
                   let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
                {
                    self.isConnected = true
                    self.connectionError = nil
                    let parsed = arr.compactMap(VeloSessionItem.fromJSON)
                    self.sessions = parsed
                    if self.activeSessionId == nil, let first = parsed.first {
                        self.activeSessionId = first.id
                    }
                    if let sid = self.activeSessionId {
                        await loadEventsForSession(sid)
                    }
                }
            } catch {
                self.connectionError = error.localizedDescription
            }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "sync"])
        case .none:
            break
        }
    }

    public func fetchModelsIfDirect() async {
        guard case .direct(let baseURL) = connectionConfig,
              let url = URL(string: "\(baseURL)/api/models")
        else { return }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        else { return }

        let parsed: [VeloModelOption] = arr.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            let label = (item["label"] as? String) ?? id
            let short = (item["shortLabel"] as? String) ?? label
            let family = (item["family"] as? String) ?? "Model"
            let kind = (item["agentKind"] as? String) ?? "claude"
            return VeloModelOption(id: id, label: label, shortLabel: short, family: family, agentKind: kind)
        }
        if !parsed.isEmpty {
            self.models = parsed
        }
    }

    public func selectSession(_ sessionId: String) {
        activeSessionId = sessionId
        Task {
            await loadEventsForSession(sessionId)
        }
    }

    public func loadEventsForSession(_ sessionId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/events") else { return }
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let rawList = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
            else { return }
            let items = Self.reconstructEventsFromHistory(sessionId: sessionId, rawList: rawList)
            if !items.isEmpty || self.eventsBySession[sessionId] == nil {
                self.eventsBySession[sessionId] = items
            }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_events", "session_id": sessionId])
        case .none:
            break
        }
    }

    public func fetchDiff(for sessionId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/diff") else { return }
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let rawDiff = obj["diff"] as? String
            else { return }
            self.diffsBySession[sessionId] = VeloFormatting.parseUnifiedDiff(rawDiff)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_diff", "session_id": sessionId])
        case .none:
            break
        }
    }

    public func sendPrompt(
        sessionId: String,
        text: String,
        model: String,
        effort: String,
        approvalMode: String = "auto_edit"
    ) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }

        let now = Date()
        let timeStr = Self.shortTimeString(from: now)
        turnStartedAtBySession[sessionId] = now
        stepStartedAtBySession[sessionId] = now

        // Optimistically append user bubble & mark session running
        let userItem = TimelineEventItem(
            id: "u-local-\(UUID().uuidString.prefix(8))",
            sessionId: sessionId,
            timestamp: timeStr,
            content: clean,
            kind: .user(images: [])
        )
        var list = eventsBySession[sessionId] ?? []
        list.append(userItem)
        eventsBySession[sessionId] = list

        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].status = .running
            sessions[idx].model = model
            sessions[idx].modelShort = models.first(where: { $0.id == model })?.shortLabel ?? VeloModelOption.shortLabel(for: model)
            sessions[idx].effort = effort
        }
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/input") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "input": clean,
                "model": model,
                "effort": effort,
                "approval_mode": approvalMode,
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            _ = try? await URLSession.shared.data(for: req)

        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "send_input",
                "session_id": sessionId,
                "input": clean,
                "model": model,
                "effort": effort,
                "approval_mode": approvalMode,
            ])
        case .none:
            break
        }
    }

    public func createNewSession(
        title: String?,
        prompt: String,
        repoPath: String,
        branch: String?,
        modelOption: VeloModelOption,
        effort: String
    ) async -> String? {
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPrompt.isEmpty else { return nil }
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "provider": modelOption.agentKind == "codex" ? "codex" : "claude",
                "prompt": cleanPrompt,
                "repo_path": repoPath,
                "model": modelOption.id,
                "effort": effort,
                "approval_mode": "auto_edit",
            ]
            if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty {
                body["name"] = title.trimmingCharacters(in: .whitespaces)
            }
            if let branch, !branch.trimmingCharacters(in: .whitespaces).isEmpty {
                body["branch"] = branch.trimmingCharacters(in: .whitespaces)
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let created = VeloSessionItem.fromJSON(dict)
            {
                let now = Date()
                turnStartedAtBySession[created.id] = now
                stepStartedAtBySession[created.id] = now
                sessions.insert(created, at: 0)
                activeSessionId = created.id
                eventsBySession[created.id] = [
                    TimelineEventItem(
                        id: "u-init-\(UUID().uuidString.prefix(6))",
                        sessionId: created.id,
                        timestamp: Self.shortTimeString(from: now),
                        content: cleanPrompt,
                        kind: .user(images: [])
                    )
                ]
                return created.id
            }
            return nil

        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "create_session",
                "provider": modelOption.agentKind == "codex" ? "codex" : "claude",
                "prompt": cleanPrompt,
                "repo_path": repoPath,
                "model": modelOption.id,
                "effort": effort,
                "approval_mode": "auto_edit",
            ]
            if let title, !title.isEmpty { payload["name"] = title }
            if let branch, !branch.isEmpty { payload["branch"] = branch }
            sendEncryptedCommand(payload)
            return nil

        case .none:
            return nil
        }
    }

    public func stopSession(_ sessionId: String) async {
        triggerHaptic(.rigid)
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/stop") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "stop_session", "session_id": sessionId])
        case .none:
            break
        }
    }

    public func resolveApproval(sessionId: String, requestId: String, approve: Bool) async {
        let decision = approve ? "approve" : "deny"
        pendingApprovals.removeValue(forKey: sessionId)
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/approvals/\(requestId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["decision": decision])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "resolve_approval",
                "session_id": sessionId,
                "request_id": requestId,
                "decision": decision,
            ])
        case .none:
            break
        }
    }

    public func answerQuestion(sessionId: String, questionId: String, answers: [String]) async {
        pendingQuestions.removeValue(forKey: sessionId)
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/questions/\(questionId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["answers": answers])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "answer_question",
                "session_id": sessionId,
                "question_id": questionId,
                "answers": answers,
            ])
        case .none:
            break
        }
    }

    private func sendEncryptedCommand(_ payload: [String: Any]) {
        guard case .e2eeRelay(_, _, let sharedKeyHex) = connectionConfig,
              let wsTask
        else { return }
        e2eeNonceCounter += 1
        guard let frameText = E2EERelayCrypto.sealJSON(
            sharedKeyHex: sharedKeyHex,
            nonce: e2eeNonceCounter,
            payload: payload
        ) else { return }
        wsTask.send(.string(frameText)) { _ in }
    }

    // MARK: - Incoming WebSocket Payload Processing

    private func handleIncomingSocketText(_ rawText: String, config: ConnectionModeConfig) {
        switch config {
        case .direct:
            guard let data = rawText.data(using: .utf8),
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            processServerPayload(json)

        case .e2eeRelay(_, _, let sharedKeyHex):
            guard let opened = E2EERelayCrypto.openFrame(sharedKeyHex: sharedKeyHex, rawFrameText: rawText),
                  opened.senderId == "daemon"
            else { return }
            processServerPayload(opened.json)
        }
    }

    private func processServerPayload(_ raw: [String: Any]) {
        if let kind = raw["kind"] as? String, kind == "sessions_snapshot",
           let rawArr = raw["sessions"] as? [[String: Any]]
        {
            let parsed = rawArr.compactMap(VeloSessionItem.fromJSON)
            self.sessions = parsed
            if self.activeSessionId == nil, let first = parsed.first {
                self.activeSessionId = first.id
                Task { await loadEventsForSession(first.id) }
            }
            return
        }

        if let type = raw["type"] as? String, type == "events_snapshot",
           let sid = raw["session_id"] as? String,
           let rawEvs = raw["events"] as? [[String: Any]]
        {
            let items = Self.reconstructEventsFromHistory(sessionId: sid, rawList: rawEvs)
            if !items.isEmpty {
                eventsBySession[sid] = items
            }
            return
        }

        if let type = raw["type"] as? String, type == "diff_snapshot",
           let sid = raw["session_id"] as? String,
           let diffStr = raw["diff"] as? String
        {
            diffsBySession[sid] = VeloFormatting.parseUnifiedDiff(diffStr)
            return
        }

        let evObj: [String: Any] = {
            if let kind = raw["kind"] as? String, kind == "event",
               let inner = raw["event"] as? [String: Any]
            {
                return inner
            }
            return raw
        }()

        guard let evType = evObj["type"] as? String,
              let sid = evObj["session_id"] as? String, !sid.isEmpty
        else { return }

        let now = Date()
        let nowLabel = Self.shortTimeString(from: now)

        switch evType {
        case "user_message":
            let text = (evObj["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { return }
            var list = eventsBySession[sid] ?? []
            let duplicate = list.suffix(3).contains { item in
                if case .user = item.kind, item.content == text { return true }
                return false
            }
            if !duplicate {
                list.append(
                    TimelineEventItem(
                        id: "u-ws-\(UUID().uuidString.prefix(8))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: text,
                        kind: .user(images: [])
                    )
                )
                eventsBySession[sid] = list
            }

        case "permission_requested":
            let reqId = (evObj["request_id"] as? String) ?? UUID().uuidString
            let toolName = (evObj["tool_name"] as? String) ?? "Bash"
            let preview = (evObj["command_preview"] as? String) ?? (evObj["description"] as? String) ?? toolName
            let reason = (evObj["description"] as? String) ?? ""
            pendingApprovals[sid] = PendingApprovalPrompt(
                id: reqId,
                toolName: toolName,
                commandPreview: preview,
                reason: reason
            )
            updateSessionStatus(sid, .waitingApproval)
            notifyUser(title: "需要权限确认 · \(toolName)", body: preview)

        case "permission_resolved":
            pendingApprovals.removeValue(forKey: sid)

        case "user_question_requested":
            let qId = (evObj["question_id"] as? String) ?? UUID().uuidString
            let question = (evObj["question"] as? String) ?? "请选择一个选项："
            let options = (evObj["options"] as? [String]) ?? []
            let allowMultiple = (evObj["allow_multiple"] as? Bool) ?? false
            pendingQuestions[sid] = PendingQuestionPrompt(
                id: qId,
                question: question,
                options: options,
                allowMultiple: allowMultiple
            )
            notifyUser(title: "Agent 等待你的回答", body: question)

        case "user_question_answered":
            pendingQuestions.removeValue(forKey: sid)

        case "status_changed":
            let st = ((evObj["status"] as? String) ?? "").lowercased()
            if st == "running" {
                if turnStartedAtBySession[sid] == nil {
                    turnStartedAtBySession[sid] = now
                }
                if stepStartedAtBySession[sid] == nil {
                    stepStartedAtBySession[sid] = turnStartedAtBySession[sid]
                }
                updateSessionStatus(sid, .running)
            } else if st == "completed" || st == "failed" || st == "stopped" {
                let startOrigin = turnStartedAtBySession[sid] ?? now.addingTimeInterval(-1)
                let stepOrigin = stepStartedAtBySession[sid] ?? startOrigin
                let totalMs = max(500, Int(now.timeIntervalSince(startOrigin) * 1000))
                turnStartedAtBySession.removeValue(forKey: sid)
                stepStartedAtBySession.removeValue(forKey: sid)

                if var list = eventsBySession[sid] {
                    if let lastUserIdx = list.lastIndex(where: {
                        if case .user = $0.kind { return true }
                        return false
                    }) {
                        list[lastUserIdx].durationMs = totalMs
                        list[lastUserIdx].completedAt = nowLabel
                    }
                    for i in list.indices {
                        switch list[i].kind {
                        case .thinking(let startedAt, let dur, true):
                            let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? stepOrigin) * 1000))
                            list[i].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
                        case .assistant(true):
                            list[i].kind = .assistant(isStreaming: false)
                        default:
                            break
                        }
                    }
                    eventsBySession[sid] = list
                }

                updateSessionStatus(sid, .idle)
                if st == "completed" {
                    triggerNotificationHaptic(.success)
                    let sessionTitle = sessions.first(where: { $0.id == sid })?.title ?? "Velo"
                    notifyUser(
                        title: "任务已完成 · \(sessionTitle)",
                        body: "Worked for \(VeloFormatting.formatDuration(ms: totalMs))"
                    )
                }
            } else if st.contains("waiting") {
                updateSessionStatus(sid, .waitingApproval)
            }

        case "thinking_chunk":
            let delta = (evObj["delta"] as? String) ?? ""
            let replace = (evObj["replace"] as? Bool) ?? false
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now
            var list = eventsBySession[sid] ?? []
            if let last = list.last, case .thinking(let startedAt, let dur, _) = last.kind {
                var updated = last
                updated.content = replace ? (delta.isEmpty ? last.content : delta) : (last.content + delta)
                updated.kind = .thinking(startedAt: startedAt ?? origin, durationMs: dur, isStreaming: true)
                list[list.count - 1] = updated
            } else {
                list.append(
                    TimelineEventItem(
                        id: "th-\(UUID().uuidString.prefix(8))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: delta,
                        kind: .thinking(startedAt: origin, durationMs: nil, isStreaming: true)
                    )
                )
            }
            eventsBySession[sid] = list

        case "thinking_delta":
            let text = ((evObj["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now
            stepStartedAtBySession[sid] = now
            var list = eventsBySession[sid] ?? []
            if let last = list.last, case .thinking(let startedAt, let prevDur, let wasStreaming) = last.kind {
                var updated = last
                if wasStreaming {
                    updated.content = text
                } else if !last.content.contains(text) {
                    updated.content = "\(last.content)\n\(text)"
                }
                let startRef = startedAt ?? origin
                let durMs = wasStreaming
                    ? max(500, Int(now.timeIntervalSince(startRef) * 1000))
                    : max(500, (prevDur ?? 0) + max(0, Int(now.timeIntervalSince(origin) * 1000)))
                updated.kind = .thinking(startedAt: startRef, durationMs: durMs, isStreaming: false)
                list[list.count - 1] = updated
            } else {
                let durMs = max(500, Int(now.timeIntervalSince(origin) * 1000))
                list.append(
                    TimelineEventItem(
                        id: "th-\(UUID().uuidString.prefix(8))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: text,
                        kind: .thinking(startedAt: origin, durationMs: durMs, isStreaming: false)
                    )
                )
            }
            eventsBySession[sid] = list

        case "tool_call_requested":
            let toolId = (evObj["tool_id"] as? String) ?? "tl-\(UUID().uuidString.prefix(8))"
            let toolName = (evObj["tool_name"] as? String) ?? "Tool"
            let argsObj = evObj["arguments"] as? [String: Any]
            let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: argsObj, output: nil)
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now

            var list = eventsBySession[sid] ?? []
            if let lastIdx = list.indices.last,
               case .thinking(let startedAt, let dur, true) = list[lastIdx].kind
            {
                let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? origin) * 1000))
                list[lastIdx].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
            }

            if let idx = list.firstIndex(where: { $0.id == toolId }) {
                if case .toolCall(_, _, _, _, let existingOut, let isErr) = list[idx].kind {
                    list[idx].kind = .toolCall(
                        toolName: toolName,
                        displayName: pres.displayName,
                        workingVerb: pres.workingVerb,
                        summary: pres.summary,
                        output: existingOut,
                        isError: isErr
                    )
                }
            } else {
                list.append(
                    TimelineEventItem(
                        id: toolId,
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: pres.summary,
                        kind: .toolCall(
                            toolName: toolName,
                            displayName: pres.displayName,
                            workingVerb: pres.workingVerb,
                            summary: pres.summary,
                            output: nil,
                            isError: false
                        )
                    )
                )
            }
            eventsBySession[sid] = list

        case "tool_call_completed":
            stepStartedAtBySession[sid] = now
            let toolId = (evObj["tool_id"] as? String) ?? ""
            let output = (evObj["output"] as? String) ?? "(completed)"
            let isError = (evObj["is_error"] as? Bool) ?? false

            var list = eventsBySession[sid] ?? []
            let targetIdx = list.firstIndex(where: { $0.id == toolId }) ?? list.lastIndex(where: {
                if case .toolCall(_, _, _, _, let out, _) = $0.kind { return out == nil }
                return false
            })
            if let idx = targetIdx,
               case .toolCall(let toolName, _, _, let oldSummary, _, _) = list[idx].kind
            {
                let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: nil, output: output)
                list[idx].content = output
                list[idx].kind = .toolCall(
                    toolName: toolName,
                    displayName: pres.displayName,
                    workingVerb: pres.workingVerb,
                    summary: oldSummary.isEmpty ? pres.summary : oldSummary,
                    output: output,
                    isError: isError
                )
                eventsBySession[sid] = list
            }

        case "diff_updated":
            if let stats = evObj["stats"] as? [String: Any],
               let idx = sessions.firstIndex(where: { $0.id == sid })
            {
                sessions[idx].filesChanged = (stats["files_changed"] as? Int) ?? sessions[idx].filesChanged
                sessions[idx].insertions = (stats["insertions"] as? Int) ?? sessions[idx].insertions
                sessions[idx].deletions = (stats["deletions"] as? Int) ?? sessions[idx].deletions
            }

        case "message_chunk":
            let delta = (evObj["delta"] as? String) ?? ""
            let replace = (evObj["replace"] as? Bool) ?? false
            guard !delta.isEmpty else { return }
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now

            var list = eventsBySession[sid] ?? []
            if let last = list.last, case .assistant(true) = last.kind {
                var updated = last
                updated.content = replace ? delta : (last.content + delta)
                list[list.count - 1] = updated
            } else {
                if let lastIdx = list.indices.last,
                   case .thinking(let startedAt, let dur, true) = list[lastIdx].kind
                {
                    let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? origin) * 1000))
                    list[lastIdx].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
                }
                list.append(
                    TimelineEventItem(
                        id: "as-stream-\(UUID().uuidString.prefix(8))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: delta,
                        kind: .assistant(isStreaming: true)
                    )
                )
            }
            eventsBySession[sid] = list

        case "message_delta":
            let text = (evObj["text"] as? String) ?? ""
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !text.hasPrefix("[stderr]")
            else { return }
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now
            stepStartedAtBySession[sid] = now

            var list = eventsBySession[sid] ?? []
            var targetIdx: Int?
            for idx in list.indices.reversed() {
                switch list[idx].kind {
                case .user, .toolCall:
                    idx == -1 ? () : ()
                    break
                case .assistant:
                    targetIdx = idx
                default:
                    continue
                }
                if targetIdx != nil { break }
                if case .user = list[idx].kind { break }
                if case .toolCall = list[idx].kind { break }
            }

            if let targetIdx {
                let existing = list[targetIdx]
                if case .assistant(let wasStreaming) = existing.kind {
                    let nextContent: String = {
                        if wasStreaming { return text }
                        if existing.content.trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines) {
                            return existing.content
                        }
                        if text.hasPrefix(existing.content) { return text }
                        return "\(existing.content)\n\n\(text)"
                    }()
                    list[targetIdx].content = nextContent
                    list[targetIdx].kind = .assistant(isStreaming: false)
                    eventsBySession[sid] = list
                    return
                }
            }

            if let lastIdx = list.indices.last,
               case .thinking(let startedAt, let dur, true) = list[lastIdx].kind
            {
                let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? origin) * 1000))
                list[lastIdx].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
            }
            list.append(
                TimelineEventItem(
                    id: "as-\(UUID().uuidString.prefix(8))",
                    sessionId: sid,
                    timestamp: nowLabel,
                    content: text,
                    kind: .assistant(isStreaming: false)
                )
            )
            eventsBySession[sid] = list

        default:
            break
        }
    }

    private func updateSessionStatus(_ sid: String, _ status: SessionRunState) {
        if let idx = sessions.firstIndex(where: { $0.id == sid }) {
            sessions[idx].status = status
            sessions[idx].updatedAtLabel = "now"
        }
    }

    // MARK: - History Reconstruction (Matches Desktop `reconstructEventsFromHistory`)

    public static func reconstructEventsFromHistory(
        sessionId: String,
        rawList: [[String: Any]]
    ) -> [TimelineEventItem] {
        var out: [TimelineEventItem] = []
        var activeUserIdx: Int?
        var activeStartMs: Int64 = 0
        var lastStepMs: Int64 = 0

        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()

        func parseTs(_ raw: Any?) -> (ms: Int64, label: String) {
            if let str = raw as? String,
               let date = isoFrac.date(from: str) ?? isoPlain.date(from: str)
            {
                return (Int64(date.timeIntervalSince1970 * 1000), shortTimeString(from: date))
            }
            return (0, shortTimeString(from: Date()))
        }

        for (i, ev) in rawList.enumerated() {
            let evType = (ev["type"] as? String) ?? ""
            let (tsMs, tsLabel) = parseTs(ev["timestamp"])

            switch evType {
            case "user_message":
                let text = ((ev["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let imgs = (ev["images"] as? [String]) ?? []
                if !text.isEmpty || !imgs.isEmpty {
                    out.append(
                        TimelineEventItem(
                            id: "u-hist-\(i)",
                            sessionId: sessionId,
                            timestamp: tsLabel,
                            content: text,
                            kind: .user(images: imgs)
                        )
                    )
                    activeUserIdx = out.count - 1
                    activeStartMs = tsMs
                    lastStepMs = tsMs
                }

            case "status_changed":
                let st = ((ev["status"] as? String) ?? "").lowercased()
                if st == "running" {
                    if activeStartMs == 0, tsMs > 0 { activeStartMs = tsMs }
                    if lastStepMs == 0, tsMs > 0 { lastStepMs = tsMs }
                } else if st == "completed" || st == "failed" || st == "stopped",
                          let uIdx = activeUserIdx
                {
                    if activeStartMs > 0, tsMs >= activeStartMs {
                        out[uIdx].durationMs = max(500, Int(tsMs - activeStartMs))
                    }
                    out[uIdx].completedAt = tsLabel
                }

            case "thinking_delta":
                let text = ((ev["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let stepDur: Int? = (lastStepMs > 0 && tsMs >= lastStepMs)
                    ? max(500, Int(tsMs - lastStepMs))
                    : nil
                if tsMs > 0 { lastStepMs = tsMs }

                if let last = out.last, case .thinking(let stAt, let prevDur, _) = last.kind {
                    var updated = last
                    if !updated.content.contains(text) {
                        updated.content += "\n\(text)"
                    }
                    let combinedDur = stepDur.map { max(500, (prevDur ?? 0) + $0) } ?? prevDur
                    updated.kind = .thinking(startedAt: stAt, durationMs: combinedDur, isStreaming: false)
                    out[out.count - 1] = updated
                } else {
                    out.append(
                        TimelineEventItem(
                            id: "th-hist-\(i)",
                            sessionId: sessionId,
                            timestamp: tsLabel,
                            content: text,
                            kind: .thinking(startedAt: nil, durationMs: stepDur, isStreaming: false)
                        )
                    )
                }

            case "tool_call_requested":
                if lastStepMs == 0, tsMs > 0 { lastStepMs = tsMs }
                let toolId = (ev["tool_id"] as? String) ?? "tl-hist-\(i)"
                let toolName = (ev["tool_name"] as? String) ?? "Tool"
                let argsObj = ev["arguments"] as? [String: Any]
                let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: argsObj, output: nil)

                if let existingIdx = out.firstIndex(where: { $0.id == toolId }),
                   case .toolCall(_, _, _, _, let existingOut, let isErr) = out[existingIdx].kind
                {
                    out[existingIdx].kind = .toolCall(
                        toolName: toolName,
                        displayName: pres.displayName,
                        workingVerb: pres.workingVerb,
                        summary: pres.summary,
                        output: existingOut,
                        isError: isErr
                    )
                } else {
                    out.append(
                        TimelineEventItem(
                            id: toolId,
                            sessionId: sessionId,
                            timestamp: tsLabel,
                            content: pres.summary,
                            kind: .toolCall(
                                toolName: toolName,
                                displayName: pres.displayName,
                                workingVerb: pres.workingVerb,
                                summary: pres.summary,
                                output: nil,
                                isError: false
                            )
                        )
                    )
                }

            case "tool_call_completed":
                if tsMs > 0 { lastStepMs = tsMs }
                let toolId = (ev["tool_id"] as? String) ?? ""
                let output = (ev["output"] as? String) ?? "(completed)"
                let isError = (ev["is_error"] as? Bool) ?? false

                let idx = out.firstIndex(where: { $0.id == toolId }) ?? out.lastIndex(where: {
                    if case .toolCall(_, _, _, _, let o, _) = $0.kind { return o == nil }
                    return false
                })
                if let idx,
                   case .toolCall(let toolName, _, _, let prevSum, _, _) = out[idx].kind
                {
                    let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: nil, output: output)
                    out[idx].content = output
                    out[idx].kind = .toolCall(
                        toolName: toolName,
                        displayName: pres.displayName,
                        workingVerb: pres.workingVerb,
                        summary: prevSum.isEmpty ? pres.summary : prevSum,
                        output: output,
                        isError: isError
                    )
                }

            case "message_delta":
                let text = (ev["text"] as? String) ?? ""
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !text.hasPrefix("[stderr]")
                else { continue }
                if tsMs > 0 { lastStepMs = tsMs }
                out.append(
                    TimelineEventItem(
                        id: "as-hist-\(i)",
                        sessionId: sessionId,
                        timestamp: tsLabel,
                        content: text,
                        kind: .assistant(isStreaming: false)
                    )
                )

            case "error":
                let errText = (ev["error"] as? String) ?? "Agent error"
                out.append(
                    TimelineEventItem(
                        id: "err-hist-\(i)",
                        sessionId: sessionId,
                        timestamp: tsLabel,
                        content: "⚠️ \(errText)",
                        kind: .assistant(isStreaming: false)
                    )
                )

            default:
                break
            }
        }
        return out
    }

    public static func groupIntoTurns(_ events: [TimelineEventItem]) -> [ConversationTurnBlock] {
        var turns: [ConversationTurnBlock] = []
        for ev in events {
            if case .user = ev.kind {
                turns.append(ConversationTurnBlock(id: ev.id, userEvent: ev, items: []))
            } else if turns.isEmpty {
                turns.append(ConversationTurnBlock(id: "init-\(ev.id)", userEvent: nil, items: [ev]))
            } else {
                turns[turns.count - 1].items.append(ev)
            }
        }
        return turns
    }

    // MARK: - Haptics & Native Local Notifications

    private static func shortTimeString(from date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }

    public func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let gen = UIImpactFeedbackGenerator(style: style)
        gen.impactOccurred()
    }

    public func triggerNotificationHaptic(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        let gen = UINotificationFeedbackGenerator()
        gen.notificationOccurred(type)
    }

    private func requestNotificationPermissionIfNeeded() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func notifyUser(title: String, body: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = String(body.prefix(140))
        content.sound = .default
        let req = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }
}
