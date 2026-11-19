import ActivityKit
import SwiftUI
import WidgetKit

@main
struct VeloLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        VeloSessionLiveActivity()
    }
}

struct VeloSessionLiveActivity: Widget {
    private let violet = Color(red: 0.65, green: 0.55, blue: 0.98)
    private let terracotta = Color(red: 0.96, green: 0.54, blue: 0.32)
    private let emerald = Color(red: 0.20, green: 0.83, blue: 0.60)
    private let amber = Color(red: 0.98, green: 0.75, blue: 0.14)
    private let coral = Color(red: 0.97, green: 0.44, blue: 0.44)

    private func engineAccent(_ badge: String) -> Color {
        let lower = badge.lowercased()
        if lower.contains("claude") { return terracotta }
        if lower.contains("codex") { return emerald }
        return violet
    }

    private func engineIcon(_ badge: String) -> String {
        let lower = badge.lowercased()
        if lower.contains("claude") { return "sparkles" }
        if lower.contains("codex") { return "terminal.fill" }
        return "cpu"
    }

    private func phaseColor(
        _ phase: VeloSessionActivityAttributes.PhaseKind,
        badge: String
    ) -> Color {
        switch phase {
        case .waitingApproval: return amber
        case .completed: return emerald
        case .failed: return coral
        case .thinking: return violet
        case .tool, .writing: return engineAccent(badge)
        }
    }

    private func phaseIcon(
        _ phase: VeloSessionActivityAttributes.PhaseKind,
        badge: String
    ) -> String {
        switch phase {
        case .waitingApproval: return "exclamationmark.shield.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .thinking: return "brain.head.profile"
        case .tool: return "hammer.fill"
        case .writing: return engineIcon(badge)
        }
    }

    @ViewBuilder
    private func liveClockView(state: VeloSessionActivityAttributes.ContentState, fontSize: CGFloat) -> some View {
        if let doneSec = state.finishedElapsedSeconds {
            Text(formatDuration(doneSec))
                .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                .monospacedDigit()
        } else {
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
    }

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VeloSessionActivityAttributes.self) { context in
            // Lock Screen & Notification Banner View
            let accent = phaseColor(context.state.phase, badge: context.attributes.engineBadge)
            let brandColor = engineAccent(context.attributes.engineBadge)

            VStack(alignment: .leading, spacing: 10) {
                // Row 1: Engine Pill + Project/Title + Live Ticking Clock
                HStack(spacing: 7) {
                    HStack(spacing: 4) {
                        Image(systemName: engineIcon(context.attributes.engineBadge))
                            .font(.system(size: 10, weight: .bold))
                        Text(context.attributes.engineBadge)
                            .font(.system(size: 11, weight: .bold))
                    }
                    .foregroundStyle(brandColor)
                    .padding(.horizontal, 7.5)
                    .padding(.vertical, 3)
                    .background(brandColor.opacity(0.18), in: Capsule())

                    Text(context.attributes.sessionTitle)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Spacer(minLength: 6)

                    liveClockView(state: context.state, fontSize: 12.5)
                        .foregroundStyle(.white.opacity(0.82))
                }

                // Row 2: Live Phase / Current Tool Step + Throughput / Diff Telemetry
                HStack(spacing: 7) {
                    Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(accent)

                    Text(context.state.stepHeadline)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.92))
                        .lineLimit(1)

                    if let target = context.state.stepTarget, !target.isEmpty {
                        Text(target)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.55))
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    if let tps = context.state.throughputTps, tps >= 0.5 {
                        Text(formatTps(tps))
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(emerald)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(emerald.opacity(0.15), in: Capsule())
                    } else if context.state.insertions > 0 || context.state.deletions > 0 {
                        HStack(spacing: 3) {
                            Text("+\(context.state.insertions)")
                                .foregroundStyle(emerald)
                            Text("−\(context.state.deletions)")
                                .foregroundStyle(coral)
                        }
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .activityBackgroundTint(Color(red: 0.06, green: 0.065, blue: 0.09).opacity(0.95))
            .activitySystemActionForegroundColor(.white)
            .widgetURL(URL(string: "velo://session/\(context.attributes.sessionId)"))

        } dynamicIsland: { context in
            let accent = phaseColor(context.state.phase, badge: context.attributes.engineBadge)
            let brandColor = engineAccent(context.attributes.engineBadge)

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        ZStack {
                            Circle()
                                .fill(brandColor.opacity(0.20))
                                .frame(width: 22, height: 22)
                            Image(systemName: engineIcon(context.attributes.engineBadge))
                                .font(.system(size: 10.5, weight: .bold))
                                .foregroundStyle(brandColor)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(context.attributes.engineBadge)
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white)
                            Text("\(context.attributes.projectName) · \(context.attributes.branchName)")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.58))
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        liveClockView(state: context.state, fontSize: 13)
                            .foregroundStyle(.white)

                        if let tps = context.state.throughputTps, tps >= 0.5 {
                            Text("⚡ \(shortTps(tps))")
                                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(emerald)
                        } else if context.state.stepCount > 0 {
                            Text("第 \(context.state.stepCount) 步")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.55))
                        }
                    }
                    .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(context.attributes.sessionTitle)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.92))
                            .lineLimit(1)

                        HStack(spacing: 7) {
                            Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(accent)

                            Text(context.state.stepHeadline)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(
                                    context.state.phase == .waitingApproval ? amber : .white.opacity(0.85)
                                )
                                .lineLimit(1)

                            if let target = context.state.stepTarget, !target.isEmpty {
                                Text(target)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.5))
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 4)

                            if context.state.insertions > 0 || context.state.deletions > 0 {
                                HStack(spacing: 3) {
                                    Text("+\(context.state.insertions)")
                                        .foregroundStyle(emerald)
                                    Text("−\(context.state.deletions)")
                                        .foregroundStyle(coral)
                                }
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
            } compactLeading: {
                HStack(spacing: 5) {
                    ZStack {
                        Circle()
                            .fill(accent.opacity(0.22))
                            .frame(width: 18, height: 18)
                        Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundStyle(accent)
                    }
                    Text(context.attributes.projectName)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .frame(maxWidth: 56, alignment: .leading)
                }
            } compactTrailing: {
                switch context.state.phase {
                case .waitingApproval:
                    Text("待审批")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(amber)
                case .completed:
                    HStack(spacing: 2.5) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9.5, weight: .bold))
                        Text("完成")
                            .font(.system(size: 11, weight: .bold))
                    }
                    .foregroundStyle(emerald)
                case .failed:
                    Text("异常")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(coral)
                case .thinking, .tool, .writing:
                    liveClockView(state: context.state, fontSize: 11.5)
                        .foregroundStyle(accent)
                        .frame(width: 44, alignment: .trailing)
                }
            } minimal: {
                ZStack {
                    Circle()
                        .fill(accent.opacity(0.22))
                    Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(accent)
                }
            }
            .widgetURL(URL(string: "velo://session/\(context.attributes.sessionId)"))
            .keylineTint(accent)
        }
    }

    private func formatDuration(_ sec: Int) -> String {
        let s = max(0, sec)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private func formatTps(_ tps: Double) -> String {
        tps >= 10 ? "\(Int(tps.rounded())) tok/s" : String(format: "%.1f tok/s", tps)
    }

    private func shortTps(_ tps: Double) -> String {
        tps >= 10 ? "\(Int(tps.rounded()))t/s" : String(format: "%.1ft/s", tps)
    }
}
