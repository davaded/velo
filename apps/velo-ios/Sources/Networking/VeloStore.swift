import CryptoKit
import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
public final class VeloStore: ObservableObject {
    @Published public var connectionConfig: ConnectionModeConfig?
    @Published public var isConnected: Bool = false
    @Published public var isForwardSecretRatcheted: Bool = false
    @Published public var connectionError: String?

    @Published public var sessions: [VeloSessionItem] = []
    @Published public var workspaces: [String] = []
    @Published public var activeSessionId: String?
    @Published public var eventsBySession: [String: [TimelineEventItem]] = [:]
    @Published public var pendingApprovals: [String: PendingApprovalPrompt] = [:]
    @Published public var pendingQuestions: [String: PendingQuestionPrompt] = [:]
    @Published public var diffsBySession: [String: [DiffFileSection]] = [:]
    @Published public var turnStartedAtBySession: [String: Date] = [:]
    @Published public var liveTpsBySession: [String: Double] = [:]
    @Published public var models: [VeloModelOption] = VeloModelOption.defaults
    @Published public var latestCreatedOrHandoffSessionId: String?
    @Published public var deepLinkTargetSessionId: String?
    @Published public var prBySession: [String: VeloPrSnapshot] = [:]
    @Published public var usageAnalytics: VeloUsageAnalytics?
    @Published public var globalSearchHits: [VeloSearchHit] = []
    @Published public var pushConfig: VeloPushConfig = VeloPushConfig()
    @Published public var automations: [VeloAutomationItem] = []
    @Published public var lastActionBanner: String?
    @Published public var oldestSeqBySession: [String: Int] = [:]
    private var eventsMetaBySession: [String: (newestSeq: Int, eventCount: Int, latestTsMs: Int?)] = [:]
    private struct PendingStreamChunk {
        var isThinking: Bool
        var delta: String
        var replace: Bool
        var nowLabel: String
        var origin: Date
    }
    private var pendingStreamChunks: [String: PendingStreamChunk] = [:]
    private var streamFlushTask: Task<Void, Never>?
    @Published public var hasMoreHistoryBySession: [String: Bool] = [:]
    @Published public var externalCliSessions: [VeloExternalCliSessionItem] = []
    @Published public var hiddenCliSessionsCount: Int = 0
    @Published public var latestImportedCliVeloId: String?
    @Published public var unreadSessionIds: Set<String> = []
    @Published public var quotaCards: [VeloProviderQuotaCard] = []
    @Published public var remoteHosts: [VeloRemoteHostItem] = []
    @Published public var savedHostProfiles: [VeloSavedHostProfile] = []
    @Published public var checkpointsBySession: [String: [VeloTurnCheckpointItem]] = [:]
    @Published public var mcpServers: [VeloMcpServerItem] = []
    @Published public var installedSkills: [VeloSkillItem] = []
    @Published public var offlineOutbox: [VeloOfflineQueuedPrompt] = []
    @Published public var autoCollapseSteps: Bool = true {
        didSet {
            UserDefaults.standard.set(autoCollapseSteps, forKey: Self.autoCollapseKey)
        }
    }

    private struct IncomingAttachmentBuffer {
        var chunks: [Data?]
    }

    private var wsTask: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var syncRetryTask: Task<Void, Never>?
    private var cacheSaveTask: Task<Void, Never>?
    private var resignActiveObserver: NSObjectProtocol?
    private var stepStartedAtBySession: [String: Date] = [:]
    private var streamStatsBySession: [String: (firstChunkAt: Date, tokens: Int)] = [:]
    private var attachmentDownloadWaiters: [String: [CheckedContinuation<Data?, Never>]] = [:]
    private var attachmentChunkBuffers: [String: IncomingAttachmentBuffer] = [:]
    private var attachmentUploadWaiters: [String: CheckedContinuation<(path: String, url: String)?, Never>] = [:]
    private var skillContentWaiters: [String: CheckedContinuation<String?, Never>] = [:]
    private var e2eeNonceCounter: UInt64 = UInt64(Date().timeIntervalSince1970 * 1_000_000)
    private var ephemeralPrivateKey: Curve25519.KeyAgreement.PrivateKey?
    private var e2eeActiveKeyHex: String?
    private var clientSenderId: String = "ios-\(UUID().uuidString.prefix(8))"
    private var maxDaemonNonce: UInt64?
    private var pendingSelectNewestSession: Bool = false
    private var pendingEncryptedPayloads: [[String: Any]] = []
    private var isFlushingOfflineOutbox: Bool = false

    private static let savedConfigKey = "velo.ios.connectionConfig.v1"
    private static let savedHostsKey = "velo.ios.savedHosts.v1"
    private static let unreadIdsKey = "velo.ios.unreadIds.v1"
    private static let autoCollapseKey = "velo.ios.autoCollapseSteps"
    private static let offlineOutboxKey = "velo.ios.offlineOutbox.v1"
    private static let draftPromptsKey = "velo.ios.draftPrompts.v1"

    private struct TurnCacheEntry {
        let count: Int
        let firstId: String
        let lastEvent: TimelineEventItem
        let prevContentLen: Int
        let turns: [ConversationTurnBlock]
    }

    public var draftPromptsBySession: [String: String] = [:]
    private var draftPersistTask: Task<Void, Never>?
    private var turnsCacheBySession: [String: TurnCacheEntry] = [:]

    public func draftPrompt(for sessionId: String) -> String {
        draftPromptsBySession[sessionId] ?? ""
    }

    public func setDraftPrompt(_ text: String, for sessionId: String) {
        guard !sessionId.isEmpty else { return }
        let current = draftPromptsBySession[sessionId] ?? ""
        if current == text { return }
        if text.isEmpty {
            draftPromptsBySession.removeValue(forKey: sessionId)
        } else {
            draftPromptsBySession[sessionId] = text
        }
        // Debounce UserDefaults encoding (600ms) so typing never stalls the main thread
        draftPersistTask?.cancel()
        draftPersistTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            self?.flushDraftPromptsNow()
        }
    }

    public func flushDraftPromptsNow() {
        draftPersistTask?.cancel()
        draftPersistTask = nil
        if let data = try? JSONEncoder().encode(draftPromptsBySession) {
            UserDefaults.standard.set(data, forKey: Self.draftPromptsKey)
        }
    }

    /// Cached turn grouping keyed by lightweight O(1) event signature so SwiftUI body
    /// re-evaluations triggered by unrelated `@Published` properties never re-scan all events.
    public func cachedTurns(for sessionId: String) -> [ConversationTurnBlock] {
        let events = eventsBySession[sessionId] ?? []
        if events.isEmpty {
            return []
        }
        let firstId = events[0].id
        let last = events[events.count - 1]
        let prevLen = events.count >= 2 ? events[events.count - 2].content.utf8.count : 0
        if let hit = turnsCacheBySession[sessionId],
           hit.count == events.count,
           hit.firstId == firstId,
           hit.prevContentLen == prevLen,
           hit.lastEvent == last
        {
            return hit.turns
        }
        let grouped = Self.groupIntoTurns(events)
        turnsCacheBySession[sessionId] = TurnCacheEntry(
            count: events.count,
            firstId: firstId,
            lastEvent: last,
            prevContentLen: prevLen,
            turns: grouped
        )
        if turnsCacheBySession.count > 24 {
            let keepIds = Set([sessionId, activeSessionId].compactMap { $0 })
            for key in turnsCacheBySession.keys where !keepIds.contains(key) {
                turnsCacheBySession.removeValue(forKey: key)
                if turnsCacheBySession.count <= 16 { break }
            }
        }
        return grouped
    }

    public init() {
        if let storedCollapse = UserDefaults.standard.object(forKey: Self.autoCollapseKey) as? Bool {
            self.autoCollapseSteps = storedCollapse
        }
        if let unreadArr = UserDefaults.standard.stringArray(forKey: Self.unreadIdsKey) {
            self.unreadSessionIds = Set(unreadArr)
        }
        if let hostsData = UserDefaults.standard.data(forKey: Self.savedHostsKey),
           let decodedHosts = try? JSONDecoder().decode([VeloSavedHostProfile].self, from: hostsData)
        {
            self.savedHostProfiles = decodedHosts
        }
        if let outboxData = UserDefaults.standard.data(forKey: Self.offlineOutboxKey),
           let decodedOutbox = try? JSONDecoder().decode([VeloOfflineQueuedPrompt].self, from: outboxData)
        {
            self.offlineOutbox = decodedOutbox
        }
        if let draftsData = UserDefaults.standard.data(forKey: Self.draftPromptsKey),
           let decodedDrafts = try? JSONDecoder().decode([String: String].self, from: draftsData)
        {
            self.draftPromptsBySession = decodedDrafts
        }

        // Frame-0 local disk cache hydration so sessions, folders, and message contents
        // appear instantaneously on launch and never flash empty while offline or reconnecting.
        if let cached = VeloLocalCacheSnapshot.load() {
            self.sessions = cached.sessions.map { item in
                var copy = item
                if copy.status != .idle {
                    copy.status = .idle
                }
                return copy
            }
            self.workspaces = cached.workspaces
            if !cached.models.isEmpty {
                self.models = cached.models
            }
            self.activeSessionId = cached.activeSessionId ?? cached.sessions.first?.id
            var restoredEvents: [String: [TimelineEventItem]] = [:]
            for (sid, list) in cached.eventsBySession {
                let normalized = list.map { ev in
                    var copy = ev
                    switch copy.kind {
                    case .thinking(let startedAt, let dur, true):
                        copy.kind = .thinking(startedAt: startedAt, durationMs: dur, isStreaming: false)
                    case .assistant(true):
                        copy.kind = .assistant(isStreaming: false)
                    default:
                        break
                    }
                    return copy
                }
                restoredEvents[sid] = normalized
            }
            self.eventsBySession = restoredEvents
        }

        if let data = UserDefaults.standard.data(forKey: Self.savedConfigKey),
           let decoded = try? JSONDecoder().decode(ConnectionModeConfig.self, from: data)
        {
            self.connectionConfig = decoded
            self.upsertSavedHostProfile(config: decoded, customName: nil)
        } else {
            #if targetEnvironment(simulator)
            self.connectionConfig = ConnectionModeConfig.direct(baseURL: "http://127.0.0.1:6767")
            #else
            self.connectionConfig = nil
            #endif
        }

        resignActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.flushCacheImmediately()
            }
        }

        requestNotificationPermissionIfNeeded()
        if connectionConfig != nil {
            connect()
        }
    }

    private func scheduleCacheSave() {
        cacheSaveTask?.cancel()
        cacheSaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            self.flushCacheImmediately()
        }
    }

    public func flushCacheImmediately() {
        cacheSaveTask?.cancel()
        cacheSaveTask = nil
        let snapshot = VeloLocalCacheSnapshot(
            sessions: sessions,
            workspaces: workspaces,
            models: models,
            activeSessionId: activeSessionId,
            eventsBySession: eventsBySession
        )
        snapshot.writeToDisk()
    }

    public var activeSession: VeloSessionItem? {
        guard let activeSessionId else {
            return sessions.first(where: { !$0.isArchived }) ?? sessions.first
        }
        return sessions.first(where: { $0.id == activeSessionId })
            ?? sessions.first(where: { !$0.isArchived })
            ?? sessions.first
    }

    /// Returns live streaming `tok/s` while running, or the latest turn's `tok/s` in the chat window
    /// (strictly matching the active/latest turn footer so header and turn footer never disagree).
    public func latestThroughput(for sessionId: String) -> Double? {
        let isRunning = sessions.first(where: { $0.id == sessionId }).map {
            $0.status == .running || $0.status == .waitingApproval
        } ?? false
        let lastUser = eventsBySession[sessionId]?.last(where: {
            if case .user = $0.kind { return true }
            return false
        })
        let rawTps = isRunning
            ? (liveTpsBySession[sessionId] ?? lastUser?.telemetry?.tps)
            : lastUser?.telemetry?.tps
        if let tps = rawTps, tps >= 0.5 {
            return tps
        }
        return nil
    }

    public static func estimateTextTokens(_ text: String) -> Int {
        var cjk = 0
        var other = 0
        for scalar in text.unicodeScalars {
            if scalar.value >= 0x2E80 && scalar.value <= 0x9FFF {
                cjk += 1
            } else {
                other += 1
            }
        }
        return max(1, Int((Double(cjk) * 0.72 + Double(other) * 0.27).rounded()))
    }

    // MARK: - Pairing, Deep Link & Connection Lifecycle

    public func handleIncomingURL(_ url: URL) {
        let raw = url.absoluteString
        if url.scheme?.lowercased() == "velo", url.host?.lowercased() == "session" {
            let sid = url.pathComponents.dropFirst().first ?? ""
            if !sid.isEmpty {
                activeSessionId = sid
                deepLinkTargetSessionId = sid
                Task { await loadEventsForSession(sid) }
                return
            }
        }
        applyPairingString(raw)
    }

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

    public func saveAndConnect(_ config: ConnectionModeConfig, customName: String? = nil) {
        self.connectionConfig = config
        self.connectionError = nil
        if let encoded = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(encoded, forKey: Self.savedConfigKey)
        }
        upsertSavedHostProfile(config: config, customName: customName)
        connect()
    }

    private func upsertSavedHostProfile(config: ConnectionModeConfig, customName: String?) {
        let name = (customName?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        } ?? config.displayTitle
        if let idx = savedHostProfiles.firstIndex(where: { $0.config == config }) {
            if let customName, !customName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                savedHostProfiles[idx].name = customName
            }
            savedHostProfiles[idx].updatedAt = Date()
        } else {
            savedHostProfiles.insert(
                VeloSavedHostProfile(name: name, config: config),
                at: 0
            )
        }
        if let data = try? JSONEncoder().encode(savedHostProfiles) {
            UserDefaults.standard.set(data, forKey: Self.savedHostsKey)
        }
    }

    public func switchToSavedHost(_ profile: VeloSavedHostProfile) {
        triggerHaptic(.medium)
        saveAndConnect(profile.config, customName: profile.name)
    }

    public func addDirectDaemonHost(name: String, rawURL: String) {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else { return }
        let normalized = (trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://"))
            ? trimmed
            : "http://\(trimmed)"
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        saveAndConnect(
            .direct(baseURL: normalized),
            customName: cleanName.isEmpty ? normalized : cleanName
        )
    }

    /// Phase 3: Reports iOS foreground/background presence to daemon for cross-device anti-disturb coordination.
    public func reportPresence(focused: Bool, sessionId: String? = nil) {
        let targetSid = sessionId ?? activeSessionId
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/presence") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "client_id": clientSenderId,
                "platform": "ios",
                "focused": focused,
            ]
            if let sid = targetSid, UUID(uuidString: sid) != nil {
                body["active_session_id"] = sid
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            Task {
                _ = try? await URLSession.shared.data(for: req)
            }
        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "presence_heartbeat",
                "client_id": clientSenderId,
                "platform": "ios",
                "focused": focused,
            ]
            if let sid = targetSid, UUID(uuidString: sid) != nil {
                payload["active_session_id"] = sid
            }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }

    public func removeSavedHost(_ profileId: String) {
        savedHostProfiles.removeAll { $0.id == profileId }
        if let data = try? JSONEncoder().encode(savedHostProfiles) {
            UserDefaults.standard.set(data, forKey: Self.savedHostsKey)
        }
    }

    public func markSessionRead(_ sessionId: String) {
        if unreadSessionIds.remove(sessionId) != nil {
            UserDefaults.standard.set(Array(unreadSessionIds), forKey: Self.unreadIdsKey)
        }
    }

    private func markSessionUnreadIfBackground(_ sessionId: String) {
        guard !sessionId.isEmpty, sessionId != activeSessionId else { return }
        if unreadSessionIds.insert(sessionId).inserted {
            UserDefaults.standard.set(Array(unreadSessionIds), forKey: Self.unreadIdsKey)
        }
    }

    public func disconnectAndClear() {
        reconnectTask?.cancel()
        pingTask?.cancel()
        syncRetryTask?.cancel()
        cacheSaveTask?.cancel()
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        isConnected = false
        isForwardSecretRatcheted = false
        e2eeActiveKeyHex = nil
        ephemeralPrivateKey = nil
        maxDaemonNonce = nil
        pendingEncryptedPayloads.removeAll()
        for (_, waiters) in attachmentDownloadWaiters {
            for w in waiters { w.resume(returning: nil) }
        }
        attachmentDownloadWaiters.removeAll()
        attachmentChunkBuffers.removeAll()
        for (_, waiter) in attachmentUploadWaiters {
            waiter.resume(returning: nil)
        }
        attachmentUploadWaiters.removeAll()
        sessions = []
        workspaces = []
        eventsBySession = [:]
        activeSessionId = nil
        VeloLocalCacheSnapshot.clear()
        connectionConfig = nil
        UserDefaults.standard.removeObject(forKey: Self.savedConfigKey)
    }

    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private var lastBackgroundedAt: Date?

    public func handleAppDidEnterBackground() {
        flushDraftPromptsNow()
        reportPresence(focused: false)
        lastBackgroundedAt = Date()
        let hasLiveWork = sessions.contains(where: { $0.status == .running || $0.status == .waitingApproval })
            || VeloLiveActivityManager.shared.hasActiveLiveActivity
        guard hasLiveWork else {
            endBackgroundTaskIfNeeded()
            return
        }
        guard backgroundTaskId == .invalid else { return }
        backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "VeloLiveActivitySync") { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // iOS is about to suspend our socket — immediately switch the Lock Screen Live Activity
                // out of "正在生成回复…" into a truthful "后台连接已休眠 · 轻点查看最新状态"!
                VeloLiveActivityManager.shared.markBackgroundSuspended()
                self.endBackgroundTaskIfNeeded()
            }
        }
    }

    private func endBackgroundTaskIfNeeded() {
        guard backgroundTaskId != .invalid else { return }
        let idToEnd = backgroundTaskId
        backgroundTaskId = .invalid
        UIApplication.shared.endBackgroundTask(idToEnd)
    }

    public func ensureConnectedOnForeground() {
        endBackgroundTaskIfNeeded()
        reportPresence(focused: true)
        let bgElapsed = lastBackgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
        lastBackgroundedAt = nil
        guard connectionConfig != nil else { return }
        // After sleeping >8s, iOS may leave a half-open dead TCP socket reporting `.running`;
        // force a clean reconnect so we immediately receive an authoritative `sessions_snapshot`
        // and reconcile any Live Activity that finished while locked!
        if bgElapsed >= 8 || !isConnected || wsTask == nil || wsTask?.state != .running {
            connect()
        } else if case .e2eeRelay = connectionConfig, !isForwardSecretRatcheted {
            sendEncryptedSync()
        } else {
            Task { await refreshSessionsAndActiveEvents() }
        }
    }

    public func connect() {
        reconnectTask?.cancel()
        pingTask?.cancel()
        syncRetryTask?.cancel()
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        isForwardSecretRatcheted = false
        e2eeActiveKeyHex = nil
        ephemeralPrivateKey = nil
        maxDaemonNonce = nil
        clientSenderId = "ios-\(UUID().uuidString.prefix(8))"

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
        // Raise from 1 MB default to 16 MB so large hex-encoded E2EE snapshots never fail or drop!
        task.maximumMessageSize = 16 * 1024 * 1024
        self.wsTask = task
        task.resume()

        listenLoop(for: task, config: config)

        pingTask = Task { [weak self, weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled, let self, let task, self.wsTask === task else { break }
                task.sendPing { _ in }
            }
        }

        switch config {
        case .direct:
            Task {
                await fetchModelsIfDirect()
                await fetchWorkspacesIfDirect()
                await refreshSessionsAndActiveEvents()
                await fetchQuotas()
            }
        case .e2eeRelay:
            syncRetryTask = Task { [weak self, weak task] in
                try? await Task.sleep(nanoseconds: 140_000_000)
                while !Task.isCancelled {
                    guard let self, let task, self.wsTask === task else { break }
                    if self.isForwardSecretRatcheted { break }
                    self.sendEncryptedSync()
                    try? await Task.sleep(nanoseconds: 1_800_000_000)
                }
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
                    self.isForwardSecretRatcheted = false
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
            await fetchWorkspacesIfDirect()
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
                    VeloLiveActivityManager.shared.reconcile(with: parsed)
                    if self.activeSessionId == nil, let first = parsed.first {
                        self.activeSessionId = first.id
                    }
                    self.scheduleCacheSave()
                    if let sid = self.activeSessionId {
                        await loadEventsForSession(sid, incremental: true)
                    }
                    await self.flushOfflineOutboxIfConnected()
                }
            } catch {
                self.connectionError = error.localizedDescription
            }
        case .e2eeRelay:
            sendEncryptedSync()
        case .none:
            break
        }
    }


    private func applyModelsArray(_ arr: [[String: Any]]) {
        let parsed: [VeloModelOption] = arr.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            let label = (item["label"] as? String) ?? id
            let short = (item["shortLabel"] as? String) ?? label
            let family = (item["family"] as? String) ?? "Model"
            let kind = (item["agentKind"] as? String) ?? "claude"
            let desc = (item["desc"] as? String) ?? ""
            let installed = (item["installed"] as? Bool) ?? true
            let isDefault = (item["isDefault"] as? Bool) ?? false
            let supportedEfforts = item["supportedEfforts"] as? [String]
            let defaultEffort = item["defaultEffort"] as? String
            return VeloModelOption(
                id: id,
                label: label,
                shortLabel: short,
                family: family,
                agentKind: kind,
                desc: desc,
                installed: installed,
                isDefault: isDefault,
                supportedEfforts: supportedEfforts,
                defaultEffort: defaultEffort
            )
        }
        if !parsed.isEmpty {
            self.models = parsed
            self.scheduleCacheSave()
        }
    }

    public func fetchModelsIfDirect() async {
        guard case .direct(let baseURL) = connectionConfig,
              let url = URL(string: "\(baseURL)/api/models")
        else { return }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let jsonObj = try? JSONSerialization.jsonObject(with: data)
        else { return }

        if let dict = jsonObj as? [String: Any],
           let arr = dict["models"] as? [[String: Any]]
        {
            applyModelsArray(arr)
        } else if let arr = jsonObj as? [[String: Any]] {
            applyModelsArray(arr)
        }
    }

    private func applyWorkspacesArray(_ rawPaths: [String]) {
        var seen: Set<String> = []
        var clean: [String] = []
        for p in rawPaths {
            let canon = VeloFormatting.canonicalWorkspacePath(p)
            if !canon.isEmpty, seen.insert(canon).inserted {
                clean.append(canon)
            }
        }
        self.workspaces = clean
        self.scheduleCacheSave()
    }

    public func fetchWorkspacesIfDirect() async {
        guard case .direct(let baseURL) = connectionConfig,
              let url = URL(string: "\(baseURL)/api/workspaces")
        else { return }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let jsonObj = try? JSONSerialization.jsonObject(with: data)
        else { return }
        if let dict = jsonObj as? [String: Any],
           let arr = dict["workspaces"] as? [String]
        {
            applyWorkspacesArray(arr)
        } else if let arr = jsonObj as? [String] {
            applyWorkspacesArray(arr)
        }
    }

    public func addWorkspace(_ rawPath: String) async {
        let canon = VeloFormatting.canonicalWorkspacePath(rawPath)
        guard !canon.isEmpty, !canon.hasSuffix("/.velo/workspace") else { return }
        if !workspaces.contains(canon) {
            workspaces.append(canon)
            scheduleCacheSave()
        }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/workspaces") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": canon])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "add_workspace", "path": canon])
        case .none:
            break
        }
    }


    public func selectSession(_ sessionId: String) {
        activeSessionId = sessionId
        markSessionRead(sessionId)
        scheduleCacheSave()
        Task {
            await loadEventsForSession(sessionId)
        }
    }

    public func loadEventsForSession(_ sessionId: String, incremental: Bool = false) async {
        markSessionRead(sessionId)
        reportPresence(focused: true, sessionId: sessionId)
        let meta = eventsMetaBySession[sessionId]
        let hasCachedEvents = !(eventsBySession[sessionId]?.isEmpty ?? true)
        let sessionObj = sessions.first(where: { $0.id == sessionId })
        if incremental && isConnected && hasCachedEvents &&
            (sessionObj?.status == .running || sessionObj?.status == .waitingApproval)
        {
            return
        }
        let useIncremental = incremental && meta != nil && hasCachedEvents

        switch connectionConfig {
        case .direct(let baseURL):
            var qs = "limit=160"
            if useIncremental, let m = meta {
                qs += "&after_seq=\(m.newestSeq)&known_count=\(m.eventCount)"
                if let ts = m.latestTsMs {
                    qs += "&known_ts_ms=\(ts)"
                }
            }
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/events?\(qs)") else { return }
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let parsedJson = try? JSONSerialization.jsonObject(with: data)
            else { return }

            let rawList: [[String: Any]]
            var isIncrementalAppend = false
            if let arr = parsedJson as? [[String: Any]] {
                rawList = arr
            } else if let pageObj = parsedJson as? [String: Any] {
                if (pageObj["unchanged"] as? Bool) == true {
                    return
                }
                guard let evs = pageObj["events"] as? [[String: Any]] else { return }
                rawList = evs
                isIncrementalAppend = (pageObj["incremental"] as? Bool) ?? false
                if let nSeq = VeloSessionItem.intValue(pageObj["newest_seq"]) {
                    let cnt = VeloSessionItem.intValue(pageObj["event_count"]) ?? (meta?.eventCount ?? rawList.count)
                    let ts = VeloSessionItem.intValue(pageObj["latest_ts_ms"]) ?? meta?.latestTsMs
                    eventsMetaBySession[sessionId] = (newestSeq: nSeq, eventCount: cnt, latestTsMs: ts)
                }
                if !isIncrementalAppend {
                    if let oSeq = VeloSessionItem.intValue(pageObj["oldest_seq"]) {
                        oldestSeqBySession[sessionId] = oSeq
                    }
                    hasMoreHistoryBySession[sessionId] = (pageObj["has_more"] as? Bool) ?? false
                }
            } else {
                return
            }

            let sessionItem = sessions.first(where: { $0.id == sessionId })
            let fallbackProv = sessionItem?.agentKind ?? "agy"
            let (items, activeStart) = Self.reconstructEventsWithActiveTurn(
                sessionId: sessionId,
                rawList: rawList,
                fallbackProvider: fallbackProv
            )
            if isIncrementalAppend {
                guard !items.isEmpty else { return }
                if !Self.hasStreamingTimelineItem(self.eventsBySession[sessionId] ?? []) {
                    let existing = self.eventsBySession[sessionId] ?? []
                    if let merged = Self.mergeIncrementalTimelineEvents(existing: existing, incoming: items) {
                        self.eventsBySession[sessionId] = merged
                        self.scheduleCacheSave()
                    }
                }
            } else if !items.isEmpty || self.eventsBySession[sessionId] == nil {
                if !Self.hasStreamingTimelineItem(self.eventsBySession[sessionId] ?? []) {
                    self.eventsBySession[sessionId] = items
                    self.scheduleCacheSave()
                }
            }
            if sessionItem?.status == .running || sessionItem?.status == .waitingApproval,
               let activeStart
            {
                self.turnStartedAtBySession[sessionId] = activeStart
            }
        case .e2eeRelay:
            if useIncremental, let m = meta {
                var cmd: [String: Any] = [
                    "cmd": "get_events_page",
                    "session_id": sessionId,
                    "after_seq": m.newestSeq,
                    "known_count": m.eventCount,
                    "limit": 140,
                ]
                if let ts = m.latestTsMs {
                    cmd["known_ts_ms"] = ts
                }
                sendEncryptedCommand(cmd)
            } else {
                oldestSeqBySession.removeValue(forKey: sessionId)
                sendEncryptedCommand(["cmd": "get_events_page", "session_id": sessionId, "limit": 140])
            }
        case .none:
            break
        }
    }

    private func enqueueStreamChunk(
        sessionId: String,
        isThinking: Bool,
        delta: String,
        replace: Bool,
        nowLabel: String,
        origin: Date
    ) {
        if let existing = pendingStreamChunks[sessionId], existing.isThinking != isThinking {
            flushPendingStreamChunks(onlySessionId: sessionId)
        }
        if var cur = pendingStreamChunks[sessionId], cur.isThinking == isThinking {
            cur.delta = replace ? delta : (cur.delta + delta)
            cur.replace = cur.replace || replace
            cur.nowLabel = nowLabel
            pendingStreamChunks[sessionId] = cur
        } else {
            pendingStreamChunks[sessionId] = PendingStreamChunk(
                isThinking: isThinking,
                delta: delta,
                replace: replace,
                nowLabel: nowLabel,
                origin: origin
            )
        }
        if streamFlushTask == nil {
            let delayNs: UInt64 = (sessionId == activeSessionId) ? 28_000_000 : 110_000_000
            streamFlushTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: delayNs)
                guard let self else { return }
                self.streamFlushTask = nil
                self.flushPendingStreamChunks(onlySessionId: nil)
            }
        }
    }

    private func flushPendingStreamChunks(onlySessionId: String?) {
        guard !pendingStreamChunks.isEmpty else { return }
        let items: [(String, PendingStreamChunk)]
        if let sid = onlySessionId {
            guard let chunk = pendingStreamChunks.removeValue(forKey: sid) else { return }
            items = [(sid, chunk)]
        } else {
            items = Array(pendingStreamChunks)
            pendingStreamChunks.removeAll()
            streamFlushTask?.cancel()
            streamFlushTask = nil
        }

        let now = Date()
        for (sid, chunk) in items {
            var list = eventsBySession[sid] ?? []
            if chunk.isThinking {
                if let last = list.last, case .thinking(let startedAt, let dur, _) = last.kind {
                    var updated = last
                    updated.content = chunk.replace
                        ? (chunk.delta.isEmpty ? last.content : chunk.delta)
                        : (last.content + chunk.delta)
                    updated.kind = .thinking(startedAt: startedAt ?? chunk.origin, durationMs: dur, isStreaming: true)
                    list[list.count - 1] = updated
                } else {
                    list.append(
                        TimelineEventItem(
                            id: "th-\(UUID().uuidString.prefix(8))",
                            sessionId: sid,
                            timestamp: chunk.nowLabel,
                            content: chunk.delta,
                            kind: .thinking(startedAt: chunk.origin, durationMs: nil, isStreaming: true)
                        )
                    )
                }
            } else {
                if let last = list.last, case .assistant(true) = last.kind {
                    var updated = last
                    updated.content = chunk.replace ? chunk.delta : (last.content + chunk.delta)
                    list[list.count - 1] = updated
                } else {
                    if let lastIdx = list.indices.last,
                       case .thinking(let startedAt, let dur, true) = list[lastIdx].kind
                    {
                        let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? chunk.origin) * 1000))
                        list[lastIdx].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
                    }
                    list.append(
                        TimelineEventItem(
                            id: "as-stream-\(UUID().uuidString.prefix(8))",
                            sessionId: sid,
                            timestamp: chunk.nowLabel,
                            content: chunk.delta,
                            kind: .assistant(isStreaming: true)
                        )
                    )
                }
            }
            eventsBySession[sid] = list
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


    private func matchedSkillPath(for text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        let body = String(trimmed.dropFirst())
        let lower = body.lowercased()
        let ranked = installedSkills.sorted { a, b in
            let aName = a.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let bName = b.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if aName.count != bName.count { return aName.count > bName.count }
            return a.scope == "project" && b.scope != "project"
        }
        for sk in ranked {
            let key = sk.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !key.isEmpty else { continue }
            if lower == key || lower.hasPrefix(key + " ") {
                return sk.path
            }
        }
        return nil
    }

    public func sendPrompt(
        sessionId: String,
        text: String,
        model: String,
        effort: String,
        images: [String] = [],
        approvalMode: String = "auto_edit",
        truncateToUserTurn: Int? = nil,
        executionMode: String? = nil,
        contextRefs: [VeloMeshContextRef] = []
    ) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty || !images.isEmpty else { return }
        let effectivePrompt = clean.isEmpty ? "请查看附图" : clean
        let skillPath = matchedSkillPath(for: effectivePrompt)

        // Offline Prompt Outbox: when disconnected (e.g., subway / plane / Mac sleeping),
        // persist locally and flush automatically once the daemon reconnects.
        let isTransportReady: Bool = {
            switch connectionConfig {
            case .direct:
                return isConnected
            case .e2eeRelay:
                return isConnected && isForwardSecretRatcheted
            case .none:
                return false
            }
        }()
        if !isTransportReady && truncateToUserTurn == nil {
            let queued = VeloOfflineQueuedPrompt(
                sessionId: sessionId,
                text: effectivePrompt,
                model: model,
                effort: effort,
                images: images,
                approvalMode: approvalMode
            )
            offlineOutbox.append(queued)
            persistOfflineOutbox()
            lastActionBanner = "离线暂存已保存 · 重连后自动发送"
            triggerHaptic(.light)
            return
        }

        // Server-authoritative Queue Mode: enqueue follow-up without disrupting active turn UI
        if executionMode == "queue",
           let idx = sessions.firstIndex(where: { $0.id == sessionId }),
           (sessions[idx].status == .running || sessions[idx].status == .waitingApproval)
        {
            var curQ = sessions[idx].activeQueuedPrompts
            curQ.append(
                VeloQueuedPromptItem(
                    id: "q-local-\(UUID().uuidString.prefix(8))",
                    input: effectivePrompt,
                    images: images
                )
            )
            sessions[idx].queuedPrompts = curQ
            triggerHaptic(.light)

            switch connectionConfig {
            case .direct(let baseURL):
                if let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/input") {
                    var req = URLRequest(url: url)
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    var queueBody: [String: Any] = [
                        "input": effectivePrompt,
                        "model": model,
                        "effort": effort,
                        "images": images,
                        "mode": "queue",
                    ]
                    if let skillPath {
                        queueBody["skill_path"] = skillPath
                    }
                    if !contextRefs.isEmpty {
                        queueBody["context_refs"] = contextRefs.map(\.jsonObject)
                    }
                    req.httpBody = try? JSONSerialization.data(withJSONObject: queueBody)
                    let localId = curQ.last?.id
                    if let (data, resp) = try? await URLSession.shared.data(for: req),
                       let http = resp as? HTTPURLResponse, http.statusCode < 400,
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let item = obj["item"] as? [String: Any],
                       let realId = item["id"] as? String,
                       let localId,
                       let idx2 = sessions.firstIndex(where: { $0.id == sessionId }) {
                        let stillQueued = sessions[idx2].activeQueuedPrompts.contains { $0.id == localId }
                        if stillQueued {
                            sessions[idx2].queuedPrompts = sessions[idx2].activeQueuedPrompts.map { q in
                                q.id == localId
                                    ? VeloQueuedPromptItem(id: realId, input: q.input, images: q.images)
                                    : q
                            }
                        } else if let encoded = realId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                                  let dropURL = URL(string: "\(baseURL)/api/sessions/\(sessionId)/queue/\(encoded)") {
                            var drop = URLRequest(url: dropURL)
                            drop.httpMethod = "DELETE"
                            _ = try? await URLSession.shared.data(for: drop)
                        }
                    }
                }
            case .e2eeRelay:
                var queuePayload: [String: Any] = [
                    "cmd": "send_input",
                    "session_id": sessionId,
                    "input": effectivePrompt,
                    "model": model,
                    "effort": effort,
                    "images": images,
                    "mode": "queue",
                ]
                if let skillPath {
                    queuePayload["skill_path"] = skillPath
                }
                sendEncryptedCommand(queuePayload)
            case .none:
                break
            }
            return
        }

        let now = Date()
        let timeStr = Self.shortTimeString(from: now)
        turnStartedAtBySession[sessionId] = now
        stepStartedAtBySession[sessionId] = now
        liveTpsBySession.removeValue(forKey: sessionId)
        streamStatsBySession.removeValue(forKey: sessionId)

        var list = eventsBySession[sessionId] ?? []
        if let truncIdx = truncateToUserTurn, truncIdx >= 0 {
            var seenUsers = 0
            var cutPos: Int?
            for (i, item) in list.enumerated() {
                if case .user = item.kind {
                    if seenUsers == truncIdx {
                        cutPos = i
                        break
                    }
                    seenUsers += 1
                }
            }
            if let cutPos {
                list.removeSubrange(cutPos..<list.count)
            }
        }

        // Optimistically append user bubble & mark session running
        let clientMsgId = "cmsg-\(UUID().uuidString.prefix(12).lowercased())"
        let userItem = TimelineEventItem(
            id: "u-local-\(clientMsgId)",
            sessionId: sessionId,
            timestamp: timeStr,
            content: clean,
            kind: .user(images: images),
            clientMsgId: clientMsgId
        )
        list.append(userItem)
        eventsBySession[sessionId] = list

        let matchedOpt = models.first(where: { $0.id == model })
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].status = .running
            sessions[idx].model = model
            sessions[idx].modelShort = matchedOpt?.shortLabel ?? VeloModelOption.shortLabel(for: model)
            if let ak = matchedOpt?.agentKind, !ak.isEmpty {
                sessions[idx].agentKind = ak
            }
            sessions[idx].effort = effort
            VeloLiveActivityManager.shared.markTurnStarted(sessionId: sessionId)
            VeloLiveActivityManager.shared.syncSessionActivity(
                session: sessions[idx],
                sessionId: sessionId,
                phase: "thinking",
                headline: "正在分析工作区上下文…",
                startedAt: now,
                forceImmediate: true
            )
        }
        let providerKind = matchedOpt?.agentKind ?? sessions.first(where: { $0.id == sessionId })?.agentKind ?? "claude"
        scheduleCacheSave()
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/input") else {
                finalizeSessionTurnLocally(sessionId)
                return
            }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "input": effectivePrompt,
                "model": model,
                "effort": effort,
                "provider": providerKind,
                "images": images,
                "approval_mode": approvalMode,
                "client_msg_id": clientMsgId,
            ]
            if let truncIdx = truncateToUserTurn {
                body["truncate_to_user_turn"] = truncIdx
                body["reset_thread"] = true
            }
            if let executionMode {
                body["mode"] = executionMode
            }
            if let skillPath {
                body["skill_path"] = skillPath
            }
            if !contextRefs.isEmpty {
                body["context_refs"] = contextRefs.map(\.jsonObject)
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                    let errMsg = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
                        ?? "发送失败 (HTTP \(http.statusCode))"
                    appendLocalErrorEvent(sessionId: sessionId, rawError: errMsg)
                    finalizeSessionTurnLocally(sessionId)
                }
            } catch {
                appendLocalErrorEvent(sessionId: sessionId, rawError: "请求发送失败：\(error.localizedDescription)")
                finalizeSessionTurnLocally(sessionId)
            }

        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "send_input",
                "session_id": sessionId,
                "input": effectivePrompt,
                "model": model,
                "effort": effort,
                "provider": providerKind,
                "images": images,
                "approval_mode": approvalMode,
                "client_msg_id": clientMsgId,
            ]
            if let truncIdx = truncateToUserTurn {
                payload["truncate_to_user_turn"] = truncIdx
                payload["reset_thread"] = true
            }
            if let executionMode {
                payload["mode"] = executionMode
            }
            if let skillPath {
                payload["skill_path"] = skillPath
            }
            if !contextRefs.isEmpty {
                payload["context_refs"] = contextRefs.map(\.jsonObject)
            }
            sendEncryptedCommand(payload)
        case .none:
            appendLocalErrorEvent(sessionId: sessionId, rawError: "当前未连接主机")
            finalizeSessionTurnLocally(sessionId)
        }
    }

    public func cancelMeshInvocation(_ invocationId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let encoded = invocationId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                  let url = URL(string: "\(baseURL)/api/mesh/invocations/\(encoded)/cancel")
            else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "cancel_mesh_invocation",
                "invocation_id": invocationId,
            ])
        case .none:
            break
        }
    }

    public func removeQueuedPrompt(sessionId: String, queueId: String) async {
        let input = sessions
            .first(where: { $0.id == sessionId })?
            .activeQueuedPrompts
            .first(where: { $0.id == queueId })?
            .input
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].queuedPrompts = sessions[idx].activeQueuedPrompts.filter { $0.id != queueId }
        }
        switch connectionConfig {
        case .direct(let baseURL):
            let encoded = queueId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? queueId
            var components = URLComponents(string: "\(baseURL)/api/sessions/\(sessionId)/queue/\(encoded)")
            if queueId.hasPrefix("q-local-"), let input, !input.isEmpty {
                components?.queryItems = [URLQueryItem(name: "input", value: input)]
            }
            guard let url = components?.url else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "remove_queued_prompt",
                "session_id": sessionId,
                "queue_id": queueId,
            ]
            if let input, !input.isEmpty {
                payload["input"] = input
            }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }

    /// Interrupt the active turn and run this queued prompt immediately.
    public func runQueuedPromptNow(sessionId: String, queueId: String) async {
        guard let item = sessions
            .first(where: { $0.id == sessionId })?
            .activeQueuedPrompts
            .first(where: { $0.id == queueId })
        else { return }

        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].queuedPrompts = sessions[idx].activeQueuedPrompts.filter { $0.id != queueId }
        }

        if !queueId.hasPrefix("q-local-") {
            switch connectionConfig {
            case .direct(let baseURL):
                let encoded = queueId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? queueId
                if let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/queue/\(encoded)/run") {
                    var req = URLRequest(url: url)
                    req.httpMethod = "POST"
                    if let (_, resp) = try? await URLSession.shared.data(for: req),
                       let http = resp as? HTTPURLResponse, http.statusCode < 400 {
                        await loadEventsForSession(sessionId)
                        return
                    }
                }
            case .e2eeRelay:
                sendEncryptedCommand([
                    "cmd": "run_queued_prompt",
                    "session_id": sessionId,
                    "queue_id": queueId,
                ])
                return
            case .none:
                break
            }
        }

        if queueId.hasPrefix("q-local-") {
            switch connectionConfig {
            case .direct(let baseURL):
                let encoded = queueId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? queueId
                var components = URLComponents(string: "\(baseURL)/api/sessions/\(sessionId)/queue/\(encoded)")
                components?.queryItems = [URLQueryItem(name: "input", value: item.input)]
                if let url = components?.url {
                    var req = URLRequest(url: url)
                    req.httpMethod = "DELETE"
                    _ = try? await URLSession.shared.data(for: req)
                }
            case .e2eeRelay:
                sendEncryptedCommand([
                    "cmd": "remove_queued_prompt",
                    "session_id": sessionId,
                    "queue_id": queueId,
                    "input": item.input,
                ])
            case .none:
                break
            }
        } else {
            await removeQueuedPrompt(sessionId: sessionId, queueId: queueId)
        }
        let model = sessions.first(where: { $0.id == sessionId })?.model ?? ""
        let effort = sessions.first(where: { $0.id == sessionId })?.effort ?? "medium"
        await sendPrompt(
            sessionId: sessionId,
            text: item.input,
            model: model,
            effort: effort,
            images: item.images,
            executionMode: "steer"
        )
    }

    // MARK: - Offline Outbox, Turn Checkpoints & Local MCP/Skills Extensions (v0.6.0)

    private func persistOfflineOutbox() {
        if let data = try? JSONEncoder().encode(offlineOutbox) {
            UserDefaults.standard.set(data, forKey: Self.offlineOutboxKey)
        }
    }

    public func removeOfflinePrompt(id: String) {
        offlineOutbox.removeAll { $0.id == id }
        persistOfflineOutbox()
    }

    public func flushOfflineOutboxIfConnected() async {
        guard !offlineOutbox.isEmpty, !isFlushingOfflineOutbox, isConnected else { return }
        if case .e2eeRelay = connectionConfig, !isForwardSecretRatcheted {
            return
        }
        isFlushingOfflineOutbox = true
        defer { isFlushingOfflineOutbox = false }

        let snapshot = offlineOutbox
        var flushedAny = false
        for item in snapshot {
            guard isConnected else { break }
            guard let sess = sessions.first(where: { $0.id == item.sessionId }) else {
                // Drop orphaned outbox entry if session was deleted on Mac
                offlineOutbox.removeAll { $0.id == item.id }
                persistOfflineOutbox()
                continue
            }
            offlineOutbox.removeAll { $0.id == item.id }
            persistOfflineOutbox()
            flushedAny = true

            let mode: String? = (sess.status == .running || sess.status == .waitingApproval) ? "queue" : nil
            await sendPrompt(
                sessionId: item.sessionId,
                text: item.text,
                model: item.model,
                effort: item.effort,
                images: item.images,
                approvalMode: item.approvalMode,
                executionMode: mode
            )
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        if flushedAny {
            lastActionBanner = "✅ 离线暂存指令已自动重发"
        }
    }

    public func fetchCheckpoints(for sessionId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/checkpoints"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["checkpoints"] as? [[String: Any]]
            else { return }
            checkpointsBySession[sessionId] = arr.compactMap(VeloTurnCheckpointItem.fromJSON)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_checkpoints", "session_id": sessionId])
        case .none:
            break
        }
    }

    @discardableResult
    public func rewindCheckpoint(sessionId: String, checkpointId: String) async -> Bool {
        triggerHaptic(.medium)
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/checkpoints/rewind") else { return false }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["checkpoint_id": checkpointId])
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return false }
            let ok = (obj["ok"] as? Bool) ?? false
            if let arr = obj["checkpoints"] as? [[String: Any]] {
                checkpointsBySession[sessionId] = arr.compactMap(VeloTurnCheckpointItem.fromJSON)
            }
            if ok {
                lastActionBanner = "✅ 已回滚至目标轮次快照（并自动留存回滚前备份）"
                await fetchDiff(for: sessionId)
            } else {
                lastActionBanner = "⚠️ \((obj["error"] as? String) ?? "检查点回滚失败")"
            }
            return ok
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "rewind_checkpoint",
                "session_id": sessionId,
                "checkpoint_id": checkpointId,
            ])
            return true
        case .none:
            return false
        }
    }

    public func fetchExtensions(workspace: String? = nil) async {
        let trimmedWs = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch connectionConfig {
        case .direct(let baseURL):
            var components = URLComponents(string: "\(baseURL)/api/extensions")
            if !trimmedWs.isEmpty {
                components?.queryItems = [URLQueryItem(name: "workspace", value: trimmedWs)]
            }
            guard let url = components?.url,
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            if let arr = obj["mcp_servers"] as? [[String: Any]] {
                mcpServers = arr.compactMap(VeloMcpServerItem.fromJSON)
            }
            if let arr = obj["skills"] as? [[String: Any]] {
                installedSkills = arr.compactMap(VeloSkillItem.fromJSON)
            }
        case .e2eeRelay:
            var payload: [String: Any] = ["cmd": "get_extensions"]
            if !trimmedWs.isEmpty {
                payload["workspace"] = trimmedWs
            }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }

    public func readSkillContent(path: String) async -> String? {
        let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else { return nil }
        switch connectionConfig {
        case .direct(let baseURL):
            var components = URLComponents(string: "\(baseURL)/api/extensions/skill-content")
            components?.queryItems = [URLQueryItem(name: "path", value: trimmedPath)]
            guard let url = components?.url,
                  let (data, resp) = try? await URLSession.shared.data(from: url),
                  let http = resp as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return nil }
            return obj["content"] as? String
        case .e2eeRelay:
            let reqId = "sk-\(UUID().uuidString.prefix(8))"
            return await withCheckedContinuation { cont in
                self.skillContentWaiters[reqId] = cont
                self.sendEncryptedCommand([
                    "cmd": "read_skill_content",
                    "request_id": reqId,
                    "path": trimmedPath,
                ])
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 12_000_000_000)
                    if let waiter = self?.skillContentWaiters.removeValue(forKey: reqId) {
                        waiter.resume(returning: nil)
                    }
                }
            }
        case .none:
            return nil
        }
    }

    public func saveCustomSkill(
        name: String,
        description: String,
        content: String,
        scope: String,
        workspace: String? = nil,
        existingPath: String? = nil
    ) async -> Bool {
        let trimmedWs = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var body: [String: Any] = [
            "name": name,
            "description": description,
            "content": content,
            "scope": scope,
        ]
        if !trimmedWs.isEmpty {
            body["workspace"] = trimmedWs
        }
        if let existing = existingPath, !existing.isEmpty {
            body["existing_path"] = existing
        }

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/extensions/skills"),
                  let payload = try? JSONSerialization.data(withJSONObject: body)
            else { return false }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = payload
            guard let (_, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                lastActionBanner = "⚠️ 保存自定义 Skill 失败"
                return false
            }
            lastActionBanner = "✅ 已保存自定义 Skill「\(name)」"
            await fetchExtensions(workspace: workspace)
            return true
        case .e2eeRelay:
            var cmd = body
            cmd["cmd"] = "save_custom_skill"
            sendEncryptedCommand(cmd)
            lastActionBanner = "✅ 已同步保存自定义 Skill「\(name)」"
            return true
        case .none:
            return false
        }
    }

    public func deleteCustomSkill(path: String, workspace: String? = nil) async -> Bool {
        let trimmedWs = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var body: [String: Any] = ["path": path]
        if !trimmedWs.isEmpty {
            body["workspace"] = trimmedWs
        }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/extensions/skills"),
                  let payload = try? JSONSerialization.data(withJSONObject: body)
            else { return false }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = payload
            guard let (_, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode)
            else {
                lastActionBanner = "⚠️ 删除 Skill 失败"
                return false
            }
            lastActionBanner = "🗑️ 已删除自定义 Skill"
            await fetchExtensions(workspace: workspace)
            return true
        case .e2eeRelay:
            var cmd = body
            cmd["cmd"] = "delete_custom_skill"
            sendEncryptedCommand(cmd)
            lastActionBanner = "🗑️ 已同步删除自定义 Skill"
            return true
        case .none:
            return false
        }
    }


    public func fetchExternalCliSessions() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/cli-sessions"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["sessions"] as? [[String: Any]]
            else { return }
            externalCliSessions = arr.compactMap(VeloExternalCliSessionItem.fromJSON)
            if let hc = VeloSessionItem.intValue(obj["hidden_count"]) {
                hiddenCliSessionsCount = hc
            }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "list_cli_sessions"])
        case .none:
            break
        }
    }

    public func manageExternalCliSessions(
        action: String,
        items: [(provider: String, cliSessionId: String)]
    ) async {
        let payloadItems: [[String: String]] = items.map {
            ["provider": $0.provider, "cli_session_id": $0.cliSessionId]
        }
        if action == "delete" || action == "hide" {
            let removeKeys = Set(items.map { "\($0.provider.lowercased())-\($0.cliSessionId)" })
            externalCliSessions.removeAll { removeKeys.contains($0.id) }
        }
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/cli-sessions/manage") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "action": action,
                "items": payloadItems,
            ])
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            if let arr = obj["sessions"] as? [[String: Any]] {
                externalCliSessions = arr.compactMap(VeloExternalCliSessionItem.fromJSON)
            }
            if let hc = VeloSessionItem.intValue(obj["hidden_count"]) {
                hiddenCliSessionsCount = hc
            }
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "manage_cli_sessions",
                "action": action,
                "items": payloadItems,
            ])
        case .none:
            break
        }
    }


    public func importExternalCliSession(provider: String, cliSessionId: String) async -> String? {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/cli-sessions/import") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "provider": provider,
                "cli_session_id": cliSessionId,
            ])
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let sessDict = obj["session"] as? [String: Any],
                  let item = VeloSessionItem.fromJSON(sessDict)
            else { return nil }
            sessions.removeAll { $0.id == item.id }
            sessions.insert(item, at: 0)
            activeSessionId = item.id
            await loadEventsForSession(item.id)
            return item.id
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "import_cli_session",
                "provider": provider,
                "cli_session_id": cliSessionId,
            ])
            return nil
        case .none:
            return nil
        }
    }

    public func archiveSession(_ sessionId: String, archived: Bool) async {
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].archived = archived
            if archived && activeSessionId == sessionId {
                activeSessionId = sessions.first(where: { !$0.isArchived && $0.id != sessionId })?.id
            }
            scheduleCacheSave()
        }
        triggerHaptic(.light)
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/archive") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["archived": archived])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "archive_session",
                "session_id": sessionId,
                "archived": archived,
            ])
        case .none:
            break
        }
    }


    public func forkSession(
        _ sessionId: String,
        upToUserTurn: Int? = nil,
        upToUserText: String? = nil,
        userTurnsFromEnd: Int? = nil,
        title: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        effort: String? = nil,
        initialPrompt: String? = nil
    ) async -> String? {
        triggerHaptic(.medium)
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/fork") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [:]
            if let t = upToUserTurn { body["up_to_user_turn"] = t }
            if let txt = upToUserText, !txt.isEmpty { body["up_to_user_text"] = txt }
            if let fromEnd = userTurnsFromEnd { body["user_turns_from_end"] = fromEnd }
            if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["title"] = title }
            if let provider, !provider.isEmpty { body["provider"] = provider }
            if let model, !model.isEmpty { body["model"] = model }
            if let effort, !effort.isEmpty { body["effort"] = effort }
            if let initialPrompt, !initialPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                body["initial_prompt"] = initialPrompt
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            guard let (data, _) = try? await URLSession.shared.data(for: req),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let sessDict = obj["session"] as? [String: Any],
                  let item = VeloSessionItem.fromJSON(sessDict)
            else { return nil }
            sessions.removeAll { $0.id == item.id }
            sessions.insert(item, at: 0)
            activeSessionId = item.id
            latestCreatedOrHandoffSessionId = item.id
            await loadEventsForSession(item.id)
            return item.id
        case .e2eeRelay:
            var payload: [String: Any] = ["cmd": "fork_session", "session_id": sessionId]
            if let t = upToUserTurn { payload["up_to_user_turn"] = t }
            if let txt = upToUserText, !txt.isEmpty { payload["up_to_user_text"] = txt }
            if let fromEnd = userTurnsFromEnd { payload["user_turns_from_end"] = fromEnd }
            if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { payload["title"] = title }
            if let provider, !provider.isEmpty { payload["provider"] = provider }
            if let model, !model.isEmpty { payload["model"] = model }
            if let effort, !effort.isEmpty { payload["effort"] = effort }
            if let initialPrompt, !initialPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                payload["initial_prompt"] = initialPrompt
            }
            sendEncryptedCommand(payload)
            return nil
        case .none:
            return nil
        }
    }

    public func uploadDocumentAttachment(
        data: Data,
        filename: String,
        mimeType: String = "application/octet-stream"
    ) async -> String? {
        guard !data.isEmpty, data.count <= 20 * 1024 * 1024 else { return nil }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/attachments") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "filename": filename,
                "mime_type": mimeType,
                "data_base64": data.base64EncodedString(),
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            guard let (respData, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let obj = (try? JSONSerialization.jsonObject(with: respData)) as? [String: Any],
                  let savedPath = obj["path"] as? String
            else { return nil }
            return savedPath
        case .e2eeRelay:
            let uploadId = "doc-\(UUID().uuidString.prefix(12))"
            let result: (path: String, url: String)? = await withCheckedContinuation { cont in
                self.attachmentUploadWaiters[uploadId] = cont
                let chunkSize = 160 * 1024
                if data.count <= chunkSize {
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment",
                        "upload_id": uploadId,
                        "filename": filename,
                        "mime_type": mimeType,
                        "data_base64": data.base64EncodedString(),
                    ])
                } else {
                    var slices: [Data] = []
                    var offset = 0
                    while offset < data.count {
                        let end = min(data.count, offset + chunkSize)
                        slices.append(data.subdata(in: offset..<end))
                        offset = end
                    }
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment_begin",
                        "upload_id": uploadId,
                        "filename": filename,
                        "mime_type": mimeType,
                        "total_chunks": slices.count,
                    ])
                    for (idx, slice) in slices.enumerated() {
                        self.sendEncryptedCommand([
                            "cmd": "upload_attachment_chunk",
                            "upload_id": uploadId,
                            "index": idx,
                            "chunk_base64": slice.base64EncodedString(),
                        ])
                    }
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment_complete",
                        "upload_id": uploadId,
                    ])
                }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 18_000_000_000)
                    if let pending = self?.attachmentUploadWaiters.removeValue(forKey: uploadId) {
                        pending.resume(returning: nil)
                    }
                }
            }
            return result?.path
        case .none:
            return nil
        }
    }

    public func fetchQuotas() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/analytics/quotas"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["providers"] as? [[String: Any]]
            else { return }
            quotaCards = arr.compactMap(VeloProviderQuotaCard.fromJSON)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_quotas"])
        case .none:
            break
        }
    }


    public func fetchRemoteHosts() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/hosts"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["hosts"] as? [[String: Any]]
            else { return }
            remoteHosts = arr.compactMap(VeloRemoteHostItem.fromJSON)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "list_hosts"])
        case .none:
            break
        }
    }


    public func addRemoteHost(label: String, sshTarget: String, defaultCwd: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/hosts") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "label": label,
                "ssh_target": sshTarget,
                "default_cwd": defaultCwd,
                "prefer_hush": true,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await fetchRemoteHosts()
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "add_host",
                "label": label,
                "ssh_target": sshTarget,
                "default_cwd": defaultCwd,
            ])
        case .none:
            break
        }
    }


    public func removeRemoteHost(_ hostId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/hosts/\(hostId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            _ = try? await URLSession.shared.data(for: req)
            await fetchRemoteHosts()
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "remove_host", "host_id": hostId])
        case .none:
            break
        }
    }


    public func dispatchRemoteSshSession(
        hostId: String,
        provider: String,
        prompt: String,
        cwd: String? = nil
    ) async {
        triggerHaptic(.medium)
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/hosts/\(hostId)/dispatch") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = ["provider": provider, "prompt": prompt]
            if let cwd, !cwd.isEmpty { body["cwd"] = cwd }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let sessDict = obj["session"] as? [String: Any],
               let item = VeloSessionItem.fromJSON(sessDict)
            {
                sessions.removeAll { $0.id == item.id }
                sessions.insert(item, at: 0)
                activeSessionId = item.id
                latestCreatedOrHandoffSessionId = item.id
                await loadEventsForSession(item.id)
            }
        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "dispatch_ssh_session",
                "host_id": hostId,
                "provider": provider,
                "prompt": prompt,
            ]
            if let cwd, !cwd.isEmpty { payload["cwd"] = cwd }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }


    // MARK: - Git, PR, Advisor, Voice, Pagination, Search, Analytics & Push RPCs

    public func gitCommit(sessionId: String, message: String, push: Bool) async {
        lastActionBanner = nil
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/git/commit") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["message": message, "push": push])
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                let ok = (obj["ok"] as? Bool) ?? false
                lastActionBanner = ok ? (push ? "✅ 已提交并推送到远端" : "✅ 已完成本地 Git Commit") : "⚠️ 提交未成功（可能无新增改动）"
                await fetchDiff(for: sessionId)
            }
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "git_commit",
                "session_id": sessionId,
                "message": message,
                "push": push,
            ])
        case .none:
            break
        }
    }


    public func gitDiscard(sessionId: String, filePath: String? = nil, all: Bool = false) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/git/discard") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = ["all": all]
            if let fp = filePath { body["file_path"] = fp }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            _ = try? await URLSession.shared.data(for: req)
            lastActionBanner = "✅ 已回滚未提交变更"
            await fetchDiff(for: sessionId)
        case .e2eeRelay:
            var payload: [String: Any] = ["cmd": "git_discard", "session_id": sessionId, "all": all]
            if let fp = filePath { payload["file_path"] = fp }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }


    public func gitMerge(sessionId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/git/merge") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                let ok = (obj["ok"] as? Bool) ?? false
                lastActionBanner = ok ? "✅ 分支已合并回主目录" : "⚠️ 合并存在冲突或失败"
            }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "git_merge", "session_id": sessionId])
        case .none:
            break
        }
    }


    public func fetchPrStatus(for sessionId: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/pr"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            prBySession[sessionId] = VeloPrSnapshot.fromJSON(obj)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_pr", "session_id": sessionId])
        case .none:
            break
        }
    }


    public func createPullRequest(sessionId: String, title: String, body: String, draft: Bool = false) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/pr/create") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "title": title,
                "body": body,
                "draft": draft,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await fetchPrStatus(for: sessionId)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "create_pr",
                "session_id": sessionId,
                "title": title,
                "body": body,
                "draft": draft,
            ])
        case .none:
            break
        }
    }


    public func mergePullRequest(sessionId: String, method: String = "squash") async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/pr/merge") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["method": method])
            _ = try? await URLSession.shared.data(for: req)
            await fetchPrStatus(for: sessionId)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "merge_pr",
                "session_id": sessionId,
                "method": method,
            ])
        case .none:
            break
        }
    }


    public func requestAdvisorReview(sessionId: String, advisorProvider: String = "codex") async -> String? {
        latestCreatedOrHandoffSessionId = nil
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)/advisor") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["advisor_provider": advisorProvider])
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  (resp as? HTTPURLResponse)?.statusCode == 201,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let created = VeloSessionItem.fromJSON(obj)
            else { return nil }
            sessions.insert(created, at: 0)
            activeSessionId = created.id
            return created.id
        case .e2eeRelay:
            pendingSelectNewestSession = true
            sendEncryptedCommand([
                "cmd": "advisor_session",
                "session_id": sessionId,
                "advisor_provider": advisorProvider,
            ])
            for _ in 0..<24 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                if let newId = latestCreatedOrHandoffSessionId {
                    return newId
                }
            }
            return nil
        case .none:
            return nil
        }
    }

    public func loadOlderEventsPage(for sessionId: String) async {
        let beforeSeq = oldestSeqBySession[sessionId]
        switch connectionConfig {
        case .direct(let baseURL):
            var comp = URLComponents(string: "\(baseURL)/api/sessions/\(sessionId)/events")
            var qItems = [URLQueryItem(name: "limit", value: "160")]
            if let beforeSeq {
                qItems.append(URLQueryItem(name: "before_seq", value: "\(beforeSeq)"))
            }
            comp?.queryItems = qItems
            guard let url = comp?.url,
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let rawEvs = obj["events"] as? [[String: Any]]
            else { return }
            mergeOlderEventsPage(
                sessionId: sessionId,
                rawEvents: rawEvs,
                oldestSeq: VeloSessionItem.intValue(obj["oldest_seq"]),
                hasMore: (obj["has_more"] as? Bool) ?? false
            )
        case .e2eeRelay:
            var payload: [String: Any] = ["cmd": "get_events_page", "session_id": sessionId, "limit": 140]
            if let beforeSeq { payload["before_seq"] = beforeSeq }
            sendEncryptedCommand(payload)
        case .none:
            break
        }
    }


    private func mergeOlderEventsPage(
        sessionId: String,
        rawEvents: [[String: Any]],
        oldestSeq: Int?,
        hasMore: Bool
    ) {
        let isInitialPage = (oldestSeqBySession[sessionId] == nil)
        if let oldestSeq { oldestSeqBySession[sessionId] = oldestSeq }
        hasMoreHistoryBySession[sessionId] = hasMore

        let sessionItem = sessions.first(where: { $0.id == sessionId })
        let prov = sessionItem?.agentKind ?? "claude"
        let (parsed, activeStart) = Self.reconstructEventsWithActiveTurn(
            sessionId: sessionId,
            rawList: rawEvents,
            fallbackProvider: prov
        )
        if isInitialPage {
            if !parsed.isEmpty || eventsBySession[sessionId] == nil {
                if !Self.hasStreamingTimelineItem(eventsBySession[sessionId] ?? []) {
                    eventsBySession[sessionId] = parsed
                    scheduleCacheSave()
                }
            }
            if sessionItem?.status == .running || sessionItem?.status == .waitingApproval,
               let activeStart
            {
                turnStartedAtBySession[sessionId] = activeStart
            }
            return
        }

        guard !parsed.isEmpty else { return }
        let existing = eventsBySession[sessionId] ?? []
        if existing.isEmpty {
            eventsBySession[sessionId] = parsed
            return
        }
        let existingContents = Set(existing.prefix(10).map { "\($0.timestamp)|\($0.content.prefix(64))" })
        let uniqueOlder = parsed.filter { !existingContents.contains("\($0.timestamp)|\($0.content.prefix(64))") }
        if !uniqueOlder.isEmpty {
            eventsBySession[sessionId] = uniqueOlder + existing
        }
    }

    public func fetchUsageAnalytics() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/analytics/usage"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            usageAnalytics = VeloUsageAnalytics.fromJSON(obj)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_usage_analytics"])
        case .none:
            break
        }
    }


    public func searchGlobalSessions(query: String) async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            globalSearchHits = []
            return
        }
        switch connectionConfig {
        case .direct(let baseURL):
            var comp = URLComponents(string: "\(baseURL)/api/search")
            comp?.queryItems = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: "35")]
            guard let url = comp?.url,
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["hits"] as? [[String: Any]]
            else { return }
            globalSearchHits = arr.enumerated().compactMap { VeloSearchHit.fromJSON($0.element, index: $0.offset) }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "search_sessions", "query": q, "limit": 35])
        case .none:
            break
        }
    }


    public func fetchPushConfig() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/push/config"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let cfgObj = obj["config"] as? [String: Any]
            else { return }
            pushConfig = VeloPushConfig.fromJSON(cfgObj)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "get_push_config"])
        case .none:
            break
        }
    }


    public func savePushConfig(_ cfg: VeloPushConfig) async {
        pushConfig = cfg
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/push/config") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: cfg.toJSON())
            _ = try? await URLSession.shared.data(for: req)
            lastActionBanner = "✅ 已保存远程锁屏推送配置"
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "set_push_config", "config": cfg.toJSON()])
            lastActionBanner = "✅ 已同步远程锁屏推送配置"
        case .none:
            break
        }
    }


    public func sendTestPush() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/push/test") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                let ok = (obj["ok"] as? Bool) ?? false
                lastActionBanner = ok ? "✅ 测试推送已发送，请查看锁屏" : "⚠️ \((obj["error"] as? String) ?? "推送失败")"
            }
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "test_push"])
        case .none:
            break
        }
    }


    public func fetchAutomations() async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let arr = obj["automations"] as? [[String: Any]]
            else { return }
            automations = arr.compactMap(VeloAutomationItem.fromJSON)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "list_automations"])
        case .none:
            break
        }
    }


    public func toggleAutomation(id: String, enabled: Bool) async {
        if let idx = automations.firstIndex(where: { $0.id == id }) {
            automations[idx].enabled = enabled
        }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations/\(id)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": enabled])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "toggle_automation", "id": id, "enabled": enabled])
        case .none:
            break
        }
    }


    public func triggerAutomation(id: String) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations/\(id)/trigger") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            _ = try? await URLSession.shared.data(for: req)
            await refreshSessionsAndActiveEvents()
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "trigger_automation", "id": id])
        case .none:
            break
        }
    }


    public func deleteAutomation(id: String) async {
        automations.removeAll { $0.id == id }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations/\(id)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand(["cmd": "delete_automation", "id": id])
        case .none:
            break
        }
    }


    public func createNaturalAutomation(
        naturalInput: String,
        repoPath: String,
        provider: String
    ) async {
        let trimmed = naturalInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "enabled": true,
                "natural_input": trimmed,
                "repo_path": repoPath,
                "provider": provider,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await fetchAutomations()
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "create_automation",
                "natural_input": trimmed,
                "repo_path": repoPath,
                "provider": provider,
            ])
        case .none:
            break
        }
    }

    public func createAutomation(
        name: String,
        cronExpr: String,
        repoPath: String,
        provider: String,
        promptTemplate: String
    ) async {
        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/automations") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "name": name,
                "enabled": true,
                "trigger_type": "cron",
                "cron_expr": cronExpr,
                "repo_path": repoPath,
                "provider": provider,
                "prompt_template": promptTemplate,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await fetchAutomations()
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "create_automation",
                "name": name,
                "cron_expr": cronExpr,
                "repo_path": repoPath,
                "provider": provider,
                "prompt_template": promptTemplate,
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
        effort: String,
        images: [String] = [],
        useWorktree: Bool = false
    ) async -> String? {
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectivePrompt = (cleanPrompt.isEmpty && !images.isEmpty) ? "请查看附图" : cleanPrompt
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "provider": modelOption.agentKind.isEmpty ? "claude" : modelOption.agentKind,
                "prompt": effectivePrompt,
                "repo_path": repoPath,
                "model": modelOption.id,
                "effort": effort,
                "images": images,
                "approval_mode": "auto_edit",
                "use_worktree": useWorktree,
            ]
            if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty {
                body["name"] = title.trimmingCharacters(in: .whitespaces)
            }
            if useWorktree, let branch, !branch.trimmingCharacters(in: .whitespaces).isEmpty {
                body["branch"] = branch.trimmingCharacters(in: .whitespaces)
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let created = VeloSessionItem.fromJSON(dict)
            {
                let now = Date()
                if !effectivePrompt.isEmpty || !images.isEmpty {
                    turnStartedAtBySession[created.id] = now
                    stepStartedAtBySession[created.id] = now
                    eventsBySession[created.id] = [
                        TimelineEventItem(
                            id: "u-init-\(UUID().uuidString.prefix(6))",
                            sessionId: created.id,
                            timestamp: Self.shortTimeString(from: now),
                            content: cleanPrompt,
                            kind: .user(images: images)
                        )
                    ]
                } else {
                    eventsBySession[created.id] = []
                }
                sessions.insert(created, at: 0)
                activeSessionId = created.id
                latestCreatedOrHandoffSessionId = created.id
                scheduleCacheSave()
                return created.id
            }
            return nil

        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "create_session",
                "provider": modelOption.agentKind.isEmpty ? "claude" : modelOption.agentKind,
                "prompt": effectivePrompt,
                "repo_path": repoPath,
                "model": modelOption.id,
                "effort": effort,
                "images": images,
                "approval_mode": "auto_edit",
                "use_worktree": useWorktree,
            ]
            if let title, !title.isEmpty { payload["name"] = title }
            if useWorktree, let branch, !branch.isEmpty { payload["branch"] = branch }
            pendingSelectNewestSession = true
            sendEncryptedCommand(payload)
            return nil

        case .none:
            return nil
        }
    }

    // MARK: - Paseo-Style Tiered Attachment Lazy Fetch & Chunked E2EE Upload

    public func loadAttachmentImage(ref rawRef: String, tier: AttachmentTier = .thumb) async -> UIImage? {
        let ref = rawRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ref.isEmpty else { return nil }

        if let cached = VeloAttachmentCache.shared.cachedImage(for: ref, tier: tier) {
            return cached
        }

        if ref.hasPrefix("http://") || ref.hasPrefix("https://") {
            guard let url = URL(string: ref),
                  let (data, resp) = try? await URLSession.shared.data(from: url),
                  (resp as? HTTPURLResponse)?.statusCode == 200
            else { return nil }
            return VeloAttachmentCache.shared.store(data: data, for: ref, tier: tier)
        }

        switch connectionConfig {
        case .direct(let baseURL):
            var comp = URLComponents(string: "\(baseURL)/api/attachments-resolve")
            comp?.queryItems = [
                URLQueryItem(name: "ref", value: ref),
                URLQueryItem(name: "tier", value: tier.rawValue),
            ]
            guard let url = comp?.url,
                  let (data, resp) = try? await URLSession.shared.data(from: url),
                  (resp as? HTTPURLResponse)?.statusCode == 200
            else { return nil }
            return VeloAttachmentCache.shared.store(data: data, for: ref, tier: tier)

        case .e2eeRelay:
            let reqKey = "\(tier.rawValue):\(ref)"
            let data: Data? = await withCheckedContinuation { cont in
                let isFirst = (self.attachmentDownloadWaiters[reqKey] == nil)
                self.attachmentDownloadWaiters[reqKey, default: []].append(cont)
                if isFirst {
                    self.sendEncryptedCommand([
                        "cmd": "get_attachment",
                        "request_id": reqKey,
                        "ref": ref,
                        "tier": tier.rawValue,
                    ])
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 14_000_000_000)
                        guard let self, let waiters = self.attachmentDownloadWaiters.removeValue(forKey: reqKey) else {
                            return
                        }
                        self.attachmentChunkBuffers.removeValue(forKey: reqKey)
                        for w in waiters {
                            w.resume(returning: nil)
                        }
                    }
                }
            }
            guard let data, !data.isEmpty else { return nil }
            return VeloAttachmentCache.shared.store(data: data, for: ref, tier: tier)

        case .none:
            return nil
        }
    }

    public func uploadAttachment(jpegData: Data, preview: UIImage, filename: String = "photo.jpg") async -> String? {
        guard !jpegData.isEmpty else { return nil }

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/attachments") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: Any] = [
                "filename": filename,
                "mime_type": "image/jpeg",
                "data_base64": jpegData.base64EncodedString(),
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let savedPath = obj["path"] as? String
            else { return nil }
            let savedURL = (obj["url"] as? String) ?? ""
            VeloAttachmentCache.shared.storeUploaded(image: preview, jpegData: jpegData, refs: [savedPath, savedURL])
            return savedPath

        case .e2eeRelay:
            let uploadId = "up-\(UUID().uuidString.prefix(12))"
            let result: (path: String, url: String)? = await withCheckedContinuation { cont in
                self.attachmentUploadWaiters[uploadId] = cont
                let chunkSize = 160 * 1024
                if jpegData.count <= chunkSize {
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment",
                        "upload_id": uploadId,
                        "filename": filename,
                        "mime_type": "image/jpeg",
                        "data_base64": jpegData.base64EncodedString(),
                    ])
                } else {
                    var slices: [Data] = []
                    var offset = 0
                    while offset < jpegData.count {
                        let end = min(jpegData.count, offset + chunkSize)
                        slices.append(jpegData.subdata(in: offset..<end))
                        offset = end
                    }
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment_begin",
                        "upload_id": uploadId,
                        "filename": filename,
                        "mime_type": "image/jpeg",
                        "total_chunks": slices.count,
                    ])
                    for (idx, part) in slices.enumerated() {
                        self.sendEncryptedCommand([
                            "cmd": "upload_attachment_chunk",
                            "upload_id": uploadId,
                            "chunk_index": idx,
                            "data_base64": part.base64EncodedString(),
                        ])
                    }
                    self.sendEncryptedCommand([
                        "cmd": "upload_attachment_complete",
                        "upload_id": uploadId,
                    ])
                }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 18_000_000_000)
                    guard let self, let waiter = self.attachmentUploadWaiters.removeValue(forKey: uploadId) else {
                        return
                    }
                    waiter.resume(returning: nil)
                }
            }
            guard let result else { return nil }
            VeloAttachmentCache.shared.storeUploaded(image: preview, jpegData: jpegData, refs: [result.path, result.url])
            return result.path

        case .none:
            return nil
        }
    }

    public func renameSession(_ sessionId: String, newTitle: String) async {
        let cleanTitle = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }

        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].title = cleanTitle
            scheduleCacheSave()
        }
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": cleanTitle])
            _ = try? await URLSession.shared.data(for: req)

        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "update_session",
                "session_id": sessionId,
                "name": cleanTitle,
            ])

        case .none:
            break
        }
    }

    public func relocateWorkspace(oldPath: String, newPath: String) async {
        let cleanOld = VeloFormatting.canonicalWorkspacePath(oldPath)
        let cleanNew = VeloFormatting.canonicalWorkspacePath(newPath)
        guard !cleanNew.isEmpty, cleanOld != cleanNew else { return }

        workspaces = workspaces.map { VeloFormatting.canonicalWorkspacePath($0) == cleanOld ? cleanNew : $0 }
        for idx in sessions.indices {
            if VeloFormatting.canonicalWorkspacePath(sessions[idx].repoRoot) == cleanOld {
                let wasMain = VeloFormatting.canonicalWorkspacePath(sessions[idx].worktreePath) == cleanOld
                sessions[idx].repoRoot = cleanNew
                if wasMain {
                    sessions[idx].worktreePath = cleanNew
                }
            }
        }
        scheduleCacheSave()
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/workspaces") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "old_path": cleanOld,
                "new_path": cleanNew,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await refreshSessionsAndActiveEvents()
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "relocate_workspace",
                "old_path": cleanOld,
                "new_path": cleanNew,
            ])
        case .none:
            break
        }
    }

    public func removeWorkspaceFolder(_ rawPath: String) async {
        let clean = VeloFormatting.canonicalWorkspacePath(rawPath)
        workspaces.removeAll { VeloFormatting.canonicalWorkspacePath($0) == clean }
        let removedIds = sessions
            .filter { VeloFormatting.canonicalWorkspacePath($0.repoRoot) == clean }
            .map(\.id)
        sessions.removeAll { VeloFormatting.canonicalWorkspacePath($0.repoRoot) == clean }
        for sid in removedIds {
            eventsBySession.removeValue(forKey: sid)
        }
        if let cur = activeSessionId, removedIds.contains(cur) {
            activeSessionId = sessions.first(where: { !$0.isArchived })?.id
        }
        scheduleCacheSave()
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/workspaces") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "path": clean,
                "delete_sessions": true,
            ])
            _ = try? await URLSession.shared.data(for: req)
            await refreshSessionsAndActiveEvents()
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "remove_workspace",
                "path": clean,
                "delete_sessions": true,
            ])
        case .none:
            break
        }
    }

    public func moveSessionToRepo(sessionId: String, newRepoPath: String) async {
        let cleanNew = VeloFormatting.canonicalWorkspacePath(newRepoPath)
        guard !cleanNew.isEmpty else { return }
        if !workspaces.contains(where: { VeloFormatting.canonicalWorkspacePath($0) == cleanNew }) {
            workspaces.append(cleanNew)
        }
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            let isIso = sessions[idx].isIsolatedWorktree
            sessions[idx].repoRoot = cleanNew
            if !isIso {
                sessions[idx].worktreePath = cleanNew
            }
            scheduleCacheSave()
        }
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["repo_path": cleanNew])
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "update_session",
                "session_id": sessionId,
                "repo_path": cleanNew,
            ])
        case .none:
            break
        }
    }


    public func updateSessionModelAndEffort(
        sessionId: String,
        modelOption: VeloModelOption,
        effort: String
    ) async {
        let hasEvents = !(eventsBySession[sessionId]?.isEmpty ?? true)
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].model = modelOption.id
            sessions[idx].modelShort = modelOption.shortLabel
            sessions[idx].effort = effort
            if !hasEvents && !modelOption.agentKind.isEmpty {
                sessions[idx].agentKind = modelOption.agentKind
            }
            scheduleCacheSave()
        }
        triggerHaptic(.light)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "model": modelOption.id,
                "effort": effort,
            ]
            if !hasEvents && !modelOption.agentKind.isEmpty {
                body["provider"] = modelOption.agentKind
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            _ = try? await URLSession.shared.data(for: req)

        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "update_session",
                "session_id": sessionId,
                "model": modelOption.id,
                "effort": effort,
            ]
            if !hasEvents && !modelOption.agentKind.isEmpty {
                payload["provider"] = modelOption.agentKind
            }
            sendEncryptedCommand(payload)

        case .none:
            break
        }
    }


    public func handoffSession(
        sourceSessionId: String,
        targetOption: VeloModelOption,
        effort: String,
        instructions: String? = nil
    ) async -> String? {
        let cleanInstructions = instructions?.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetProv = targetOption.agentKind.isEmpty ? "claude" : targetOption.agentKind
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sourceSessionId)/handoff") else { return nil }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = [
                "target_provider": targetProv,
                "model": targetOption.id,
                "effort": effort,
            ]
            if let cleanInstructions, !cleanInstructions.isEmpty {
                body["additional_instructions"] = cleanInstructions
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let created = VeloSessionItem.fromJSON(dict)
            {
                sessions.removeAll(where: { $0.id == created.id })
                sessions.insert(created, at: 0)
                activeSessionId = created.id
                latestCreatedOrHandoffSessionId = created.id
                if let cleanInstructions, !cleanInstructions.isEmpty {
                    let now = Date()
                    turnStartedAtBySession[created.id] = now
                    stepStartedAtBySession[created.id] = now
                    eventsBySession[created.id] = [
                        TimelineEventItem(
                            id: "u-ho-\(UUID().uuidString.prefix(6))",
                            sessionId: created.id,
                            timestamp: Self.shortTimeString(from: now),
                            content: cleanInstructions,
                            kind: .user(images: [])
                        )
                    ]
                } else {
                    eventsBySession[created.id] = []
                }
                Task { await loadEventsForSession(created.id) }
                scheduleCacheSave()
                return created.id
            }
            return nil

        case .e2eeRelay:
            var payload: [String: Any] = [
                "cmd": "handoff_session",
                "session_id": sourceSessionId,
                "target_provider": targetProv,
                "model": targetOption.id,
                "effort": effort,
            ]
            if let cleanInstructions, !cleanInstructions.isEmpty {
                payload["additional_instructions"] = cleanInstructions
            }
            pendingSelectNewestSession = true
            sendEncryptedCommand(payload)
            return nil

        case .none:
            return nil
        }
    }

    public func deleteSession(_ sessionId: String) async {
        triggerHaptic(.rigid)
        sessions.removeAll(where: { $0.id == sessionId })
        eventsBySession.removeValue(forKey: sessionId)
        if activeSessionId == sessionId {
            activeSessionId = sessions.first?.id
        }
        scheduleCacheSave()

        switch connectionConfig {
        case .direct(let baseURL):
            guard let url = URL(string: "\(baseURL)/api/sessions/\(sessionId)") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            _ = try? await URLSession.shared.data(for: req)
        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "delete_session",
                "session_id": sessionId,
            ])
        case .none:
            break
        }
    }


    public func stopSession(_ sessionId: String) async {
        triggerHaptic(.rigid)
        finalizeSessionTurnLocally(sessionId, finalLabel: "任务已停止")
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
        updateSessionStatus(sessionId, .running)
        VeloLiveActivityManager.shared.syncSessionActivity(
            session: sessions.first(where: { $0.id == sessionId }),
            sessionId: sessionId,
            phase: "thinking",
            headline: approve ? "已批准，继续执行…" : "已拒绝，等待回应…",
            startedAt: turnStartedAtBySession[sessionId],
            forceImmediate: true
        )
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


    @discardableResult
    public func requestMacCLILogin(provider: String) async -> Bool {
        let cleanProvider = provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "agy" : provider
        triggerHaptic(.medium)

        switch connectionConfig {
        case .direct(let baseURL):
            guard let encoded = cleanProvider.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                  let url = URL(string: "\(baseURL)/api/providers/\(encoded)/login")
            else { return false }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            if let (_, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse
            {
                return (200..<300).contains(http.statusCode)
            }
            return false

        case .e2eeRelay:
            sendEncryptedCommand([
                "cmd": "launch_cli_login",
                "provider": cleanProvider,
            ])
            return true

        case .none:
            return false
        }
    }

    /// Initiates or rotates X25519 Ephemeral Forward-Secrecy session key agreement & full state sync.
    private func sendEncryptedSync() {
        let eph = E2EERelayCrypto.generateEphemeralKeypair()
        self.ephemeralPrivateKey = eph.privateKey
        self.e2eeActiveKeyHex = nil
        self.isForwardSecretRatcheted = false
        var payload: [String: Any] = [
            "cmd": "sync",
            "client_ephemeral_pub": eph.publicHex,
        ]
        if let sid = activeSessionId, !sid.isEmpty {
            payload["active_session_id"] = sid
        }
        sendEncryptedCommand(payload)
    }

    private func enqueuePendingPayload(_ payload: [String: Any]) {
        let cmdName = payload["cmd"] as? String ?? ""
        guard cmdName != "sync" else { return }
        if cmdName == "get_events", let sid = payload["session_id"] as? String {
            pendingEncryptedPayloads.removeAll {
                ($0["cmd"] as? String) == "get_events" && ($0["session_id"] as? String) == sid
            }
        }
        if pendingEncryptedPayloads.count >= 24 {
            pendingEncryptedPayloads.removeFirst()
        }
        pendingEncryptedPayloads.append(payload)
    }

    private func sendEncryptedCommand(_ payload: [String: Any]) {
        guard case .e2eeRelay(_, _, let rootKeyHex) = connectionConfig else { return }
        let cmdName = payload["cmd"] as? String ?? ""
        if cmdName == "sync" {
            if wsTask == nil || wsTask?.state == .canceling || wsTask?.state == .completed {
                connect()
                return
            }
        } else if wsTask == nil || wsTask?.state != .running || !isConnected || !isForwardSecretRatcheted {
            enqueuePendingPayload(payload)
            if wsTask == nil || wsTask?.state != .running {
                connect()
            } else if !isForwardSecretRatcheted && ephemeralPrivateKey == nil {
                sendEncryptedSync()
            }
            return
        }
        guard let wsTask else { return }
        e2eeNonceCounter += 1
        let keyHex = (cmdName == "sync") ? rootKeyHex : (e2eeActiveKeyHex ?? rootKeyHex)
        guard let frameText = E2EERelayCrypto.sealJSON(
            sharedKeyHex: keyHex,
            senderId: clientSenderId,
            nonce: e2eeNonceCounter,
            payload: payload
        ) else { return }
        wsTask.send(.string(frameText)) { [weak self] err in
            if err != nil {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.isConnected = false
                    self.isForwardSecretRatcheted = false
                    if cmdName != "sync" {
                        self.enqueuePendingPayload(payload)
                    }
                    self.connect()
                }
            }
        }
    }

    // MARK: - Incoming WebSocket Payload Processing

    private func handleIncomingSocketText(_ rawText: String, config: ConnectionModeConfig) {
        switch config {
        case .direct:
            guard let data = rawText.data(using: .utf8),
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return }
            processServerPayload(json)

        case .e2eeRelay(_, _, let rootKeyHex):
            var openedViaRootFallback = false
            let opened: (senderId: String, nonce: UInt64, json: [String: Any])? = {
                if let activeKey = e2eeActiveKeyHex,
                   let res = E2EERelayCrypto.openFrame(sharedKeyHex: activeKey, rawFrameText: rawText)
                {
                    return res
                }
                if let res = E2EERelayCrypto.openFrame(sharedKeyHex: rootKeyHex, rawFrameText: rawText) {
                    openedViaRootFallback = (e2eeActiveKeyHex != nil)
                    return res
                }
                return nil
            }()

            guard let opened, opened.senderId == "daemon" else { return }

            let msgType = (opened.json["type"] as? String) ?? ""
            if openedViaRootFallback && msgType != "e2ee_ratchet" {
                // Daemon restarted and reset its session ratchet; accept snapshot and re-ratchet immediately
                e2eeActiveKeyHex = nil
                isForwardSecretRatcheted = false
                maxDaemonNonce = opened.nonce
                if msgType != "rekey_required" {
                    processServerPayload(opened.json)
                }
                sendEncryptedSync()
                return
            }

            if let prevNonce = maxDaemonNonce, opened.nonce <= prevNonce {
                return
            }
            maxDaemonNonce = opened.nonce
            processServerPayload(opened.json)
        }
    }

    private func processServerPayload(_ raw: [String: Any]) {
        if let type = raw["type"] as? String {
            if type == "rekey_required" {
                self.e2eeActiveKeyHex = nil
                self.isForwardSecretRatcheted = false
                self.sendEncryptedSync()
                return
            }

            if type == "e2ee_ratchet",
               let daemonPubHex = raw["daemon_ephemeral_pub"] as? String,
               let clientPriv = ephemeralPrivateKey,
               case .e2eeRelay(_, _, let rootKeyHex) = connectionConfig,
               let ratcheted = E2EERelayCrypto.deriveRatchetedKeyHex(
                   rootSharedKeyHex: rootKeyHex,
                   clientPrivateKey: clientPriv,
                   daemonPublicHex: daemonPubHex
               )
            {
                syncRetryTask?.cancel()
                syncRetryTask = nil
                self.e2eeActiveKeyHex = ratcheted
                self.isForwardSecretRatcheted = true
                if !pendingEncryptedPayloads.isEmpty {
                    let queued = pendingEncryptedPayloads
                    pendingEncryptedPayloads.removeAll()
                    for p in queued {
                        sendEncryptedCommand(p)
                    }
                }
                sendEncryptedCommand(["cmd": "get_quotas"])
                return
            }

            if type == "models_snapshot",
               let arr = raw["models"] as? [[String: Any]]
            {
                applyModelsArray(arr)
                return
            }

            if type == "workspaces_snapshot",
               let arr = raw["workspaces"] as? [String]
            {
                applyWorkspacesArray(arr)
                return
            }

            if type == "handoff_completed",
               let newSid = raw["new_session_id"] as? String, !newSid.isEmpty
            {
                pendingSelectNewestSession = false
                self.activeSessionId = newSid
                self.latestCreatedOrHandoffSessionId = newSid
                scheduleCacheSave()
                Task { await loadEventsForSession(newSid) }
                return
            }

            if type == "attachment_chunk",
               let reqKey = raw["request_id"] as? String
            {
                let notFound = (raw["not_found"] as? Bool) ?? false
                let total = (raw["total_chunks"] as? Int) ?? 0
                let idx = (raw["chunk_index"] as? Int) ?? 0
                let b64 = (raw["data_base64"] as? String) ?? ""
                if notFound || total <= 0 {
                    attachmentChunkBuffers.removeValue(forKey: reqKey)
                    if let waiters = attachmentDownloadWaiters.removeValue(forKey: reqKey) {
                        for w in waiters { w.resume(returning: nil) }
                    }
                    return
                }
                guard idx >= 0 && idx < total, let part = Data(base64Encoded: b64) else {
                    return
                }
                var buf = attachmentChunkBuffers[reqKey] ?? IncomingAttachmentBuffer(
                    chunks: Array(repeating: nil, count: total)
                )
                if buf.chunks.count != total {
                    buf.chunks = Array(repeating: nil, count: total)
                }
                buf.chunks[idx] = part
                if buf.chunks.allSatisfy({ $0 != nil }) {
                    var fullData = Data()
                    for c in buf.chunks {
                        if let c { fullData.append(c) }
                    }
                    attachmentChunkBuffers.removeValue(forKey: reqKey)
                    if let waiters = attachmentDownloadWaiters.removeValue(forKey: reqKey) {
                        for w in waiters { w.resume(returning: fullData) }
                    }
                } else {
                    attachmentChunkBuffers[reqKey] = buf
                }
                return
            }

            if type == "attachment_uploaded",
               let uploadId = raw["upload_id"] as? String
            {
                let ok = (raw["ok"] as? Bool) ?? false
                let path = raw["path"] as? String
                let url = (raw["url"] as? String) ?? ""
                if let waiter = attachmentUploadWaiters.removeValue(forKey: uploadId) {
                    if ok, let path, !path.isEmpty {
                        waiter.resume(returning: (path: path, url: url))
                    } else {
                        waiter.resume(returning: nil)
                    }
                }
                return
            }

            if type == "pong" {
                return
            }
        }

        if let kind = raw["kind"] as? String, kind == "sessions_snapshot",
           let rawArr = raw["sessions"] as? [[String: Any]]
        {
            let parsed = rawArr.compactMap(VeloSessionItem.fromJSON)
            self.sessions = parsed
            VeloLiveActivityManager.shared.reconcile(with: parsed)
            if pendingSelectNewestSession, let newest = parsed.first {
                pendingSelectNewestSession = false
                self.activeSessionId = newest.id
                self.latestCreatedOrHandoffSessionId = newest.id
                Task { await loadEventsForSession(newest.id) }
            } else if self.activeSessionId == nil || (!parsed.isEmpty && !parsed.contains(where: { $0.id == self.activeSessionId })),
                      let first = parsed.first
            {
                self.activeSessionId = first.id
                Task { await loadEventsForSession(first.id) }
            } else if let sid = self.activeSessionId, self.eventsBySession[sid] == nil {
                Task { await loadEventsForSession(sid) }
            }
            scheduleCacheSave()
            if !offlineOutbox.isEmpty {
                Task { await self.flushOfflineOutboxIfConnected() }
            }
            return
        }

        if let type = raw["type"] as? String, type == "events_snapshot",
           let sid = raw["session_id"] as? String,
           let rawEvs = raw["events"] as? [[String: Any]]
        {
            let sessionItem = sessions.first(where: { $0.id == sid })
            let fallbackProv = sessionItem?.agentKind ?? "agy"
            let (items, activeStart) = Self.reconstructEventsWithActiveTurn(
                sessionId: sid,
                rawList: rawEvs,
                fallbackProvider: fallbackProv
            )
            if !items.isEmpty || eventsBySession[sid] == nil {
                if !Self.hasStreamingTimelineItem(eventsBySession[sid] ?? []) {
                    eventsBySession[sid] = items
                    scheduleCacheSave()
                }
            }
            if sessionItem?.status == .running || sessionItem?.status == .waitingApproval,
               let activeStart
            {
                turnStartedAtBySession[sid] = activeStart
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

        if let type = raw["type"] as? String {
            switch type {
            case "git_action_result":
                let action = (raw["action"] as? String) ?? "git"
                let resObj = (raw["result"] as? [String: Any]) ?? [:]
                let ok = (resObj["ok"] as? Bool) ?? false
                lastActionBanner = ok ? "✅ Git \(action) 执行成功" : "⚠️ Git \(action) 未成功"
                return
            case "pr_snapshot":
                if let sid = raw["session_id"] as? String,
                   let dataObj = raw["data"] as? [String: Any]
                {
                    prBySession[sid] = VeloPrSnapshot.fromJSON(dataObj)
                }
                return
            case "usage_analytics_snapshot":
                if let aObj = raw["analytics"] as? [String: Any] {
                    usageAnalytics = VeloUsageAnalytics.fromJSON(aObj)
                }
                return
            case "search_results":
                if let arr = raw["hits"] as? [[String: Any]] {
                    globalSearchHits = arr.enumerated().compactMap {
                        VeloSearchHit.fromJSON($0.element, index: $0.offset)
                    }
                }
                return
            case "push_config_snapshot":
                if let cObj = raw["config"] as? [String: Any] {
                    pushConfig = VeloPushConfig.fromJSON(cObj)
                }
                return
            case "push_test_result":
                let resObj = (raw["result"] as? [String: Any]) ?? [:]
                let ok = (resObj["ok"] as? Bool) ?? false
                lastActionBanner = ok
                    ? "✅ 测试推送已送达，请查看锁屏通知"
                    : "⚠️ \((resObj["error"] as? String) ?? "推送未送达")"
                return
            case "automations_snapshot":
                if let arr = raw["automations"] as? [[String: Any]] {
                    automations = arr.compactMap(VeloAutomationItem.fromJSON)
                }
                return
            case "events_page":
                if let sid = raw["session_id"] as? String {
                    if (raw["unchanged"] as? Bool) == true {
                        return
                    }
                    let isIncremental = (raw["incremental"] as? Bool) ?? false
                    if let nSeq = VeloSessionItem.intValue(raw["newest_seq"]) {
                        let prevMeta = eventsMetaBySession[sid]
                        let cnt = VeloSessionItem.intValue(raw["event_count"]) ?? prevMeta?.eventCount ?? 0
                        let ts = VeloSessionItem.intValue(raw["latest_ts_ms"]) ?? prevMeta?.latestTsMs
                        eventsMetaBySession[sid] = (newestSeq: nSeq, eventCount: cnt, latestTsMs: ts)
                    }
                    if let rawEvs = raw["events"] as? [[String: Any]] {
                        if isIncremental {
                            let sessionItem = sessions.first(where: { $0.id == sid })
                            let prov = sessionItem?.agentKind ?? "claude"
                            let (parsed, _) = Self.reconstructEventsWithActiveTurn(
                                sessionId: sid,
                                rawList: rawEvs,
                                fallbackProvider: prov
                            )
                            if !parsed.isEmpty && !Self.hasStreamingTimelineItem(eventsBySession[sid] ?? []) {
                                let existing = eventsBySession[sid] ?? []
                                if let merged = Self.mergeIncrementalTimelineEvents(existing: existing, incoming: parsed) {
                                    eventsBySession[sid] = merged
                                    scheduleCacheSave()
                                }
                            }
                        } else {
                            mergeOlderEventsPage(
                                sessionId: sid,
                                rawEvents: rawEvs,
                                oldestSeq: VeloSessionItem.intValue(raw["oldest_seq"]),
                                hasMore: (raw["has_more"] as? Bool) ?? false
                            )
                        }
                    }
                }
                return
            case "cli_sessions_snapshot":
                if let arr = raw["sessions"] as? [[String: Any]] {
                    externalCliSessions = arr.compactMap(VeloExternalCliSessionItem.fromJSON)
                }
                if let hc = VeloSessionItem.intValue(raw["hidden_count"]) {
                    hiddenCliSessionsCount = hc
                }
                return
            case "cli_session_imported":
                if let sessDict = raw["session"] as? [String: Any],
                   let item = VeloSessionItem.fromJSON(sessDict)
                {
                    sessions.removeAll { $0.id == item.id }
                    sessions.insert(item, at: 0)
                    activeSessionId = item.id
                    latestImportedCliVeloId = item.id
                    Task { await loadEventsForSession(item.id) }
                }
                return
            case "session_forked", "ssh_session_started":
                if let sessDict = raw["session"] as? [String: Any],
                   let item = VeloSessionItem.fromJSON(sessDict)
                {
                    sessions.removeAll { $0.id == item.id }
                    sessions.insert(item, at: 0)
                    activeSessionId = item.id
                    latestCreatedOrHandoffSessionId = item.id
                    Task { await loadEventsForSession(item.id) }
                }
                return
            case "quotas_snapshot":
                if let arr = raw["providers"] as? [[String: Any]] {
                    quotaCards = arr.compactMap(VeloProviderQuotaCard.fromJSON)
                }
                return
            case "hosts_snapshot":
                if let arr = raw["hosts"] as? [[String: Any]] {
                    remoteHosts = arr.compactMap(VeloRemoteHostItem.fromJSON)
                }
                return
            case "checkpoints_snapshot":
                if let sid = raw["session_id"] as? String,
                   let arr = raw["checkpoints"] as? [[String: Any]]
                {
                    checkpointsBySession[sid] = arr.compactMap(VeloTurnCheckpointItem.fromJSON)
                }
                return
            case "checkpoint_rewound":
                let ok = (raw["ok"] as? Bool) ?? false
                if let sid = raw["session_id"] as? String {
                    if let arr = raw["checkpoints"] as? [[String: Any]] {
                        checkpointsBySession[sid] = arr.compactMap(VeloTurnCheckpointItem.fromJSON)
                    }
                    if ok {
                        Task { await fetchDiff(for: sid) }
                    }
                }
                lastActionBanner = ok
                    ? "✅ 已回滚至目标轮次快照（并自动留存备份）"
                    : "⚠️ \((raw["error"] as? String) ?? "检查点回滚失败")"
                return
            case "extensions_snapshot":
                if let arr = raw["mcp_servers"] as? [[String: Any]] {
                    mcpServers = arr.compactMap(VeloMcpServerItem.fromJSON)
                }
                if let arr = raw["skills"] as? [[String: Any]] {
                    installedSkills = arr.compactMap(VeloSkillItem.fromJSON)
                }
                return
            case "skill_content_result":
                if let reqId = raw["request_id"] as? String,
                   let waiter = skillContentWaiters.removeValue(forKey: reqId)
                {
                    let ok = (raw["ok"] as? Bool) ?? false
                    let content = ok ? (raw["content"] as? String) : nil
                    waiter.resume(returning: content)
                }
                return
            default:
                break
            }
        }

        let frameSeq: Int? = (raw["kind"] as? String) == "event"
            ? VeloSessionItem.intValue(raw["seq"])
            : nil
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

        if let frameSeq {
            let prevMeta = eventsMetaBySession[sid]
            if let prevNewest = prevMeta?.newestSeq,
               frameSeq <= prevNewest,
               evType != "status_changed",
               evType != "usage_updated"
            {
                return
            }
            if prevMeta == nil || frameSeq > (prevMeta?.newestSeq ?? -1) {
                let tsMs = Int((Self.parseServerDate(evObj["timestamp"]) ?? Date()).timeIntervalSince1970 * 1000)
                eventsMetaBySession[sid] = (
                    newestSeq: frameSeq,
                    eventCount: (prevMeta?.eventCount ?? 0) + 1,
                    latestTsMs: tsMs
                )
            }
        }

        if evType != "thinking_chunk" && evType != "message_chunk" {
            flushPendingStreamChunks(onlySessionId: sid)
        }

        let now = Date()
        let serverDate = Self.parseServerDate(evObj["timestamp"]) ?? now
        let nowLabel = Self.shortTimeString(from: serverDate)

        switch evType {
        case "mesh_invocation_updated":
            if let invDict = evObj["invocation"] as? [String: Any],
               let inv = VeloMeshInvocation.from(dict: invDict)
            {
                let itemId = "mesh-\(inv.id)"
                let nextItem = TimelineEventItem(
                    id: itemId,
                    sessionId: sid,
                    timestamp: nowLabel,
                    content: inv.prompt,
                    kind: .meshInvocation(inv)
                )
                var list = eventsBySession[sid] ?? []
                if let idx = list.firstIndex(where: { $0.id == itemId }) {
                    list[idx] = nextItem
                } else {
                    list.append(nextItem)
                }
                eventsBySession[sid] = list
            }

        case "user_message":
            let text = (evObj["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let imgs = (evObj["images"] as? [String]) ?? []
            let clientMsgId = (evObj["client_msg_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let sourceSessionId = (evObj["source_session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let sourceLabel = (evObj["source_label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty || !imgs.isEmpty else { return }
            if !sessions.contains(where: { $0.id == sid }) {
                Task { await refreshSessionsAndActiveEvents() }
            }
            // Authoritative turn reset: prevents accumulating elapsed time across turns!
            turnStartedAtBySession[sid] = serverDate
            stepStartedAtBySession[sid] = serverDate
            liveTpsBySession.removeValue(forKey: sid)
            streamStatsBySession.removeValue(forKey: sid)

            var list = eventsBySession[sid] ?? []
            let matchedIdx: Int? = {
                if let cid = clientMsgId, !cid.isEmpty {
                    if let idx = list.lastIndex(where: { item in
                        if case .user = item.kind { return item.clientMsgId == cid }
                        return false
                    }) {
                        return idx
                    }
                }
                let floor = max(0, list.count - 20)
                for idx in stride(from: list.count - 1, through: floor, by: -1) {
                    let item = list[idx]
                    guard item.id.hasPrefix("u-local-") || item.id.hasPrefix("u-init-") else { continue }
                    if case .user = item.kind {
                        if item.content.trimmingCharacters(in: .whitespacesAndNewlines) == text
                            || (text == "请查看附图" && item.content.isEmpty)
                        {
                            return idx
                        }
                    }
                }
                return nil
            }()
            if let localIdx = matchedIdx {
                list[localIdx].id = "u-sync-\(frameSeq.map(String.init) ?? String(UUID().uuidString.prefix(8)))"
                list[localIdx].timestamp = nowLabel
                if let cid = clientMsgId, !cid.isEmpty {
                    list[localIdx].clientMsgId = cid
                }
                if !imgs.isEmpty {
                    list[localIdx].kind = .user(images: imgs)
                }
                eventsBySession[sid] = list
            } else {
                list.append(
                    TimelineEventItem(
                        id: "u-ws-\(frameSeq.map(String.init) ?? String(UUID().uuidString.prefix(8)))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: text,
                        kind: .user(images: imgs),
                        clientMsgId: clientMsgId,
                        sourceSessionId: (sourceSessionId?.isEmpty == false) ? sourceSessionId : nil,
                        sourceLabel: (sourceLabel?.isEmpty == false) ? sourceLabel : nil
                    )
                )
                eventsBySession[sid] = list
            }

        case "permission_requested":
            markSessionUnreadIfBackground(sid)
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
            VeloLiveActivityManager.shared.syncSessionActivity(
                session: sessions.first(where: { $0.id == sid }),
                sessionId: sid,
                phase: "waiting",
                headline: "等待你批准 \(toolName)",
                target: String(preview.prefix(48)),
                startedAt: turnStartedAtBySession[sid],
                forceImmediate: true
            )
            notifyUser(title: "需要权限确认 · \(toolName)", body: preview)

        case "permission_resolved":
            pendingApprovals.removeValue(forKey: sid)

        case "user_question_requested":
            markSessionUnreadIfBackground(sid)
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
            VeloLiveActivityManager.shared.syncSessionActivity(
                session: sessions.first(where: { $0.id == sid }),
                sessionId: sid,
                phase: "waiting",
                headline: "等待你确认选项",
                target: String(question.prefix(48)),
                startedAt: turnStartedAtBySession[sid],
                forceImmediate: true
            )
            notifyUser(title: "Agent 等待你的回答", body: question)

        case "user_question_answered":
            pendingQuestions.removeValue(forKey: sid)

        case "status_changed":
            let st = ((evObj["status"] as? String) ?? "").lowercased()
            if st == "running" {
                let lastUserCompleted: Bool = {
                    guard let list = eventsBySession[sid],
                          let lastUser = list.last(where: {
                              if case .user = $0.kind { return true }
                              return false
                          })
                    else { return true }
                    return lastUser.durationMs != nil
                }()
                if turnStartedAtBySession[sid] == nil || lastUserCompleted {
                    turnStartedAtBySession[sid] = serverDate
                }
                if stepStartedAtBySession[sid] == nil || lastUserCompleted {
                    stepStartedAtBySession[sid] = turnStartedAtBySession[sid]
                }
                updateSessionStatus(sid, .running)
                VeloLiveActivityManager.shared.markTurnStarted(sessionId: sid)
                VeloLiveActivityManager.shared.syncSessionActivity(
                    session: sessions.first(where: { $0.id == sid }),
                    sessionId: sid,
                    phase: "thinking",
                    headline: "正在思考与执行…",
                    startedAt: turnStartedAtBySession[sid],
                    forceImmediate: true
                )
            } else if st == "completed" || st == "failed" || st == "stopped"
                || st == "idle" || st == "done" || st == "finished"
                || st == "cancelled" || st == "canceled"
            {
                let isFailed = (st == "failed")
                let isStopped = (st == "stopped" || st == "cancelled" || st == "canceled")
                let totalMs = finalizeSessionTurnLocally(
                    sid,
                    now: serverDate,
                    failed: isFailed,
                    finalLabel: isFailed ? "执行遇到异常" : (isStopped ? "任务已停止" : "任务已完成")
                )
                if st == "completed" || st == "failed" {
                    markSessionUnreadIfBackground(sid)
                }
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
            enqueueStreamChunk(
                sessionId: sid,
                isThinking: true,
                delta: delta,
                replace: replace,
                nowLabel: nowLabel,
                origin: origin
            )

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
            let rawArgsAny = evObj["arguments"]
            let argsObj = rawArgsAny as? [String: Any]
            let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: argsObj, output: nil)
            let extracted = VeloInlineDiffExtractor.extract(toolName: toolName, inputObj: rawArgsAny)
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
                    list[idx].inlineDiffOld = extracted.oldText ?? list[idx].inlineDiffOld
                    list[idx].inlineDiffNew = extracted.newText ?? list[idx].inlineDiffNew
                    list[idx].subagentRole = extracted.subagentRole ?? list[idx].subagentRole
                    list[idx].subagentPrompt = extracted.subagentPrompt ?? list[idx].subagentPrompt
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
                        ),
                        inlineDiffOld: extracted.oldText,
                        inlineDiffNew: extracted.newText,
                        subagentRole: extracted.subagentRole,
                        subagentPrompt: extracted.subagentPrompt
                    )
                )
            }
            eventsBySession[sid] = list
            VeloLiveActivityManager.shared.syncSessionActivity(
                session: sessions.first(where: { $0.id == sid }),
                sessionId: sid,
                phase: "tool",
                headline: pres.workingVerb,
                target: pres.summary.isEmpty ? nil : String(pres.summary.prefix(48)),
                startedAt: turnStartedAtBySession[sid],
                incrementStep: true,
                forceImmediate: true
            )

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

        case "usage_updated":
            let inTok = VeloSessionItem.intValue(evObj["input_tokens"]) ?? 0
            let outTok = VeloSessionItem.intValue(evObj["output_tokens"]) ?? 0
            let cacheRead = VeloSessionItem.intValue(evObj["cache_read_tokens"]) ?? 0
            let cacheWrite = VeloSessionItem.intValue(evObj["cache_write_tokens"]) ?? 0
            let ctxWin = VeloSessionItem.intValue(evObj["context_window"]) ?? 0
            let cost = VeloSessionItem.doubleValue(evObj["cost_usd"]) ?? 0.0
            let outTps = VeloSessionItem.doubleValue(evObj["output_tps"]) ?? 0.0

            if outTps >= 0.5 {
                liveTpsBySession[sid] = outTps
                if let sess = sessions.first(where: { $0.id == sid }),
                   sess.status == .running
                {
                    VeloLiveActivityManager.shared.syncSessionActivity(
                        session: sess,
                        sessionId: sid,
                        phase: "writing",
                        headline: "正在生成回复…",
                        startedAt: turnStartedAtBySession[sid],
                        tps: outTps
                    )
                }
            }

            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                if inTok > 0 { sessions[idx].inputTokens = inTok }
                if outTok > 0 { sessions[idx].outputTokens = max(sessions[idx].outputTokens, outTok) }
                if inTok + outTok > 0 { sessions[idx].tokensUsed = inTok + outTok }
                if cacheRead > 0 { sessions[idx].cacheReadTokens = cacheRead }
                if ctxWin > 0 { sessions[idx].contextWindow = ctxWin }
                if cost > 0 { sessions[idx].costUsd = max(sessions[idx].costUsd, cost) }
            }

            if var list = eventsBySession[sid],
               let lastUserIdx = list.lastIndex(where: {
                   if case .user = $0.kind { return true }
                   return false
               })
            {
                let prevTel = list[lastUserIdx].telemetry
                let resolvedTps: Double? = outTps >= 0.5 ? outTps : prevTel?.tps
                list[lastUserIdx].telemetry = TurnUsageTelemetry(
                    tps: resolvedTps,
                    inputTokens: inTok > 0 ? inTok : (prevTel?.inputTokens ?? 0),
                    outputTokens: outTok > 0 ? outTok : (prevTel?.outputTokens ?? 0),
                    cacheReadTokens: cacheRead > 0 ? cacheRead : (prevTel?.cacheReadTokens ?? 0),
                    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : (prevTel?.cacheWriteTokens ?? 0),
                    contextWindow: ctxWin > 0 ? ctxWin : (prevTel?.contextWindow ?? 0),
                    costUsd: cost > 0 ? cost : (prevTel?.costUsd ?? 0.0)
                )
                eventsBySession[sid] = list
            }

        case "message_chunk":
            let delta = (evObj["delta"] as? String) ?? ""
            let replace = (evObj["replace"] as? Bool) ?? false
            guard !delta.isEmpty else { return }
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? serverDate
            enqueueStreamChunk(
                sessionId: sid,
                isThinking: false,
                delta: delta,
                replace: replace,
                nowLabel: nowLabel,
                origin: origin
            )

        case "message_delta":
            let text = (evObj["text"] as? String) ?? ""
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !text.hasPrefix("[stderr]")
            else { return }
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now
            stepStartedAtBySession[sid] = now

            var list = eventsBySession[sid] ?? []
            let turnStart = list.lastIndex(where: {
                if case .user = $0.kind { return true }
                return false
            }).map { $0 + 1 } ?? 0
            if let streamingIdx = list.indices.reversed().first(where: { idx in
                idx >= turnStart && {
                    if case .assistant(true) = list[idx].kind { return true }
                    return false
                }()
            }) {
                list[streamingIdx].content = text
                list[streamingIdx].kind = .assistant(isStreaming: false)
                eventsBySession[sid] = list
                scheduleCacheSave()
                return
            }
            if let matchIdx = list.indices.reversed().first(where: { idx in
                guard idx >= turnStart, case .assistant = list[idx].kind else { return false }
                return Self.foldAssistantProjection(previous: list[idx].content, incoming: text) != "distinct"
            }) {
                let fold = Self.foldAssistantProjection(previous: list[matchIdx].content, incoming: text)
                if fold == "previous" {
                    return
                }
                let toolAfter = list.dropFirst(matchIdx + 1).contains { item in
                    if case .toolCall = item.kind { return true }
                    return false
                }
                if toolAfter {
                    list.remove(at: matchIdx)
                    list.append(
                        TimelineEventItem(
                            id: "as-\(UUID().uuidString.prefix(8))",
                            sessionId: sid,
                            timestamp: nowLabel,
                            content: text,
                            kind: .assistant(isStreaming: false)
                        )
                    )
                } else {
                    list[matchIdx].content = text
                    list[matchIdx].kind = .assistant(isStreaming: false)
                }
                eventsBySession[sid] = list
                scheduleCacheSave()
                return
            }
            var targetIdx: Int?
            for idx in list.indices.reversed() {
                if idx < turnStart { break }
                if case .toolCall = list[idx].kind { break }
                if case .assistant = list[idx].kind {
                    targetIdx = idx
                    break
                }
            }
            if let targetIdx, case .assistant = list[targetIdx].kind {
                let existing = list[targetIdx].content
                list[targetIdx].content = "\(existing)\n\n\(text)".trimmingCharacters(in: .whitespacesAndNewlines)
                list[targetIdx].kind = .assistant(isStreaming: false)
                eventsBySession[sid] = list
                scheduleCacheSave()
                return
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
            scheduleCacheSave()

        case "error":
            let rawErr = ((evObj["error"] as? String) ?? "Agent 执行异常").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rawErr.isEmpty else { return }
            let fallbackProv = sessions.first(where: { $0.id == sid })?.agentKind ?? "agy"
            let parsed = VeloFormatting.parseAgentError(rawErr, fallbackProvider: fallbackProv)
            let origin = stepStartedAtBySession[sid] ?? turnStartedAtBySession[sid] ?? now

            var list = eventsBySession[sid] ?? []
            for i in list.indices {
                switch list[i].kind {
                case .thinking(let startedAt, let dur, true):
                    let finalDur = dur ?? max(500, Int(now.timeIntervalSince(startedAt ?? origin) * 1000))
                    list[i].kind = .thinking(startedAt: startedAt, durationMs: finalDur, isStreaming: false)
                case .assistant(true):
                    list[i].kind = .assistant(isStreaming: false)
                default:
                    break
                }
            }

            if let lastIdx = list.indices.last,
               case .error(let prevAuth, _, _, _) = list[lastIdx].kind
            {
                // Keep richer auth-required card if followed by generic exit status error
                if !prevAuth && parsed.isAuthRequired {
                    list[lastIdx].content = parsed.message
                    list[lastIdx].kind = .error(
                        isAuthRequired: true,
                        provider: parsed.provider,
                        loginCommand: parsed.loginCommand,
                        authURL: parsed.authURL
                    )
                }
            } else {
                list.append(
                    TimelineEventItem(
                        id: "err-\(UUID().uuidString.prefix(8))",
                        sessionId: sid,
                        timestamp: nowLabel,
                        content: parsed.message,
                        kind: .error(
                            isAuthRequired: parsed.isAuthRequired,
                            provider: parsed.provider,
                            loginCommand: parsed.loginCommand,
                            authURL: parsed.authURL
                        )
                    )
                )
                triggerNotificationHaptic(.error)
                notifyUser(
                    title: parsed.isAuthRequired ? "CLI 认证已失效 · 请重新登录" : "CLI 执行异常",
                    body: parsed.message
                )
            }
            eventsBySession[sid] = list
            updateSessionStatus(sid, .idle)
            VeloLiveActivityManager.shared.endCurrent(
                sessionId: sid,
                finalLabel: parsed.isAuthRequired ? "需要重新登录" : "执行遇到异常",
                failed: true
            )
            if !sessions.contains(where: { $0.status == .running || $0.status == .waitingApproval }) {
                endBackgroundTaskIfNeeded()
            }
            scheduleCacheSave()

        default:
            break
        }
    }

    @discardableResult
    private func finalizeSessionTurnLocally(
        _ sid: String,
        now: Date = Date(),
        failed: Bool = false,
        finalLabel: String = "任务已完成"
    ) -> Int {
        let startOrigin = turnStartedAtBySession[sid] ?? now.addingTimeInterval(-1)
        let stepOrigin = stepStartedAtBySession[sid] ?? startOrigin
        let totalMs = max(500, Int(now.timeIntervalSince(startOrigin) * 1000))
        let nowLabel = Self.shortTimeString(from: now)
        let finalLiveTps = liveTpsBySession[sid]
        turnStartedAtBySession.removeValue(forKey: sid)
        stepStartedAtBySession.removeValue(forKey: sid)
        liveTpsBySession.removeValue(forKey: sid)
        streamStatsBySession.removeValue(forKey: sid)
        pendingApprovals.removeValue(forKey: sid)
        pendingQuestions.removeValue(forKey: sid)

        if var list = eventsBySession[sid] {
            if let lastUserIdx = list.lastIndex(where: {
                if case .user = $0.kind { return true }
                return false
            }) {
                if list[lastUserIdx].durationMs == nil {
                    list[lastUserIdx].durationMs = totalMs
                    list[lastUserIdx].completedAt = nowLabel
                }
                var tel = list[lastUserIdx].telemetry ?? TurnUsageTelemetry()
                if tel.tps == nil || (tel.tps ?? 0) < 0.5 {
                    if let finalLiveTps, finalLiveTps >= 0.5 {
                        tel.tps = finalLiveTps
                        list[lastUserIdx].telemetry = tel
                    }
                }
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
        VeloLiveActivityManager.shared.endCurrent(
            sessionId: sid,
            finalLabel: finalLabel,
            failed: failed
        )
        if !sessions.contains(where: { $0.status == .running || $0.status == .waitingApproval }) {
            endBackgroundTaskIfNeeded()
        }
        scheduleCacheSave()
        return totalMs
    }

    private func appendLocalErrorEvent(sessionId sid: String, rawError: String) {
        let clean = rawError.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let fallbackProv = sessions.first(where: { $0.id == sid })?.agentKind ?? "agy"
        let parsed = VeloFormatting.parseAgentError(clean, fallbackProvider: fallbackProv)
        var list = eventsBySession[sid] ?? []
        list.append(
            TimelineEventItem(
                id: "err-local-\(UUID().uuidString.prefix(8))",
                sessionId: sid,
                timestamp: Self.shortTimeString(from: Date()),
                content: parsed.message,
                kind: .error(
                    isAuthRequired: parsed.isAuthRequired,
                    provider: parsed.provider,
                    loginCommand: parsed.loginCommand,
                    authURL: parsed.authURL
                )
            )
        )
        eventsBySession[sid] = list
        triggerNotificationHaptic(.error)
    }

    private func updateSessionStatus(_ sid: String, _ status: SessionRunState) {
        if let idx = sessions.firstIndex(where: { $0.id == sid }) {
            sessions[idx].status = status
            sessions[idx].updatedAtLabel = "now"
        }
    }

    /// Same projected reply, not a second copy. "incoming" replaces the earlier
    /// sentence, "previous" means the saved text already covers this one.
    private static func foldAssistantProjection(previous: String, incoming: String) -> String {
        let prev = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
        if prev.isEmpty || next.isEmpty || prev.hasPrefix("⚠️") || next.hasPrefix("⚠️") {
            return "distinct"
        }
        if prev == next { return "previous" }
        if next.hasPrefix(prev), prev.count >= 24 { return "incoming" }
        if prev.hasPrefix(next), next.count >= 24 { return "previous" }
        if prev.count >= 40, next.contains(prev) { return "incoming" }
        if next.count >= 40, prev.contains(next) { return "previous" }
        return "distinct"
    }

    /// Idempotently merges newly fetched incremental events without duplicating optimistic user bubbles,
    /// active tool calls, or reasoning/assistant entries inside the current turn.
    private static func mergeIncrementalTimelineEvents(
        existing: [TimelineEventItem],
        incoming: [TimelineEventItem]
    ) -> [TimelineEventItem]? {
        guard !incoming.isEmpty else { return nil }
        var next = existing
        var mutated = false

        for item in incoming {
            switch item.kind {
            case .user:
                let trimmed = item.content.trimmingCharacters(in: .whitespacesAndNewlines)
                var matchedIdx: Int?
                if let cid = item.clientMsgId, !cid.isEmpty {
                    matchedIdx = next.lastIndex(where: { cur in
                        if case .user = cur.kind { return cur.clientMsgId == cid }
                        return false
                    })
                }
                if matchedIdx == nil {
                    let floor = max(0, next.count - 60)
                    for i in stride(from: next.count - 1, through: floor, by: -1) {
                        if case .user = next[i].kind,
                           next[i].content.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
                        {
                            matchedIdx = i
                            break
                        }
                    }
                }
                if let idx = matchedIdx {
                    next[idx].id = item.id
                    next[idx].timestamp = item.timestamp
                    if let cid = item.clientMsgId, !cid.isEmpty { next[idx].clientMsgId = cid }
                    if let d = item.durationMs { next[idx].durationMs = d }
                    if let c = item.completedAt { next[idx].completedAt = c }
                    if let t = item.telemetry { next[idx].telemetry = t }
                    mutated = true
                } else {
                    next.append(item)
                    mutated = true
                }

            case .toolCall:
                if let idx = next.firstIndex(where: { cur in
                    if case .toolCall = cur.kind { return cur.id == item.id }
                    return false
                }) {
                    next[idx] = item
                    mutated = true
                } else {
                    next.append(item)
                    mutated = true
                }

            case .thinking:
                let turnStart = (next.lastIndex(where: { if case .user = $0.kind { return true }; return false }) ?? -1) + 1
                let trimmed = item.content.trimmingCharacters(in: .whitespacesAndNewlines)
                let dup = next[turnStart...].contains { cur in
                    if case .thinking = cur.kind {
                        let ct = cur.content.trimmingCharacters(in: .whitespacesAndNewlines)
                        return ct == trimmed || ct.contains(trimmed)
                    }
                    return false
                }
                if !dup {
                    next.append(item)
                    mutated = true
                }

            case .assistant:
                let turnStart = (next.lastIndex(where: { if case .user = $0.kind { return true }; return false }) ?? -1) + 1
                var folded = false
                if turnStart < next.count {
                    for i in stride(from: next.count - 1, through: turnStart, by: -1) {
                        if case .assistant = next[i].kind {
                            let fold = foldAssistantProjection(previous: next[i].content, incoming: item.content)
                            if fold == "distinct" { continue }
                            folded = true
                            if fold == "incoming" {
                                next[i].content = item.content
                                mutated = true
                            }
                            break
                        }
                    }
                }
                if !folded {
                    next.append(item)
                    mutated = true
                }

            case .meshInvocation:
                if let idx = next.firstIndex(where: { $0.id == item.id }) {
                    if next[idx] != item {
                        next[idx] = item
                        mutated = true
                    }
                } else {
                    next.append(item)
                    mutated = true
                }

            case .error:
                let dup = next.last.map { cur in
                    if case .error = cur.kind { return cur.content == item.content }
                    return false
                } ?? false
                if !dup {
                    next.append(item)
                    mutated = true
                }
            }
        }
        return mutated ? next : nil
    }

    private static func hasStreamingTimelineItem(_ items: [TimelineEventItem]) -> Bool {
        items.contains { item in
            switch item.kind {
            case .assistant(let isStreaming):
                return isStreaming
            case .thinking(_, _, let isStreaming):
                return isStreaming
            default:
                return false
            }
        }
    }

    // MARK: - History Reconstruction (Matches Desktop `reconstructEventsFromHistory`)

    public static func reconstructEventsFromHistory(
        sessionId: String,
        rawList: [[String: Any]],
        fallbackProvider: String = "agy"
    ) -> [TimelineEventItem] {
        reconstructEventsWithActiveTurn(
            sessionId: sessionId,
            rawList: rawList,
            fallbackProvider: fallbackProvider
        ).items
    }

    public static func reconstructEventsWithActiveTurn(
        sessionId: String,
        rawList: [[String: Any]],
        fallbackProvider: String = "agy"
    ) -> (items: [TimelineEventItem], activeRunningStart: Date?) {
        var out: [TimelineEventItem] = []
        var activeUserIdx: Int?
        var activeStartMs: Int64 = 0
        var activeTurnClosed = false
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
            case "mesh_invocation_updated":
                if let invDict = ev["invocation"] as? [String: Any],
                   let inv = VeloMeshInvocation.from(dict: invDict)
                {
                    let itemId = "mesh-\(inv.id)"
                    let nextItem = TimelineEventItem(
                        id: itemId,
                        sessionId: sessionId,
                        timestamp: tsLabel,
                        content: inv.prompt,
                        kind: .meshInvocation(inv)
                    )
                    if let idx = out.firstIndex(where: { $0.id == itemId }) {
                        out[idx] = nextItem
                    } else {
                        out.append(nextItem)
                    }
                }

            case "user_message":
                let text = ((ev["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let imgs = (ev["images"] as? [String]) ?? []
                let cid = (ev["client_msg_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let srcSid = (ev["source_session_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let srcLabel = (ev["source_label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty || !imgs.isEmpty {
                    out.append(
                        TimelineEventItem(
                            id: (cid != nil && !cid!.isEmpty) ? "u-hist-\(cid!)" : "u-hist-\(i)",
                            sessionId: sessionId,
                            timestamp: tsLabel,
                            content: text,
                            kind: .user(images: imgs),
                            clientMsgId: (cid != nil && !cid!.isEmpty) ? cid : nil,
                            sourceSessionId: (srcSid != nil && !srcSid!.isEmpty) ? srcSid : nil,
                            sourceLabel: (srcLabel != nil && !srcLabel!.isEmpty) ? srcLabel : nil
                        )
                    )
                    activeUserIdx = out.count - 1
                    activeStartMs = tsMs
                    activeTurnClosed = false
                    lastStepMs = tsMs
                }

            case "status_changed":
                let st = ((ev["status"] as? String) ?? "").lowercased()
                if st == "running" {
                    if activeStartMs == 0, tsMs > 0 { activeStartMs = tsMs }
                    if lastStepMs == 0, tsMs > 0 { lastStepMs = tsMs }
                    activeTurnClosed = false
                } else if st == "completed" || st == "failed" || st == "stopped",
                          let uIdx = activeUserIdx
                {
                    if activeStartMs > 0, tsMs >= activeStartMs {
                        let dMs = max(500, Int(tsMs - activeStartMs))
                        out[uIdx].durationMs = dMs
                    }
                    out[uIdx].completedAt = tsLabel
                    activeTurnClosed = true
                }

            case "usage_updated":
                if let uIdx = activeUserIdx {
                    let inTok = VeloSessionItem.intValue(ev["input_tokens"]) ?? 0
                    let outTok = VeloSessionItem.intValue(ev["output_tokens"]) ?? 0
                    let cacheRead = VeloSessionItem.intValue(ev["cache_read_tokens"]) ?? 0
                    let cacheWrite = VeloSessionItem.intValue(ev["cache_write_tokens"]) ?? 0
                    let ctxWin = VeloSessionItem.intValue(ev["context_window"]) ?? 0
                    let cost = VeloSessionItem.doubleValue(ev["cost_usd"]) ?? 0.0
                    let outTps = VeloSessionItem.doubleValue(ev["output_tps"]) ?? 0.0
                    let prevTel = out[uIdx].telemetry
                    out[uIdx].telemetry = TurnUsageTelemetry(
                        tps: outTps >= 0.5 ? outTps : prevTel?.tps,
                        inputTokens: inTok > 0 ? inTok : (prevTel?.inputTokens ?? 0),
                        outputTokens: outTok > 0 ? outTok : (prevTel?.outputTokens ?? 0),
                        cacheReadTokens: cacheRead > 0 ? cacheRead : (prevTel?.cacheReadTokens ?? 0),
                        cacheWriteTokens: cacheWrite > 0 ? cacheWrite : (prevTel?.cacheWriteTokens ?? 0),
                        contextWindow: ctxWin > 0 ? ctxWin : (prevTel?.contextWindow ?? 0),
                        costUsd: cost > 0 ? cost : (prevTel?.costUsd ?? 0.0)
                    )
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
                let rawArgsAny = ev["arguments"]
                let argsObj = rawArgsAny as? [String: Any]
                let pres = VeloFormatting.presentTool(toolName: toolName, argsDict: argsObj, output: nil)
                let extracted = VeloInlineDiffExtractor.extract(toolName: toolName, inputObj: rawArgsAny)

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
                    out[existingIdx].inlineDiffOld = extracted.oldText ?? out[existingIdx].inlineDiffOld
                    out[existingIdx].inlineDiffNew = extracted.newText ?? out[existingIdx].inlineDiffNew
                    out[existingIdx].subagentRole = extracted.subagentRole ?? out[existingIdx].subagentRole
                    out[existingIdx].subagentPrompt = extracted.subagentPrompt ?? out[existingIdx].subagentPrompt
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
                            ),
                            inlineDiffOld: extracted.oldText,
                            inlineDiffNew: extracted.newText,
                            subagentRole: extracted.subagentRole,
                            subagentPrompt: extracted.subagentPrompt
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
                var folded = false
                let turnFloor = activeUserIdx ?? -1
                if let matchIdx = out.indices.reversed().first(where: { idx in
                    guard idx > turnFloor, case .assistant = out[idx].kind else { return false }
                    return Self.foldAssistantProjection(previous: out[idx].content, incoming: text) != "distinct"
                }) {
                    let fold = Self.foldAssistantProjection(previous: out[matchIdx].content, incoming: text)
                    folded = true
                    if fold == "incoming" {
                        let toolAfter = out.dropFirst(matchIdx + 1).contains { item in
                            if case .toolCall = item.kind { return true }
                            return false
                        }
                        if toolAfter {
                            out.remove(at: matchIdx)
                            folded = false
                        } else {
                            out[matchIdx].content = text
                        }
                    }
                }
                if folded { continue }
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
                let parsed = VeloFormatting.parseAgentError(errText, fallbackProvider: fallbackProvider)
                if let lastIdx = out.indices.last,
                   case .error(let prevAuth, _, _, _) = out[lastIdx].kind
                {
                    if !prevAuth && parsed.isAuthRequired {
                        out[lastIdx].content = parsed.message
                        out[lastIdx].kind = .error(
                            isAuthRequired: true,
                            provider: parsed.provider,
                            loginCommand: parsed.loginCommand,
                            authURL: parsed.authURL
                        )
                    }
                } else {
                    out.append(
                        TimelineEventItem(
                            id: "err-hist-\(i)",
                            sessionId: sessionId,
                            timestamp: tsLabel,
                            content: parsed.message,
                            kind: .error(
                                isAuthRequired: parsed.isAuthRequired,
                                provider: parsed.provider,
                                loginCommand: parsed.loginCommand,
                                authURL: parsed.authURL
                            )
                        )
                    )
                }

            default:
                break
            }
        }
        let runningStart: Date? = (!activeTurnClosed && activeStartMs > 0)
            ? Date(timeIntervalSince1970: Double(activeStartMs) / 1000.0)
            : nil
        return (out, runningStart)
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

    private static let isoFracFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlainFormatter: ISO8601DateFormatter = {
        ISO8601DateFormatter()
    }()

    private static let shortTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private static func parseServerDate(_ raw: Any?) -> Date? {
        guard let str = raw as? String, !str.isEmpty else { return nil }
        if let d = isoFracFormatter.date(from: str) { return d }
        return isoPlainFormatter.date(from: str)
    }

    private static func shortTimeString(from date: Date) -> String {
        shortTimeFormatter.string(from: date)
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
