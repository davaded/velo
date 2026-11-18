import Foundation
#if canImport(ActivityKit)
import ActivityKit

public struct VeloSessionActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var statusLabel: String
        public var throughputTps: Double?
        public var elapsedSeconds: Int

        public init(statusLabel: String, throughputTps: Double?, elapsedSeconds: Int) {
            self.statusLabel = statusLabel
            self.throughputTps = throughputTps
            self.elapsedSeconds = elapsedSeconds
        }
    }

    public var sessionId: String
    public var sessionTitle: String
    public var engineBadge: String

    public init(sessionId: String, sessionTitle: String, engineBadge: String) {
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.engineBadge = engineBadge
    }
}
#endif
