import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

@MainActor
public final class VeloLiveActivityManager {
    public static let shared = VeloLiveActivityManager()
    private var activeSessionId: String?
    private var lastUpdateAt: Date = .distantPast
    private var stepCounterBySession: [String: Int] = [:]
    /// Prevents straggling out-of-order `usage_updated` / `message_chunk` frames from resurrecting a just-ended pill
    private var endedCooldownBySession: [String: Date] = [:]
    /// Strictly serializes all ActivityKit `request` / `update` / `end` calls so an earlier `update("正在生成回复…")`
    /// can NEVER race and overwrite a subsequent `end("任务已完成")`!
    private var serialOp: Task<Void, Never>?
    /// Heartbeat keeps `staleDate` (+25s) fresh ONLY while the app is actively connected & running;
    /// if iOS suspends or kills the app, `context.isStale` flips automatically after 25s!
    private var heartbeatTask: Task<Void, Never>?
    private var latestActiveState: VeloSessionActivityAttributes.ContentState?

    #if canImport(ActivityKit)
    private var currentActivity: Activity<VeloSessionActivityAttributes>?
    #endif

    private init() {
        #if canImport(ActivityKit)
        // Adopt any already-running system Live Activity across app relaunches so no orphan pills linger
        if let existing = Activity<VeloSessionActivityAttributes>.activities.first {
            self.currentActivity = existing
            self.activeSessionId = existing.attributes.sessionId
            self.latestActiveState = existing.content.state
            for extra in Activity<VeloSessionActivityAttributes>.activities.dropFirst() {
                enqueueOp {
                    await extra.end(nil, dismissalPolicy: .immediate)
                }
            }
        }
        #endif
    }

    public var hasActiveLiveActivity: Bool {
        #if canImport(ActivityKit)
        if let currentActivity, currentActivity.activityState == .active {
            return true
        }
        return Activity<VeloSessionActivityAttributes>.activities.contains {
            $0.activityState == .active
                && $0.content.state.phase != .completed
                && $0.content.state.phase != .failed
        }
        #else
        return false
        #endif
    }

    /// Explicitly clears end-cooldown when the user starts a brand-new turn on this session.
    public func markTurnStarted(sessionId: String) {
        endedCooldownBySession.removeValue(forKey: sessionId)
    }

    private func enqueueOp(_ block: @escaping @Sendable () async -> Void) {
        let prev = serialOp
        serialOp = Task {
            await prev?.value
            await block()
        }
    }

    private func restartHeartbeat() {
        heartbeatTask?.cancel()
        #if canImport(ActivityKit)
        guard let act = currentActivity, activeSessionId != nil else { return }
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                guard let self,
                      let liveAct = self.currentActivity,
                      liveAct.id == act.id,
                      liveAct.activityState == .active,
                      let state = self.latestActiveState,
                      state.phase != .completed,
                      state.phase != .failed,
                      state.phase != .pausedSync
                else {
                    break
                }
                let nextStale = Date().addingTimeInterval(25)
                self.enqueueOp {
                    await liveAct.update(ActivityContent(state: state, staleDate: nextStale))
                }
            }
        }
        #endif
    }

    private func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    /// Called right before iOS suspends our background execution window (~28s after locking screen)
    /// so the Lock Screen truthfully switches to "后台连接已休眠 · 轻点查看最新状态" instead of
    /// falsely displaying "正在生成回复…" after the agent has already finished!
    public func markBackgroundSuspended() {
        #if canImport(ActivityKit)
        stopHeartbeat()
        let activeList = Activity<VeloSessionActivityAttributes>.activities.filter {
            $0.activityState == .active
                && $0.content.state.phase != .completed
                && $0.content.state.phase != .failed
                && $0.content.state.phase != .waitingApproval
        }
        guard !activeList.isEmpty else { return }
        for act in activeList {
            let prev = act.content.state
            let elapsedSec = max(1, Int(Date().timeIntervalSince(prev.startedAt)))
            let pausedState = VeloSessionActivityAttributes.ContentState(
                phase: .pausedSync,
                stepHeadline: "后台连接已休眠 · 轻点查看最新状态",
                stepTarget: nil,
                startedAt: prev.startedAt,
                finishedElapsedSeconds: elapsedSec,
                stepCount: prev.stepCount,
                throughputTps: nil,
                insertions: prev.insertions,
                deletions: prev.deletions
            )
            if currentActivity?.id == act.id {
                latestActiveState = pausedState
            }
            enqueueOp {
                await act.update(ActivityContent(state: pausedState, staleDate: nil))
            }
        }
        #endif
    }

    /// Reconciles any active or adopted Live Activity with the daemon's authoritative session list.
    /// Immediately ends stale/zombie Dynamic Island pills for sessions that finished while locked/backgrounded.
    public func reconcile(with sessions: [VeloSessionItem]) {
        #if canImport(ActivityKit)
        let runningIds = Set(
            sessions
                .filter { $0.status == .running || $0.status == .waitingApproval }
                .map(\.id)
        )

        var stillHasRunning = false
        for act in Activity<VeloSessionActivityAttributes>.activities {
            let sid = act.attributes.sessionId
            let phase = act.content.state.phase
            if phase == .completed || phase == .failed {
                continue
            }
            if !runningIds.contains(sid) {
                stepCounterBySession.removeValue(forKey: sid)
                endedCooldownBySession[sid] = Date()
                let prev = act.content.state
                let elapsedSec = max(1, Int(Date().timeIntervalSince(prev.startedAt)))
                let endState = VeloSessionActivityAttributes.ContentState(
                    phase: .completed,
                    stepHeadline: "任务已完成",
                    stepTarget: nil,
                    startedAt: prev.startedAt,
                    finishedElapsedSeconds: elapsedSec,
                    stepCount: prev.stepCount,
                    throughputTps: nil,
                    insertions: prev.insertions,
                    deletions: prev.deletions
                )
                enqueueOp {
                    await act.end(
                        ActivityContent(state: endState, staleDate: nil),
                        dismissalPolicy: .immediate
                    )
                }
                if activeSessionId == sid || currentActivity?.id == act.id {
                    currentActivity = nil
                    activeSessionId = nil
                    latestActiveState = nil
                }
            } else {
                stillHasRunning = true
                // If we woke up from pausedSync and the session IS still genuinely running, restore active state!
                if phase == .pausedSync, let sess = sessions.first(where: { $0.id == sid }) {
                    let prev = act.content.state
                    let resumed = VeloSessionActivityAttributes.ContentState(
                        phase: sess.status == .waitingApproval ? .waitingApproval : .thinking,
                        stepHeadline: sess.status == .waitingApproval ? "等待你批准执行" : "仍在执行中…",
                        stepTarget: nil,
                        startedAt: prev.startedAt,
                        finishedElapsedSeconds: nil,
                        stepCount: prev.stepCount,
                        throughputTps: nil,
                        insertions: sess.insertions,
                        deletions: sess.deletions
                    )
                    latestActiveState = resumed
                    let stale = Date().addingTimeInterval(25)
                    enqueueOp {
                        await act.update(ActivityContent(state: resumed, staleDate: stale))
                    }
                    restartHeartbeat()
                }
            }
        }
        if !stillHasRunning {
            stopHeartbeat()
        }
        #endif
    }

    public func syncSessionActivity(
        session: VeloSessionItem?,
        sessionId: String,
        phase: String,
        headline: String,
        target: String? = nil,
        startedAt: Date? = nil,
        tps: Double? = nil,
        incrementStep: Bool = false,
        forceImmediate: Bool = false
    ) {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let mappedPhase: VeloSessionActivityAttributes.PhaseKind = {
            switch phase {
            case "waiting": return .waitingApproval
            case "tool": return .tool
            case "writing": return .writing
            case "completed": return .completed
            case "failed": return .failed
            default: return .thinking
            }
        }()

        // Never start or resurrect an active pill for an idle session
        if let session,
           session.status == .idle,
           mappedPhase != .completed,
           mappedPhase != .failed
        {
            return
        }

        let now = Date()
        // Ignore straggling out-of-order telemetry frames within 3s of a turn ending
        if let endedAt = endedCooldownBySession[sessionId],
           now.timeIntervalSince(endedAt) < 3.0,
           mappedPhase != .waitingApproval
        {
            return
        }

        if incrementStep {
            stepCounterBySession[sessionId, default: 0] += 1
        }
        let steps = stepCounterBySession[sessionId] ?? 0

        if !forceImmediate,
           mappedPhase != .waitingApproval,
           mappedPhase != .completed,
           mappedPhase != .failed,
           activeSessionId == sessionId,
           currentActivity != nil,
           now.timeIntervalSince(lastUpdateAt) < 0.95
        {
            return
        }
        lastUpdateAt = now

        let originDate: Date = {
            if let explicit = startedAt {
                return explicit
            }
            if activeSessionId == sessionId, let prev = currentActivity?.content.state.startedAt {
                return prev
            }
            return now
        }()

        let resolvedTps: Double? = {
            if mappedPhase == .writing {
                return tps ?? currentActivity?.content.state.throughputTps
            }
            return nil
        }()

        let state = VeloSessionActivityAttributes.ContentState(
            phase: mappedPhase,
            stepHeadline: headline,
            stepTarget: target,
            startedAt: originDate,
            finishedElapsedSeconds: nil,
            stepCount: steps,
            throughputTps: resolvedTps,
            insertions: session?.insertions ?? currentActivity?.content.state.insertions ?? 0,
            deletions: session?.deletions ?? currentActivity?.content.state.deletions ?? 0
        )

        // Waiting approval does not expire stale as aggressively (user may take a minute to unlock)
        let staleDate = mappedPhase == .waitingApproval
            ? now.addingTimeInterval(300)
            : now.addingTimeInterval(25)

        if let existing = currentActivity,
           activeSessionId == sessionId,
           existing.activityState == .active
        {
            latestActiveState = state
            enqueueOp {
                await existing.update(ActivityContent(state: state, staleDate: staleDate))
            }
            restartHeartbeat()
            return
        }

        // End any stale activities from OTHER sessions before starting a fresh one
        let staleActivities = Activity<VeloSessionActivityAttributes>.activities
        for old in staleActivities {
            enqueueOp {
                await old.end(nil, dismissalPolicy: .immediate)
            }
        }

        let title = session?.title ?? "Velo 任务执行中"
        let proj = session?.projectName ?? "workspace"
        let branch = session?.branchName ?? "main"
        let badge = session?.engineCategory.shortBadge ?? "Claude"

        let attrs = VeloSessionActivityAttributes(
            sessionId: sessionId,
            sessionTitle: title,
            projectName: proj,
            branchName: branch,
            engineBadge: badge
        )
        do {
            let created = try Activity.request(
                attributes: attrs,
                content: ActivityContent(state: state, staleDate: staleDate),
                pushType: nil
            )
            currentActivity = created
            activeSessionId = sessionId
            latestActiveState = state
            restartHeartbeat()
        } catch {
            currentActivity = nil
            activeSessionId = nil
            latestActiveState = nil
            stopHeartbeat()
        }
        #endif
    }

    /// Backwards-compatible wrapper
    public func startOrUpdate(
        sessionId: String,
        title: String,
        engineBadge: String,
        statusLabel: String,
        tps: Double?,
        startedAt: Date?
    ) {
        let inferredPhase: String = {
            if statusLabel.contains("审") || statusLabel.contains("确认") { return "waiting" }
            if tps != nil { return "writing" }
            return "thinking"
        }()
        syncSessionActivity(
            session: nil,
            sessionId: sessionId,
            phase: inferredPhase,
            headline: statusLabel,
            startedAt: startedAt,
            tps: tps
        )
    }

    public func endCurrent(
        sessionId: String? = nil,
        finalLabel: String = "任务已完成",
        failed: Bool = false
    ) {
        #if canImport(ActivityKit)
        if let sessionId {
            stepCounterBySession.removeValue(forKey: sessionId)
            endedCooldownBySession[sessionId] = Date()
        }

        // Collect every matching active Live Activity so no orphaned duplicate can remain stuck on Lock Screen
        var targets: [Activity<VeloSessionActivityAttributes>] = []
        for act in Activity<VeloSessionActivityAttributes>.activities {
            if let sessionId {
                if act.attributes.sessionId == sessionId {
                    targets.append(act)
                }
            } else {
                targets.append(act)
            }
        }
        if let cur = currentActivity,
           (sessionId == nil || cur.attributes.sessionId == sessionId),
           !targets.contains(where: { $0.id == cur.id })
        {
            targets.append(cur)
        }

        if sessionId == nil || activeSessionId == sessionId {
            currentActivity = nil
            activeSessionId = nil
            latestActiveState = nil
            stopHeartbeat()
        }

        guard !targets.isEmpty else { return }
        for act in targets {
            let prev = act.content.state
            let elapsedSec = max(1, Int(Date().timeIntervalSince(prev.startedAt)))
            let endState = VeloSessionActivityAttributes.ContentState(
                phase: failed ? .failed : .completed,
                stepHeadline: finalLabel,
                stepTarget: nil,
                startedAt: prev.startedAt,
                finishedElapsedSeconds: elapsedSec,
                stepCount: prev.stepCount,
                throughputTps: nil,
                insertions: prev.insertions,
                deletions: prev.deletions
            )
            enqueueOp {
                await act.end(
                    ActivityContent(state: endState, staleDate: nil),
                    dismissalPolicy: .after(.now + 12)
                )
            }
        }
        #endif
    }
}
