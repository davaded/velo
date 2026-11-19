import SwiftUI
import UIKit

// MARK: - 1. Tactile 120Hz Spring Press Style (Rare UI / BeUI)

public struct VeloPressableButtonStyle: ButtonStyle {
    public var scale: CGFloat = 0.968

    public init(scale: CGFloat = 0.968) {
        self.scale = scale
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .opacity(configuration.isPressed ? 0.88 : 1.0)
            .animation(.spring(response: 0.22, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

// MARK: - 2. Brand Engine Badge Pill

public struct EngineBadgePill: View {
    public let category: VeloEngineCategory
    public var compact: Bool = false

    public init(category: VeloEngineCategory, compact: Bool = false) {
        self.category = category
        self.compact = compact
    }

    public var body: some View {
        HStack(spacing: compact ? 3.5 : 4.5) {
            Image(systemName: category.iconName)
                .font(.system(size: compact ? 9.5 : 10.5, weight: .semibold))
            Text(compact ? category.shortBadge : category.title)
                .font(.system(size: compact ? 10.5 : 11.5, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(category.accentColor)
        .padding(.horizontal, compact ? 6.5 : 8.5)
        .padding(.vertical, compact ? 2.5 : 4)
        .background(
            category.accentColor.opacity(0.13),
            in: Capsule()
        )
        .overlay(
            Capsule()
                .stroke(category.accentColor.opacity(0.28), lineWidth: 0.75)
        )
    }
}

// MARK: - 3. Stateless TimelineView Specular Shimmer Text (Never Freezes on Recycle/Transition)

public struct ShimmerTextView: View {
    public let text: String
    public var font: Font = .system(size: 13.5, weight: .medium)
    public var accent: Color = VeloTheme.accentVioletSoft

    public init(
        _ text: String,
        font: Font = .system(size: 13.5, weight: .medium),
        accent: Color = VeloTheme.accentVioletSoft
    ) {
        self.text = text
        self.font = font
        self.accent = accent
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { ctx in
            let cycle = ctx.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: 1.65) / 1.65
            let phase = -0.55 + CGFloat(cycle) * 1.90

            Text(text)
                .font(font)
                .foregroundStyle(Color.secondary.opacity(0.82))
                .overlay {
                    GeometryReader { geo in
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0.0),
                                .init(color: accent.opacity(0.55), location: 0.35),
                                .init(color: Color.primary.opacity(0.95), location: 0.5),
                                .init(color: accent.opacity(0.55), location: 0.65),
                                .init(color: .clear, location: 1.0),
                            ],
                            startPoint: UnitPoint(x: 0, y: 0.2),
                            endPoint: UnitPoint(x: 1, y: 0.8)
                        )
                        .frame(width: max(68, geo.size.width * 0.58))
                        .offset(x: phase * (geo.size.width + 88))
                    }
                    .mask(
                        Text(text)
                            .font(font)
                    )
                }
        }
    }
}

// MARK: - 4. Stateless Dual-Ring Orbital Status Icon + Breathing Sparkles

public struct OrbitalStatusIcon: View {
    public let phase: AgentLivePhase

    public init(phase: AgentLivePhase) {
        self.phase = phase
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let wave = (sin(t * .pi * 2.0 / 1.85) + 1.0) * 0.5 // smooth 0...1

            switch phase {
            case .waiting:
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(VeloTheme.amber)
                    .scaleEffect(0.92 + 0.18 * wave)

            case .thinking:
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .scaleEffect(0.86 + 0.26 * wave)
                    .rotationEffect(.degrees(-8.0 + 16.0 * wave))
                    .opacity(0.62 + 0.38 * wave)

            case .tool, .working, .writing:
                let spinDeg = (t / 0.92).truncatingRemainder(dividingBy: 1.0) * 360.0
                let counterDeg = -(t / 1.45).truncatingRemainder(dividingBy: 1.0) * 360.0

                ZStack {
                    Circle()
                        .stroke(VeloTheme.accentViolet.opacity(0.18), lineWidth: 1.5)
                        .frame(width: 15, height: 15)

                    Circle()
                        .trim(from: 0.0, to: 0.36)
                        .stroke(
                            VeloTheme.accentVioletSoft,
                            style: StrokeStyle(lineWidth: 1.75, lineCap: .round)
                        )
                        .frame(width: 15, height: 15)
                        .rotationEffect(.degrees(spinDeg))

                    Circle()
                        .trim(from: 0.5, to: 0.72)
                        .stroke(
                            Color.primary.opacity(0.55),
                            style: StrokeStyle(lineWidth: 1.2, lineCap: .round)
                        )
                        .frame(width: 10.5, height: 10.5)
                        .rotationEffect(.degrees(counterDeg))

                    Circle()
                        .fill(VeloTheme.accentVioletSoft)
                        .frame(width: 3.2, height: 3.2)
                }
            }
        }
    }
}

// MARK: - 5. Vertical Indent Guide Rail (Paseo / BeautifulAgentPrimitives)

public struct IndentRailContainer<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(.leading, 15)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(
                        LinearGradient(
                            colors: [
                                VeloTheme.accentViolet.opacity(0.42),
                                VeloTheme.hairline(colorScheme),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: 1.75)
                    .padding(.leading, 6.5)
                    .padding(.vertical, 2)
            }
    }
}

// MARK: - 6. Collapsible Reasoning View (`Thinking…` -> `Thought for Xs`)

public struct ReasoningRowView: View {
    public let rawText: String
    public let startedAt: Date?
    public let durationMs: Int?
    public let isStreaming: Bool

    @State private var isExpanded: Bool = false

    public init(
        rawText: String,
        startedAt: Date?,
        durationMs: Int?,
        isStreaming: Bool
    ) {
        self.rawText = rawText
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.isStreaming = isStreaming
    }

    public var body: some View {
        let parsed = VeloFormatting.parseReasoning(rawText)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard !parsed.lines.isEmpty else { return }
                withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    if isStreaming {
                        OrbitalStatusIcon(phase: .thinking)
                            .frame(width: 16)
                    } else {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(VeloTheme.accentVioletSoft.opacity(0.85))
                            .frame(width: 16)
                    }

                    if isStreaming {
                        TimelineView(.periodic(from: .now, by: 1.0)) { ctx in
                            let elapsedMs = Int(max(0, ctx.date.timeIntervalSince(startedAt ?? ctx.date)) * 1000)
                            let label = elapsedMs >= 1000
                                ? "思考中 \(VeloFormatting.formatDuration(ms: elapsedMs))"
                                : "思考中…"
                            ShimmerTextView(
                                parsed.summary.isEmpty ? label : "\(label) · \(parsed.summary)",
                                font: .system(size: 13, weight: .medium)
                            )
                            .lineLimit(1)
                            .contentTransition(.numericText())
                        }
                    } else {
                        let base = (durationMs ?? 0) >= 500
                            ? "已思考 \(VeloFormatting.formatDuration(ms: durationMs!))"
                            : "已思考"
                        Text(parsed.summary.isEmpty ? base : "\(base) · \(parsed.summary)")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    if !parsed.lines.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }

                    Spacer(minLength: 0)
                }
                .padding(.vertical, 3.5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded && !parsed.lines.isEmpty {
                IndentRailContainer {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(parsed.lines.enumerated()), id: \.offset) { _, line in
                            let isHeader = line.hasPrefix("**")
                            let cleanLine = line.replacingOccurrences(of: "**", with: "")
                            Text(cleanLine)
                                .font(.system(size: 12.5, weight: isHeader ? .semibold : .regular))
                                .foregroundStyle(isHeader ? .primary : .secondary)
                                .lineSpacing(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// MARK: - 7. Grouped Consecutive Tool Calls Row (PaseoToolCallGroup Parity)

// MARK: - 7. Unified Collapsible Execution Trace Group (Consecutive `Thought` + `MCP` / Tool Calls)

public struct ExecutionTraceGroupView: View {
    public let items: [TimelineEventItem]
    public let isTurnRunning: Bool
    public let turnStartedAt: Date?
    public let defaultExpanded: Bool

    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded: Bool

    public init(
        items: [TimelineEventItem],
        isTurnRunning: Bool = false,
        turnStartedAt: Date? = nil,
        defaultExpanded: Bool = false
    ) {
        self.items = items
        self.isTurnRunning = isTurnRunning
        self.turnStartedAt = turnStartedAt
        self.defaultExpanded = defaultExpanded
        self._expanded = State(initialValue: defaultExpanded)
    }

    public var body: some View {
        let meta = VeloFormatting.summarizeExecutionTrace(items)
        let activelyRunning = isTurnRunning && meta.isRunning

        VStack(alignment: .leading, spacing: 6) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation(.spring(response: 0.26, dampingFraction: 0.82)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    if activelyRunning {
                        OrbitalStatusIcon(phase: .working)
                            .frame(width: 16)
                    } else {
                        Image(
                            systemName: meta.hasError
                                ? "exclamationmark.triangle.fill"
                                : "square.stack.3d.up.fill"
                        )
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(meta.hasError ? VeloTheme.coral : VeloTheme.accentVioletSoft.opacity(0.9))
                        .frame(width: 16)
                    }

                    if activelyRunning, let activeLabel = meta.activeLabel {
                        ShimmerTextView(
                            activeLabel,
                            font: .system(size: 12.5, weight: .medium)
                        )
                        .lineLimit(1)
                    } else {
                        Text(expanded ? "执行过程明细 (\(items.count) 步)" : meta.title)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    if activelyRunning {
                        Text("\(items.count) 步")
                            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(VeloTheme.accentVioletSoft)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())
                    }

                    Text(expanded ? "收起" : "展开")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(.tertiary)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6.5)
                .background(
                    VeloTheme.elevatedSurface(colorScheme).opacity(0.62),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(
                            activelyRunning
                                ? VeloTheme.accentViolet.opacity(0.32)
                                : VeloTheme.hairline(colorScheme),
                            lineWidth: 0.75
                        )
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
            .onChange(of: defaultExpanded) { _, newDefault in
                withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
                    expanded = newDefault
                }
            }

            if expanded {
                IndentRailContainer {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                            let isLastInBatch = idx == items.count - 1
                            switch item.kind {
                            case .thinking(let startedAt, let durationMs, let isStreaming):
                                ReasoningRowView(
                                    rawText: item.content,
                                    startedAt: startedAt ?? turnStartedAt,
                                    durationMs: durationMs,
                                    isStreaming: isStreaming && isTurnRunning && isLastInBatch
                                )
                            case .toolCall(let toolName, let displayName, let workingVerb, let summary, let output, let isError):
                                ToolCallRowView(
                                    toolName: toolName,
                                    displayName: displayName,
                                    workingVerb: workingVerb,
                                    summary: summary,
                                    output: output,
                                    isError: isError,
                                    inlineDiffOld: item.inlineDiffOld,
                                    inlineDiffNew: item.inlineDiffNew,
                                    subagentRole: item.subagentRole,
                                    subagentPrompt: item.subagentPrompt,
                                    nested: true
                                )
                            default:
                                EmptyView()
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

public struct ToolCallGroupRowView: View {
    public let items: [TimelineEventItem]
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded: Bool = false

    public init(items: [TimelineEventItem]) {
        self.items = items
    }

    public var body: some View {
        let meta = VeloFormatting.summarizeToolBatch(items)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    if meta.isRunning {
                        OrbitalStatusIcon(phase: .working)
                            .frame(width: 16)
                    } else {
                        Image(systemName: meta.hasError ? "exclamationmark.triangle.fill" : "square.stack.3d.up.fill")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(meta.hasError ? VeloTheme.coral : .secondary)
                            .frame(width: 16)
                    }

                    if let activeVerb = meta.activeVerb {
                        ShimmerTextView(
                            "\(activeVerb)… (\(items.count) 步)",
                            font: .system(size: 13, weight: .medium)
                        )
                        .lineLimit(1)
                    } else {
                        Text(meta.title)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    VeloTheme.elevatedSurface(colorScheme).opacity(0.65),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.75)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(VeloPressableButtonStyle(scale: 0.985))

            if expanded {
                IndentRailContainer {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(items) { item in
                            if case .toolCall(let toolName, let displayName, let workingVerb, let summary, let output, let isError) = item.kind {
                                ToolCallRowView(
                                    toolName: toolName,
                                    displayName: displayName,
                                    workingVerb: workingVerb,
                                    summary: summary,
                                    output: output,
                                    isError: isError,
                                    inlineDiffOld: item.inlineDiffOld,
                                    inlineDiffNew: item.inlineDiffNew,
                                    subagentRole: item.subagentRole,
                                    subagentPrompt: item.subagentPrompt,
                                    nested: true
                                )
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// MARK: - 8. Single Expandable Tool Call Row

public struct ToolCallRowView: View {
    public let toolName: String
    public let displayName: String
    public let workingVerb: String
    public let summary: String
    public let output: String?
    public let isError: Bool
    public var inlineDiffOld: String? = nil
    public var inlineDiffNew: String? = nil
    public var subagentRole: String? = nil
    public var subagentPrompt: String? = nil
    public var nested: Bool = false

    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded: Bool = false

    public init(
        toolName: String,
        displayName: String,
        workingVerb: String,
        summary: String,
        output: String?,
        isError: Bool,
        inlineDiffOld: String? = nil,
        inlineDiffNew: String? = nil,
        subagentRole: String? = nil,
        subagentPrompt: String? = nil,
        nested: Bool = false
    ) {
        self.toolName = toolName
        self.displayName = displayName
        self.workingVerb = workingVerb
        self.summary = summary
        self.output = output
        self.isError = isError
        self.inlineDiffOld = inlineDiffOld
        self.inlineDiffNew = inlineDiffNew
        self.subagentRole = subagentRole
        self.subagentPrompt = subagentPrompt
        self.nested = nested
    }

    private var isRunning: Bool { output == nil }

    private var hasInlineDiff: Bool {
        (inlineDiffOld?.isEmpty == false) || (inlineDiffNew?.isEmpty == false)
    }

    private var oldLines: [String] {
        guard let inlineDiffOld, !inlineDiffOld.isEmpty else { return [] }
        return Array(inlineDiffOld.components(separatedBy: .newlines).prefix(18))
    }

    private var newLines: [String] {
        guard let inlineDiffNew, !inlineDiffNew.isEmpty else { return [] }
        return Array(inlineDiffNew.components(separatedBy: .newlines).prefix(18))
    }

    private var iconName: String {
        if subagentRole != nil { return "point.3.connected.trianglepath.dotted" }
        return VeloFormatting.presentTool(toolName: toolName, argsDict: nil, output: output).iconSystemName
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(response: 0.26, dampingFraction: 0.8)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    if isRunning {
                        OrbitalStatusIcon(phase: .working)
                            .frame(width: 15)
                    } else {
                        Image(systemName: isError ? "exclamationmark.triangle.fill" : iconName)
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(
                                isError
                                    ? VeloTheme.coral
                                    : (subagentRole != nil ? VeloTheme.accentVioletSoft : .secondary)
                            )
                            .frame(width: 15)
                    }

                    if let role = subagentRole, !role.isEmpty {
                        Text("Subagent")
                            .font(.system(size: 10.5, weight: .bold))
                            .foregroundStyle(VeloTheme.accentVioletSoft)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(VeloTheme.accentViolet.opacity(0.15), in: Capsule())
                        Text(role)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    } else if isRunning {
                        ShimmerTextView(workingVerb, font: .system(size: 12.5, weight: .medium))
                            .lineLimit(1)
                    } else {
                        Text(displayName)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                        if !summary.isEmpty {
                            Text(summary)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 4)

                    if hasInlineDiff {
                        HStack(spacing: 3) {
                            if !newLines.isEmpty {
                                Text("+\(newLines.count)")
                                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(VeloTheme.emerald)
                            }
                            if !oldLines.isEmpty {
                                Text("−\(oldLines.count)")
                                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(VeloTheme.coral)
                            }
                        }
                    }

                    if output != nil || hasInlineDiff || subagentPrompt != nil {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundStyle(.quaternary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, nested ? 4 : 9)
                .padding(.vertical, nested ? 3 : 5.5)
                .background {
                    if !nested {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(VeloTheme.elevatedSurface(colorScheme).opacity(0.5))
                            .overlay(
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.7)
                            )
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    if !summary.isEmpty {
                        HStack(spacing: 6) {
                            Text(displayName == "Shell" ? "$ \(summary)" : summary)
                                .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6.5)
                        .background(VeloTheme.codeHeader(colorScheme))
                    }

                    if let sp = subagentPrompt, !sp.isEmpty {
                        Text(sp)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                            .padding(9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(VeloTheme.accentViolet.opacity(0.06))
                    }

                    if hasInlineDiff {
                        ScrollView(.horizontal, showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 1) {
                                ForEach(Array(oldLines.enumerated()), id: \.offset) { _, line in
                                    Text("− \(line)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(VeloTheme.coral)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 1.5)
                                        .background(VeloTheme.coral.opacity(0.11))
                                }
                                ForEach(Array(newLines.enumerated()), id: \.offset) { _, line in
                                    Text("+ \(line)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(VeloTheme.emerald)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 1.5)
                                        .background(VeloTheme.emerald.opacity(0.11))
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }

                    if let output, !output.isEmpty, (!hasInlineDiff || isError) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(String(output.prefix(2600)))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(isError ? VeloTheme.coral : .secondary)
                                .lineSpacing(2)
                                .padding(10)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 190)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    VeloTheme.codeSurface(colorScheme),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                )
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
            }
        }
    }
}

// MARK: - 9. Stateless Pulsing Streaming Cursor Indicator

public struct StreamingCursorDot: View {
    public init() {}

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let wave = (sin(t * .pi * 2.0 / 1.1) + 1.0) * 0.5
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(VeloTheme.accentVioletSoft)
                    .frame(width: 7, height: 14)
                    .opacity(0.2 + 0.75 * wave)
                Spacer(minLength: 0)
            }
            .padding(.top, 1)
        }
    }
}

// MARK: - 10. Phase-Morphing Live Turn Status & Industry Telemetry Footer

public struct TurnStatusFooterView: View {
    public let isRunning: Bool
    public let phase: AgentLivePhase
    public let startedAt: Date?
    public let durationMs: Int?
    public let completedAt: String?
    public let liveTps: Double?
    public let telemetry: TurnUsageTelemetry?
    public let assistantText: String?
    public let onRetry: (() -> Void)?
    public let onFork: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false
    @State private var showTimestampInstead = false

    public init(
        isRunning: Bool,
        phase: AgentLivePhase,
        startedAt: Date?,
        durationMs: Int?,
        completedAt: String?,
        liveTps: Double? = nil,
        telemetry: TurnUsageTelemetry? = nil,
        assistantText: String?,
        onRetry: (() -> Void)?,
        onFork: (() -> Void)? = nil
    ) {
        self.isRunning = isRunning
        self.phase = phase
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.completedAt = completedAt
        self.liveTps = liveTps
        self.telemetry = telemetry
        self.assistantText = assistantText
        self.onRetry = onRetry
        self.onFork = onFork
    }

    private var phaseIdentity: String {
        switch phase {
        case .thinking: return "thinking"
        case .tool(let v): return "tool:\(v)"
        case .working: return "working"
        case .writing: return "writing"
        case .waiting(let l): return "waiting:\(l)"
        }
    }

    public var body: some View {
        if isRunning {
            TimelineView(.periodic(from: .now, by: 1.0)) { ctx in
                let elapsedMs = max(0, Int(ctx.date.timeIntervalSince(startedAt ?? ctx.date) * 1000))
                let formattedClock = VeloFormatting.formatDuration(ms: elapsedMs)

                HStack(spacing: 7) {
                    OrbitalStatusIcon(phase: phase)

                    Group {
                        switch phase {
                        case .waiting(let label):
                            Text(label)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(VeloTheme.amber)
                        case .thinking:
                            let label = elapsedMs >= 1000
                                ? "正在深度思考 · \(formattedClock)"
                                : "正在思考…"
                            ShimmerTextView(label, font: .system(size: 12.5, weight: .medium))
                        case .tool(let verb):
                            ShimmerTextView("执行中 · \(verb)", font: .system(size: 12.5, weight: .medium))
                                .lineLimit(1)
                            Text("· \(formattedClock)")
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .contentTransition(.numericText())
                        case .writing:
                            ShimmerTextView("正在生成回复…", font: .system(size: 12.5, weight: .medium))
                            Text("· \(formattedClock)")
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .contentTransition(.numericText())
                        case .working:
                            ShimmerTextView("处理中…", font: .system(size: 12.5, weight: .medium))
                            Text("· \(formattedClock)")
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .contentTransition(.numericText())
                        }
                    }
                    .id(phaseIdentity)
                    .transition(.opacity.combined(with: .offset(y: 3)))

                    let runningTps = liveTps ?? telemetry?.tps
                    if let runningTps, runningTps >= 0.5 {
                        HStack(spacing: 3) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 9.5, weight: .bold))
                            Text(String(format: "%.1f tok/s", runningTps))
                                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                .contentTransition(.numericText())
                        }
                        .foregroundStyle(VeloTheme.accentVioletSoft)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(VeloTheme.accentViolet.opacity(0.13), in: Capsule())
                    }

                    Spacer(minLength: 0)
                }
                .animation(.snappy(duration: 0.22), value: phaseIdentity)
                .padding(.top, 4)
            }
        } else if assistantText != nil || durationMs != nil || telemetry != nil || onRetry != nil {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    if let tps = telemetry?.tps, tps >= 0.5 {
                        HStack(spacing: 3) {
                            Image(systemName: "bolt.fill")
                                .font(.system(size: 9.5, weight: .bold))
                            Text(String(format: "%.1f tok/s", tps))
                                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                        }
                        .foregroundStyle(VeloTheme.accentVioletSoft)
                        .padding(.horizontal, 7.5)
                        .padding(.vertical, 3.5)
                        .background(VeloTheme.accentViolet.opacity(0.11), in: Capsule())
                    }

                    if let durationMs, durationMs > 0 {
                        Button {
                            withAnimation(.snappy(duration: 0.2)) {
                                showTimestampInstead.toggle()
                            }
                        } label: {
                            Text(
                                showTimestampInstead && (completedAt?.isEmpty == false)
                                    ? "完成于 \(completedAt!)"
                                    : "耗时 \(VeloFormatting.formatDuration(ms: durationMs))"
                            )
                            .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .contentTransition(.numericText())
                        }
                        .buttonStyle(.plain)
                    } else if let completedAt, !completedAt.isEmpty {
                        Text(completedAt)
                            .font(.system(size: 11.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }

                    if let tel = telemetry {
                        if tel.totalTokens > 0 {
                            Text("· \(VeloFormatting.formatCompactTokens(tel.totalTokens)) tok")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        if let hitPct = tel.cacheHitPercent, hitPct > 0 {
                            Text("· 缓存 \(hitPct)%")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(VeloTheme.emerald.opacity(0.85))
                        }
                        if tel.costUsd >= 0.0001 {
                            Text("· \(VeloFormatting.formatUsd(tel.costUsd))")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                    }

                    if let assistantText, !assistantText.isEmpty {
                        Button {
                            UIPasteboard.general.string = assistantText
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            withAnimation(.snappy(duration: 0.18)) {
                                copied = true
                            }
                            Task {
                                try? await Task.sleep(nanoseconds: 1_500_000_000)
                                withAnimation(.snappy(duration: 0.18)) {
                                    copied = false
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 10.5, weight: .semibold))
                                Text(copied ? "已复制" : "复制")
                                    .font(.system(size: 11.5, weight: .medium))
                            }
                            .foregroundStyle(copied ? VeloTheme.emerald : .secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                        }
                        .buttonStyle(VeloPressableButtonStyle())
                    }

                    if let onRetry {
                        Button(action: onRetry) {
                            HStack(spacing: 3.5) {
                                Image(systemName: "arrow.counterclockwise")
                                    .font(.system(size: 10.5, weight: .semibold))
                                Text("重试")
                                    .font(.system(size: 11.5, weight: .medium))
                            }
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                        }
                        .buttonStyle(VeloPressableButtonStyle())
                    }

                    if let onFork {
                        Button(action: onFork) {
                            HStack(spacing: 3.5) {
                                Image(systemName: "arrow.branch")
                                    .font(.system(size: 10.5, weight: .semibold))
                                Text("分叉")
                                    .font(.system(size: 11.5, weight: .medium))
                            }
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                        }
                        .buttonStyle(VeloPressableButtonStyle())
                    }
                }
            }
            .padding(.top, 3)
        }
    }
}
