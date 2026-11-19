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
    private let skyBlue = Color(red: 0.38, green: 0.65, blue: 0.98)
    private let violet = Color(red: 0.65, green: 0.55, blue: 0.98)
    private let terracotta = Color(red: 0.96, green: 0.54, blue: 0.32)
    private let emerald = Color(red: 0.20, green: 0.83, blue: 0.60)
    private let cyan = Color(red: 0.22, green: 0.74, blue: 0.97)
    private let amber = Color(red: 0.98, green: 0.75, blue: 0.14)
    private let coral = Color(red: 0.97, green: 0.44, blue: 0.44)

    private func engineAccent(_ badge: String) -> Color {
        let lower = badge.lowercased()
        if lower.contains("antigravity") || lower.contains("agy") || lower.contains("gemini") {
            return skyBlue
        }
        if lower.contains("cursor") { return violet }
        if lower.contains("claude") { return terracotta }
        if lower.contains("codex") || lower.contains("openai") { return emerald }
        if lower.contains("grok") { return cyan }
        return violet
    }

    private func engineIcon(_ badge: String) -> String {
        let lower = badge.lowercased()
        if lower.contains("antigravity") || lower.contains("agy") || lower.contains("gemini") {
            return "atom"
        }
        if lower.contains("cursor") { return "cursorarrow.rays" }
        if lower.contains("claude") { return "sparkles" }
        if lower.contains("codex") || lower.contains("openai") { return "terminal.fill" }
        if lower.contains("grok") { return "bolt.fill" }
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
        case .thinking, .tool, .writing: return engineAccent(badge)
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
        case .thinking: return engineIcon(badge)
        case .tool: return "hammer.fill"
        case .writing: return "waveform"
        }
    }

    private func phaseShortLabel(_ phase: VeloSessionActivityAttributes.PhaseKind) -> String {
        switch phase {
        case .thinking: return "思考中"
        case .tool: return "工具执行"
        case .writing: return "输出回复"
        case .waitingApproval: return "等待审批"
        case .completed: return "已完成"
        case .failed: return "执行异常"
        }
    }

    /// Uses a bounded 59:59 timer interval (instead of `Date.distantFuture`) so SwiftUI WidgetKit
    /// computes a compact 4–5 character bounding box and never clips to `...` or crushes neighbor text!
    @ViewBuilder
    private func liveClockView(
        state: VeloSessionActivityAttributes.ContentState,
        fontSize: CGFloat,
        fixedWidth: CGFloat
    ) -> some View {
        if let doneSec = state.finishedElapsedSeconds {
            Text(formatDuration(doneSec))
                .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: fixedWidth, alignment: .trailing)
        } else {
            let safeStart = min(state.startedAt, Date())
            let boundedEnd = safeStart.addingTimeInterval(3599)
            Text(timerInterval: safeStart...boundedEnd, countsDown: false)
                .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(width: fixedWidth, alignment: .trailing)
        }
    }

    @ViewBuilder
    private func phaseProgressBar(
        phase: VeloSessionActivityAttributes.PhaseKind,
        accent: Color,
        stepCount: Int
    ) -> some View {
        let fraction: CGFloat = {
            switch phase {
            case .completed, .failed: return 1.0
            case .waitingApproval: return 0.72
            case .writing: return 0.85
            case .tool: return min(0.78, 0.28 + CGFloat(stepCount) * 0.1)
            case .thinking: return 0.22
            }
        }()
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [accent.opacity(0.75), accent],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(12, geo.size.width * fraction))
            }
        }
        .frame(height: 3)
    }

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VeloSessionActivityAttributes.self) { context in
            // MARK: - Lock Screen & StandBy Banner
            let accent = phaseColor(context.state.phase, badge: context.attributes.engineBadge)
            let brandColor = engineAccent(context.attributes.engineBadge)

            VStack(alignment: .leading, spacing: 9) {
                // Header: Engine Pill + Project/Branch + Clean Right-Aligned Timer
                HStack(spacing: 7) {
                    HStack(spacing: 4) {
                        Image(systemName: engineIcon(context.attributes.engineBadge))
                            .font(.system(size: 10, weight: .bold))
                        Text(context.attributes.engineBadge)
                            .font(.system(size: 11, weight: .bold))
                    }
                    .foregroundStyle(brandColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(brandColor.opacity(0.18), in: Capsule())

                    Text("\(context.attributes.projectName) · \(context.attributes.branchName)")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)

                    Spacer(minLength: 6)

                    liveClockView(state: context.state, fontSize: 13, fixedWidth: 46)
                        .foregroundStyle(.white.opacity(0.88))
                }

                // Title
                Text(context.attributes.sessionTitle)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                // Recessed Live Step & Telemetry Strip
                HStack(spacing: 7) {
                    Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(accent)

                    VStack(alignment: .leading, spacing: 1.5) {
                        Text(context.state.stepHeadline)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(
                                context.state.phase == .waitingApproval ? amber : .white.opacity(0.92)
                            )
                            .lineLimit(1)

                        if let target = context.state.stepTarget, !target.isEmpty {
                            Text(target)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.52))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer(minLength: 6)

                    if context.state.phase == .waitingApproval {
                        Text("点此审批")
                            .font(.system(size: 10.5, weight: .bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3.5)
                            .background(amber, in: Capsule())
                    } else if let tps = context.state.throughputTps, tps >= 0.5, context.state.phase == .writing {
                        Text("⚡ \(shortTps(tps))")
                            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(emerald)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2.5)
                            .background(emerald.opacity(0.16), in: Capsule())
                    } else if context.state.insertions > 0 || context.state.deletions > 0 {
                        HStack(spacing: 3) {
                            Text("+\(context.state.insertions)")
                                .foregroundStyle(emerald)
                            Text("−\(context.state.deletions)")
                                .foregroundStyle(coral)
                        }
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                    } else if context.state.stepCount > 0 {
                        Text("第 \(context.state.stepCount) 步")
                            .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.55))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7.5)
                .background(
                    context.state.phase == .waitingApproval
                        ? amber.opacity(0.12)
                        : Color.white.opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .stroke(
                            context.state.phase == .waitingApproval
                                ? amber.opacity(0.35)
                                : Color.white.opacity(0.08),
                            lineWidth: 0.7
                        )
                )

                phaseProgressBar(
                    phase: context.state.phase,
                    accent: accent,
                    stepCount: context.state.stepCount
                )
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .activityBackgroundTint(Color(red: 0.055, green: 0.06, blue: 0.085).opacity(0.96))
            .activitySystemActionForegroundColor(.white)
            .widgetURL(URL(string: "velo://session/\(context.attributes.sessionId)"))

        } dynamicIsland: { context in
            let accent = phaseColor(context.state.phase, badge: context.attributes.engineBadge)
            let brandColor = engineAccent(context.attributes.engineBadge)

            return DynamicIsland {
                // MARK: - Expanded Dynamic Island (Cutout-Safe Leading / Trailing + Full-Width Bottom)
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 7) {
                        ZStack {
                            Circle()
                                .fill(brandColor.opacity(0.22))
                                .frame(width: 26, height: 26)
                            Image(systemName: engineIcon(context.attributes.engineBadge))
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(brandColor)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(context.attributes.engineBadge)
                                .font(.system(size: 12.5, weight: .bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text(phaseShortLabel(context.state.phase))
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(accent)
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                    .padding(.top, 2)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        liveClockView(state: context.state, fontSize: 14, fixedWidth: 46)
                            .foregroundStyle(.white)

                        if let tps = context.state.throughputTps, tps >= 0.5, context.state.phase == .writing {
                            Text("⚡ \(shortTps(tps))")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(emerald)
                                .lineLimit(1)
                        } else if context.state.stepCount > 0 {
                            Text("第 \(context.state.stepCount) 步")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.55))
                                .lineLimit(1)
                        } else {
                            Text(context.attributes.branchName)
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.48))
                                .lineLimit(1)
                        }
                    }
                    .padding(.trailing, 4)
                    .padding(.top, 2)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        // Row 1: Project Pill + Full Session Title + Diff Stats
                        HStack(spacing: 6) {
                            Text(context.attributes.projectName)
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.75))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.white.opacity(0.10), in: Capsule())
                                .lineLimit(1)

                            Text(context.attributes.sessionTitle)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.94))
                                .lineLimit(1)

                            Spacer(minLength: 4)

                            if context.state.insertions > 0 || context.state.deletions > 0 {
                                HStack(spacing: 3) {
                                    Text("+\(context.state.insertions)")
                                        .foregroundStyle(emerald)
                                    Text("−\(context.state.deletions)")
                                        .foregroundStyle(coral)
                                }
                                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                            }
                        }

                        // Row 2: Active Step Capsule
                        HStack(spacing: 7) {
                            Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(accent)

                            Text(context.state.stepHeadline)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(
                                    context.state.phase == .waitingApproval ? amber : .white.opacity(0.88)
                                )
                                .lineLimit(1)

                            if let target = context.state.stepTarget, !target.isEmpty {
                                Text(target)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.48))
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }

                            Spacer(minLength: 2)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            context.state.phase == .waitingApproval
                                ? amber.opacity(0.14)
                                : Color.white.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )

                        phaseProgressBar(
                            phase: context.state.phase,
                            accent: accent,
                            stepCount: context.state.stepCount
                        )
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 3)
                }
            } compactLeading: {
                // Pure iconic engine/phase emblem — zero clipped text, crisp pill symmetry!
                ZStack {
                    Circle()
                        .fill(accent.opacity(0.24))
                        .frame(width: 21, height: 21)
                    Image(systemName: phaseIcon(context.state.phase, badge: context.attributes.engineBadge))
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(accent)
                }
            } compactTrailing: {
                switch context.state.phase {
                case .waitingApproval:
                    Text("审批")
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundStyle(amber)
                case .completed:
                    HStack(spacing: 2) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9.5, weight: .bold))
                        Text("完成")
                            .font(.system(size: 11, weight: .bold))
                    }
                    .foregroundStyle(emerald)
                case .failed:
                    Text("异常")
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundStyle(coral)
                case .thinking, .tool, .writing:
                    liveClockView(state: context.state, fontSize: 12, fixedWidth: 36)
                        .foregroundStyle(accent)
                }
            } minimal: {
                ZStack {
                    Circle()
                        .fill(accent.opacity(0.24))
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

    private func shortTps(_ tps: Double) -> String {
        tps >= 10 ? "\(Int(tps.rounded()))t/s" : String(format: "%.1ft/s", tps)
    }
}
