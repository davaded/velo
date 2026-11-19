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
    #if canImport(ActivityKit)
    private var currentActivity: Activity<VeloSessionActivityAttributes>?
    #endif

    private init() {
        #if canImport(ActivityKit)
        // Adopt any already-running system Live Activity across app relaunches so no orphan pills linger
        if let existing = Activity<VeloSessionActivityAttributes>.activities.first {
            self.currentActivity = existing
            self.activeSessionId = existing.attributes.sessionId
            for extra in Activity<VeloSessionActivityAttributes>.activities.dropFirst() {
                Task { await extra.end(nil, dismissalPolicy: .immediate) }
            }
        }
        #endif
    }

    /// Reconciles any active or adopted Live Activity with the daemon's authoritative session list.
    /// Immediately dismisses stale/zombie Dynamic Island pills for sessions that finished while backgrounded.
    public func reconcile(with sessions: [VeloSessionItem]) {
        #if canImport(ActivityKit)
        let runningIds = Set(
            sessions
                .filter { $0.status == .running || $0.status == .waitingApproval }
                .map(\.id)
        )

        for act in Activity<VeloSessionActivityAttributes>.activities {
            let sid = act.attributes.sessionId
            let phase = act.content.state.phase
            if phase == .completed || phase == .failed {
                continue
            }
            if !runningIds.contains(sid) {
                stepCounterBySession.removeValue(forKey: sid)
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
                Task {
                    await act.end(
                        ActivityContent(state: endState, staleDate: nil),
                        dismissalPolicy: .immediate
                    )
                }
                if activeSessionId == sid {
                    currentActivity = nil
                    activeSessionId = nil
                }
            }
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

        // Never start/resurrect an active pill for a session that is already idle
        if let session,
           session.status == .idle,
           mappedPhase != .completed,
           mappedPhase != .failed
        {
            return
        }

        if incrementStep {
            stepCounterBySession[sessionId, default: 0] += 1
        }
        let steps = stepCounterBySession[sessionId] ?? 0

        let now = Date()
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

        // Clear stale throughput when starting a new turn or running non-writing steps
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

        if let existing = currentActivity,
           activeSessionId == sessionId,
           existing.activityState == .active
        {
            Task {
                await existing.update(
                    ActivityContent(state: state, staleDate: now.addingTimeInterval(900))
                )
            }
            return
        }

        // Clean up any OTHER session activities before requesting a new one (avoid race-killing our own new activity)
        let staleActivities = Activity<VeloSessionActivityAttributes>.activities
        for old in staleActivities {
            Task { await old.end(nil, dismissalPolicy: .immediate) }
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
            currentActivity = try Activity.request(
                attributes: attrs,
                content: ActivityContent(state: state, staleDate: now.addingTimeInterval(900)),
                pushType: nil
            )
            activeSessionId = sessionId
        } catch {
            currentActivity = nil
            activeSessionId = nil
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
        if let sessionId, let activeSessionId, sessionId != activeSessionId {
            return
        }
        if let sessionId {
            stepCounterBySession.removeValue(forKey: sessionId)
        }
        let targetAct: Activity<VeloSessionActivityAttributes>? = {
            if let currentActivity { return currentActivity }
            if let sessionId {
                return Activity<VeloSessionActivityAttributes>.activities.first(where: {
                    $0.attributes.sessionId == sessionId
                })
            }
            return Activity<VeloSessionActivityAttributes>.activities.first
        }()
        guard let act = targetAct else { return }
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
        Task {
            await act.end(
                ActivityContent(state: endState, staleDate: nil),
                dismissalPolicy: .after(.now + 12)
            )
        }
        currentActivity = nil
        activeSessionId = nil
        #endif
    }
}
