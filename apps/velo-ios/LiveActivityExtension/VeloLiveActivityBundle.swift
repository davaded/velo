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
    private let emerald = Color(red: 0.20, green: 0.83, blue: 0.60)
    private let amber = Color(red: 0.98, green: 0.75, blue: 0.14)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VeloSessionActivityAttributes.self) { context in
            // Lock Screen & Notification Banner View
            let isWaiting = context.state.statusLabel.contains("审") || context.state.statusLabel.contains("确认")
            let statusColor = isWaiting ? amber : emerald

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(context.attributes.engineBadge)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(violet)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(violet.opacity(0.18), in: Capsule())

                    Text(context.attributes.sessionTitle)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    Text(formatDuration(context.state.elapsedSeconds))
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.72))
                }

                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 7, height: 7)

                    Text(context.state.statusLabel)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.88))

                    Spacer()

                    if let tps = context.state.throughputTps, tps > 0 {
                        Text(formatTps(tps))
                            .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(emerald)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2.5)
                            .background(emerald.opacity(0.15), in: Capsule())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.09).opacity(0.92))
            .activitySystemActionForegroundColor(.white)
            .widgetURL(URL(string: "velo://session/\(context.attributes.sessionId)"))

        } dynamicIsland: { context in
            let isWaiting = context.state.statusLabel.contains("审") || context.state.statusLabel.contains("确认")
            let statusColor = isWaiting ? amber : emerald

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 7.5, height: 7.5)
                        Text(context.attributes.engineBadge)
                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                            .foregroundStyle(violet)
                    }
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    if let tps = context.state.throughputTps, tps > 0 {
                        Text(formatTps(tps))
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(emerald)
                            .padding(.trailing, 4)
                    } else {
                        Text(formatDuration(context.state.elapsedSeconds))
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(.trailing, 4)
                    }
                }

                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 8) {
                        Text(context.attributes.sessionTitle)
                            .font(.system(size: 13.5, weight: .semibold))
                            .lineLimit(1)

                        Spacer(minLength: 6)

                        Text("\(context.state.statusLabel) · \(formatDuration(context.state.elapsedSeconds))")
                            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
            } compactLeading: {
                HStack(spacing: 4) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6.5, height: 6.5)
                    Text(context.attributes.engineBadge)
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundStyle(violet)
                }
            } compactTrailing: {
                if let tps = context.state.throughputTps, tps > 0 {
                    Text(shortTps(tps))
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(emerald)
                } else {
                    Text(formatDuration(context.state.elapsedSeconds))
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            } minimal: {
                Image(systemName: isWaiting ? "exclamationmark.shield.fill" : "bolt.horizontal.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(statusColor)
            }
            .widgetURL(URL(string: "velo://session/\(context.attributes.sessionId)"))
            .keylineTint(violet)
        }
    }

    private func formatDuration(_ sec: Int) -> String {
        let s = max(0, sec)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    private func formatTps(_ tps: Double) -> String {
        tps >= 10 ? "\(Int(tps.rounded())) tok/s" : String(format: "%.1f tok/s", tps)
    }

    private func shortTps(_ tps: Double) -> String {
        tps >= 10 ? "\(Int(tps.rounded()))t/s" : String(format: "%.1ft/s", tps)
    }
}
