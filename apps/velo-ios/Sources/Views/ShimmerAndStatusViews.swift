import SwiftUI

// MARK: - 1. Native 120Hz SwiftUI Shimmer Text (Light & Dark Adaptive)

public struct ShimmerTextView: View {
    public let text: String
    public var font: Font = .system(size: 13.5, weight: .medium)

    @State private var phase: CGFloat = -0.6

    public init(_ text: String, font: Font = .system(size: 13.5, weight: .medium)) {
        self.text = text
        self.font = font
    }

    public var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(.secondary)
            .overlay {
                GeometryReader { geo in
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0.0),
                            .init(color: Color.primary.opacity(0.85), location: 0.5),
                            .init(color: .clear, location: 1.0),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: max(60, geo.size.width * 0.55))
                    .offset(x: phase * (geo.size.width + 80))
                }
                .mask(
                    Text(text)
                        .font(font)
                )
            }
            .onAppear {
                phase = -0.6
                withAnimation(.linear(duration: 1.75).repeatForever(autoreverses: false)) {
                    phase = 1.35
                }
            }
    }
}

// MARK: - 2. Dual-Ring Orbital Status Icon + Sparkle Breathing

public struct OrbitalStatusIcon: View {
    public let phase: AgentLivePhase
    @State private var spinning = false
    @State private var pulsing = false

    public var body: some View {
        switch phase {
        case .waiting:
            Image(systemName: "exclamationmark.shield.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.orange)
        case .thinking:
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .scaleEffect(pulsing ? 1.12 : 0.88)
                .opacity(pulsing ? 1.0 : 0.6)
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                        pulsing = true
                    }
                }
        case .tool, .working, .writing:
            ZStack {
                Circle()
                    .stroke(Color.primary.opacity(0.16), lineWidth: 1.6)
                    .frame(width: 14, height: 14)
                Circle()
                    .trim(from: 0, to: 0.34)
                    .stroke(Color.primary, style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
                    .frame(width: 14, height: 14)
                    .rotationEffect(.degrees(spinning ? 360 : 0))
                Circle()
                    .fill(Color.primary.opacity(0.75))
                    .frame(width: 3.5, height: 3.5)
            }
            .onAppear {
                withAnimation(.linear(duration: 0.95).repeatForever(autoreverses: false)) {
                    spinning = true
                }
            }
        }
    }
}

// MARK: - 3. Collapsible Reasoning View (`Thinking for Xs` -> `Thought for Xs`)

public struct ReasoningRowView: View {
    public let rawText: String
    public let startedAt: Date?
    public let durationMs: Int?
    public let isStreaming: Bool

    @State private var isExpanded: Bool = false

    public var body: some View {
        let parsed = VeloFormatting.parseReasoning(rawText)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard !parsed.lines.isEmpty else { return }
                withAnimation(.snappy(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isStreaming ? "sparkles" : (isExpanded ? "chevron.down" : "brain"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(isStreaming ? .primary : .secondary)
                        .frame(width: 16)

                    if isStreaming {
                        TimelineView(.periodic(from: .now, by: 1.0)) { ctx in
                            let elapsedMs = Int(max(0, ctx.date.timeIntervalSince(startedAt ?? ctx.date)) * 1000)
                            let label = elapsedMs >= 1000
                                ? "Thinking for \(VeloFormatting.formatDuration(ms: elapsedMs))"
                                : "Thinking…"
                            ShimmerTextView(
                                parsed.summary.isEmpty ? label : "\(label) · \(parsed.summary)",
                                font: .system(size: 13, weight: .medium)
                            )
                            .lineLimit(1)
                        }
                    } else {
                        let base = (durationMs ?? 0) >= 500
                            ? "Thought for \(VeloFormatting.formatDuration(ms: durationMs!))"
                            : "Thought"
                        Text(parsed.summary.isEmpty ? base : "\(base) · \(parsed.summary)")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded && !parsed.lines.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(parsed.lines.enumerated()), id: \.offset) { _, line in
                        let cleanLine = line.replacingOccurrences(of: "**", with: "")
                        Text(cleanLine)
                            .font(.system(size: 12.5, weight: line.hasPrefix("**") ? .semibold : .regular))
                            .foregroundStyle(line.hasPrefix("**") ? .primary : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Color.primary.opacity(0.12))
                        .frame(width: 1.5)
                        .padding(.leading, 6)
                }
            }
        }
    }
}

// MARK: - 4. Expandable Native Tool Call Row

public struct ToolCallRowView: View {
    public let toolName: String
    public let displayName: String
    public let workingVerb: String
    public let summary: String
    public let output: String?
    public let isError: Bool

    @State private var expanded: Bool = false

    private var isRunning: Bool { output == nil }

    private var iconName: String {
        VeloFormatting.presentTool(toolName: toolName, argsDict: nil, output: output).iconSystemName
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isError ? "exclamationmark.triangle.fill" : (expanded ? "chevron.down" : iconName))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(isError ? .red : .secondary)
                        .frame(width: 16)

                    if isRunning {
                        ShimmerTextView(workingVerb, font: .system(size: 13, weight: .medium))
                            .lineLimit(1)
                    } else {
                        Text(displayName)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                        if !summary.isEmpty {
                            Text(summary)
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 0)
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    if !summary.isEmpty {
                        Text(summary)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(.primary)
                    }
                    if let output, !output.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(String(output.prefix(2400)))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(isError ? .red : .secondary)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 180)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}

// MARK: - 5. Live Turn Status Footer (`Thinking for Xs…` / `Working… · 50s` -> `Worked for 1m 2s`)

public struct TurnStatusFooterView: View {
    public let isRunning: Bool
    public let phase: AgentLivePhase
    public let startedAt: Date?
    public let durationMs: Int?
    public let completedAt: String?
    public let assistantText: String?
    public let onRetry: (() -> Void)?

    @State private var copied = false

    public var body: some View {
        if isRunning {
            TimelineView(.periodic(from: .now, by: 1.0)) { ctx in
                let elapsedMs = max(0, Int(ctx.date.timeIntervalSince(startedAt ?? ctx.date) * 1000))
                let formattedClock = VeloFormatting.formatDuration(ms: elapsedMs)

                HStack(spacing: 7) {
                    OrbitalStatusIcon(phase: phase)

                    switch phase {
                    case .waiting(let label):
                        Text(label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.orange)
                    case .thinking:
                        let label = elapsedMs >= 1000
                            ? "Thinking for \(formattedClock)…"
                            : "Thinking…"
                        ShimmerTextView(label, font: .system(size: 13, weight: .medium))
                    case .tool(let verb):
                        ShimmerTextView("Working · \(verb)…", font: .system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Text("· \(formattedClock)")
                            .font(.system(size: 12.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    case .writing:
                        ShimmerTextView("Writing…", font: .system(size: 13, weight: .medium))
                        Text("· \(formattedClock)")
                            .font(.system(size: 12.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    case .working:
                        ShimmerTextView("Working…", font: .system(size: 13, weight: .medium))
                        Text("· \(formattedClock)")
                            .font(.system(size: 12.5).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 4)
            }
        } else if assistantText != nil || durationMs != nil || onRetry != nil {
            HStack(spacing: 10) {
                if let assistantText, !assistantText.isEmpty {
                    Button {
                        UIPasteboard.general.string = assistantText
                        copied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            copied = false
                        }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(copied ? .green : .secondary)
                    }
                    .buttonStyle(.plain)
                }

                if let onRetry {
                    Button(action: onRetry) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                if let durationMs, durationMs > 0 {
                    Text("Worked for \(VeloFormatting.formatDuration(ms: durationMs))")
                        .font(.system(size: 12.5).monospacedDigit())
                        .foregroundStyle(.secondary)
                } else if let completedAt, !completedAt.isEmpty {
                    Text(completedAt)
                        .font(.system(size: 12.5).monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 2)
        }
    }
}
