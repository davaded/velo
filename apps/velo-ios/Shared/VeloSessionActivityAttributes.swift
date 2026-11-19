import Foundation
#if canImport(ActivityKit)
import ActivityKit

public struct VeloSessionActivityAttributes: ActivityAttributes {
    public enum PhaseKind: String, Codable, Hashable, Sendable {
        case thinking
        case tool
        case writing
        case waitingApproval
        case pausedSync
        case completed
        case failed
    }

    public struct ContentState: Codable, Hashable {
        public var phase: PhaseKind
        /// Short headline for the current step (e.g. "正在编辑 VeloStore.swift", "执行 cargo test", "需要你批准执行权限")
        public var stepHeadline: String
        /// Optional monospace target/detail (e.g. "ChatThreadView.swift" or "$ pnpm run build")
        public var stepTarget: String?
        /// Authoritative turn start timestamp used by iOS `Text(timerInterval:)` for 0-CPU live ticking!
        public var startedAt: Date
        /// Set when completed/failed so the timer freezes cleanly at the exact final duration
        public var finishedElapsedSeconds: Int?
        public var stepCount: Int
        public var throughputTps: Double?
        public var insertions: Int
        public var deletions: Int

        public init(
            phase: PhaseKind,
            stepHeadline: String,
            stepTarget: String? = nil,
            startedAt: Date,
            finishedElapsedSeconds: Int? = nil,
            stepCount: Int = 0,
            throughputTps: Double? = nil,
            insertions: Int = 0,
            deletions: Int = 0
        ) {
            self.phase = phase
            self.stepHeadline = stepHeadline
            self.stepTarget = stepTarget
            self.startedAt = startedAt
            self.finishedElapsedSeconds = finishedElapsedSeconds
            self.stepCount = stepCount
            self.throughputTps = throughputTps
            self.insertions = insertions
            self.deletions = deletions
        }
    }

    public var sessionId: String
    public var sessionTitle: String
    public var projectName: String
    public var branchName: String
    public var engineBadge: String

    public init(
        sessionId: String,
        sessionTitle: String,
        projectName: String,
        branchName: String,
        engineBadge: String
    ) {
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.projectName = projectName
        self.branchName = branchName
        self.engineBadge = engineBadge
    }
}
#endif
