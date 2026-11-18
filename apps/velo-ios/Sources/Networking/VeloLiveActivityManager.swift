import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

@MainActor
public final class VeloLiveActivityManager {
    public static let shared = VeloLiveActivityManager()
    private var activeSessionId: String?
    #if canImport(ActivityKit)
    private var currentActivity: Activity<VeloSessionActivityAttributes>?
    #endif

    private init() {}

    public func startOrUpdate(
        sessionId: String,
        title: String,
        engineBadge: String,
        statusLabel: String,
        tps: Double?,
        startedAt: Date?
    ) {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let elapsed = max(0, Int(Date().timeIntervalSince(startedAt ?? Date())))
        let state = VeloSessionActivityAttributes.ContentState(
            statusLabel: statusLabel,
            throughputTps: tps,
            elapsedSeconds: elapsed
        )

        if let existing = currentActivity, activeSessionId == sessionId {
            Task {
                await existing.update(ActivityContent(state: state, staleDate: nil))
            }
            return
        }

        endCurrent()
        let attrs = VeloSessionActivityAttributes(
            sessionId: sessionId,
            sessionTitle: title,
            engineBadge: engineBadge
        )
        do {
            currentActivity = try Activity.request(
                attributes: attrs,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            activeSessionId = sessionId
        } catch {
            currentActivity = nil
            activeSessionId = nil
        }
        #endif
    }

    public func endCurrent(sessionId: String? = nil, finalLabel: String = "已完成") {
        #if canImport(ActivityKit)
        if let sessionId, let activeSessionId, sessionId != activeSessionId {
            return
        }
        guard let act = currentActivity else { return }
        let endState = VeloSessionActivityAttributes.ContentState(
            statusLabel: finalLabel,
            throughputTps: nil,
            elapsedSeconds: act.content.state.elapsedSeconds
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
