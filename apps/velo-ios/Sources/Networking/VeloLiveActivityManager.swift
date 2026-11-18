import Foundation
#if canImport(ActivityKit)
import ActivityKit

public struct VeloSessionActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var statusLabel: String
        public var throughputTps: Double?
        public var elapsedSeconds: Int
    }

    public var sessionId: String
    public var sessionTitle: String
    public var engineBadge: String
}
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
            // Silently ignore on devices/entitlements without widget extension
        }
        #endif
    }

    public func endCurrent(sessionId: String? = nil) {
        #if canImport(ActivityKit)
        if let sid = sessionId, let cur = activeSessionId, cur != sid {
            return
        }
        if let existing = currentActivity {
            let finalState = VeloSessionActivityAttributes.ContentState(
                statusLabel: "已完成",
                throughputTps: nil,
                elapsedSeconds: 0
            )
            Task {
                await existing.end(
                    ActivityContent(state: finalState, staleDate: nil),
                    dismissalPolicy: .default
                )
            }
        }
        currentActivity = nil
        activeSessionId = nil
        #endif
    }
}
