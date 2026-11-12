import SwiftUI

public struct ChatThreadView: View {
    @ObservedObject var store: VeloStore
    let sessionId: String

    @State private var draftPrompt: String = ""
    @State private var selectedModelId: String = "claude-fable-5-2"
    @State private var selectedEffort: String = "medium"
    @State private var showDiffSheet: Bool = false
    @FocusState private var composerFocused: Bool

    public init(store: VeloStore, sessionId: String) {
        self.store = store
        self.sessionId = sessionId
    }

    private var session: VeloSessionItem? {
        store.sessions.first(where: { $0.id == sessionId })
    }

    private var turns: [ConversationTurnBlock] {
        VeloStore.groupIntoTurns(store.eventsBySession[sessionId] ?? [])
    }

    private var isSessionRunning: Bool {
        guard let st = session?.status else { return false }
        return st == .running || st == .waitingApproval
    }

    public var body: some View {
        VStack(spacing: 0) {
            // 1. Chronological Native Turn Stream
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if turns.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "terminal")
                                    .font(.system(size: 30, weight: .light))
                                    .foregroundStyle(.secondary)
                                Text(session?.branchName ?? "Ready")
                                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                                Text("在下方输入需求，Agent 将在 Mac 隔离 Git Worktree 中自主执行并实时流式同步。")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, 28)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 70)
                        }

                        ForEach(Array(turns.enumerated()), id: \.element.id) { idx, turn in
                            let isLatest = idx == turns.count - 1
                            let turnRunning = isLatest && isSessionRunning

                            TurnBlockView(
                                turn: turn,
                                isTurnRunning: turnRunning,
                                turnStartedAt: isLatest ? store.turnStartedAtBySession[sessionId] : nil,
                                waitingApproval: isLatest ? store.pendingApprovals[sessionId] : nil,
                                waitingQuestion: isLatest ? store.pendingQuestions[sessionId] : nil,
                                onRetry: (!isSessionRunning && turn.userEvent != nil) ? {
                                    if let text = turn.userEvent?.content {
                                        Task {
                                            await store.sendPrompt(
                                                sessionId: sessionId,
                                                text: text,
                                                model: selectedModelId,
                                                effort: selectedEffort
                                            )
                                        }
                                    }
                                } : nil
                            )
                        }

                        // Live Interactive Permission Approval Card
                        if let approval = store.pendingApprovals[sessionId] {
                            ApprovalPromptCard(
                                prompt: approval,
                                onApprove: {
                                    Task {
                                        await store.resolveApproval(sessionId: sessionId, requestId: approval.id, approve: true)
                                    }
                                },
                                onDeny: {
                                    Task {
                                        await store.resolveApproval(sessionId: sessionId, requestId: approval.id, approve: false)
                                    }
                                }
                            )
                        }

                        // Live Interactive Question Card
                        if let question = store.pendingQuestions[sessionId] {
                            QuestionPromptCard(prompt: question) { chosen in
                                Task {
                                    await store.answerQuestion(sessionId: sessionId, questionId: question.id, answers: chosen)
                                }
                            }
                        }

                        Color.clear
                            .frame(height: 4)
                            .id("BOTTOM_ANCHOR")
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 10)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.eventsBySession[sessionId]?.count ?? 0) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("BOTTOM_ANCHOR", anchor: .bottom)
                    }
                }
                .onAppear {
                    if let s = session {
                        selectedModelId = s.model
                        selectedEffort = s.effort
                    }
                    Task {
                        await store.loadEventsForSession(sessionId)
                        proxy.scrollTo("BOTTOM_ANCHOR", anchor: .bottom)
                    }
                }
            }

            Divider()

            // 2. Native iOS Composer Dock (Model + Effort + Multi-line Input + Send / Stop)
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    // Model Menu Picker
                    Menu {
                        ForEach(store.models) { m in
                            Button {
                                selectedModelId = m.id
                            } label: {
                                HStack {
                                    Text(m.label)
                                    if m.id == selectedModelId {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "cpu")
                                .font(.system(size: 11))
                            Text(store.models.first(where: { $0.id == selectedModelId })?.shortLabel ?? VeloModelOption.shortLabel(for: selectedModelId))
                                .font(.system(size: 12, weight: .medium))
                                .lineLimit(1)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 9.5, weight: .semibold))
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color(.secondarySystemBackground), in: Capsule())
                    }

                    // Effort Menu Picker
                    Menu {
                        ForEach(["low", "medium", "high", "max"], id: \.self) { level in
                            Button {
                                selectedEffort = level
                            } label: {
                                HStack {
                                    Text("Effort: \(level.capitalized)")
                                    if level == selectedEffort {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "gauge.with.dots.needle.67percent")
                                .font(.system(size: 11))
                            Text(selectedEffort.capitalized)
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Color(.secondarySystemBackground), in: Capsule())
                    }

                    Spacer()

                    if let s = session, s.insertions > 0 || s.deletions > 0 {
                        Button {
                            showDiffSheet = true
                            Task { await store.fetchDiff(for: sessionId) }
                        } label: {
                            HStack(spacing: 4) {
                                Text("+\(s.insertions)")
                                    .foregroundStyle(.green)
                                Text("−\(s.deletions)")
                                    .foregroundStyle(.red)
                            }
                            .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                    }
                }

                HStack(alignment: .bottom, spacing: 8) {
                    TextField("发消息给 Mac 上的 Agent…", text: $draftPrompt, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .font(.system(size: 15))
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                    if isSessionRunning && draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            Task { await store.stopSession(sessionId) }
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color.red, in: Circle())
                        }
                    } else {
                        let canSend = !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        Button {
                            let toSend = draftPrompt
                            draftPrompt = ""
                            composerFocused = false
                            Task {
                                await store.sendPrompt(
                                    sessionId: sessionId,
                                    text: toSend,
                                    model: selectedModelId,
                                    effort: selectedEffort
                                )
                            }
                        } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? Color(.systemBackground) : .secondary)
                                .frame(width: 36, height: 36)
                                .background(canSend ? Color.primary : Color(.tertiarySystemFill), in: Circle())
                        }
                        .disabled(!canSend)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.bar)
        }
        .navigationTitle(session?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showDiffSheet = true
                    Task { await store.fetchDiff(for: sessionId) }
                } label: {
                    Image(systemName: "arrow.left.arrow.right.square")
                }
            }
        }
        .sheet(isPresented: $showDiffSheet) {
            DiffViewerSheet(
                branchName: session?.branchName ?? "worktree",
                files: store.diffsBySession[sessionId] ?? []
            )
        }
    }
}

// MARK: - Single Conversation Turn Block

private struct TurnBlockView: View {
    let turn: ConversationTurnBlock
    let isTurnRunning: Bool
    let turnStartedAt: Date?
    let waitingApproval: PendingApprovalPrompt?
    let waitingQuestion: PendingQuestionPrompt?
    let onRetry: (() -> Void)?

    private var computedPhase: AgentLivePhase {
        if let approval = waitingApproval {
            return .waiting(label: "Waiting for approval (\(approval.toolName))")
        }
        if waitingQuestion != nil {
            return .waiting(label: "Waiting for your answer")
        }
        guard let last = turn.items.last else {
            return .thinking
        }
        switch last.kind {
        case .thinking(_, _, true):
            return .working
        case .toolCall(_, _, let workingVerb, _, let output, _):
            return output == nil ? .tool(verb: workingVerb) : .working
        case .assistant(let isStreaming):
            return isStreaming ? .writing : .working
        default:
            return .working
        }
    }

    private var lastAssistantText: String? {
        for item in turn.items.reversed() {
            if case .assistant = item.kind, !item.content.isEmpty {
                return item.content
            }
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 1. User Right-Aligned Bubble
            if let userEv = turn.userEvent {
                HStack {
                    Spacer(minLength: 48)
                    Text(userEv.content)
                        .font(.system(size: 15))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Color(.secondarySystemFill), in: UnevenRoundedRectangle(
                            topLeadingRadius: 18,
                            bottomLeadingRadius: 18,
                            bottomTrailingRadius: 18,
                            topTrailingRadius: 5
                        ))
                        .textSelection(.enabled)
                }
            }

            // 2. Chronological Agent Items
            ForEach(Array(turn.items.enumerated()), id: \.element.id) { idx, item in
                let isLast = idx == turn.items.count - 1

                switch item.kind {
                case .thinking(let startedAt, let durationMs, let isStreaming):
                    ReasoningRowView(
                        rawText: item.content,
                        startedAt: startedAt ?? turnStartedAt,
                        durationMs: durationMs,
                        isStreaming: isStreaming && isTurnRunning && isLast
                    )

                case .toolCall(let toolName, let displayName, let workingVerb, let summary, let output, let isError):
                    ToolCallRowView(
                        toolName: toolName,
                        displayName: displayName,
                        workingVerb: workingVerb,
                        summary: summary,
                        output: output,
                        isError: isError
                    )

                case .assistant:
                    MarkdownParagraphsView(markdown: item.content)

                case .user:
                    EmptyView()
                }
            }

            // 3. Live / Completed Turn Status Footer
            TurnStatusFooterView(
                isRunning: isTurnRunning,
                phase: computedPhase,
                startedAt: turnStartedAt,
                durationMs: turn.userEvent?.durationMs,
                completedAt: turn.userEvent?.completedAt ?? turn.items.last?.timestamp,
                assistantText: lastAssistantText,
                onRetry: onRetry
            )
        }
    }
}

// MARK: - Clean Native Markdown + Fenced Code Block Renderer

private struct MarkdownParagraphsView: View {
    let markdown: String

    private enum Segment: Identifiable {
        case prose(id: Int, text: String)
        case code(id: Int, lang: String, code: String)

        var id: Int {
            switch self {
            case .prose(let id, _), .code(let id, _, _): return id
            }
        }
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        let lines = markdown.components(separatedBy: "\n")
        var inCode = false
        var codeLang = ""
        var buffer: [String] = []
        var nextId = 0

        func flushProse() {
            let text = buffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                result.append(.prose(id: nextId, text: text))
                nextId += 1
            }
            buffer.removeAll()
        }

        func flushCode() {
            let text = buffer.joined(separator: "\n")
            result.append(.code(id: nextId, lang: codeLang, code: text))
            nextId += 1
            buffer.removeAll()
        }

        for line in lines {
            if line.hasPrefix("```") {
                if inCode {
                    flushCode()
                    inCode = false
                    codeLang = ""
                } else {
                    flushProse()
                    inCode = true
                    codeLang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
            } else {
                buffer.append(line)
            }
        }
        if inCode {
            flushCode()
        } else {
            flushProse()
        }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { seg in
                switch seg {
                case .prose(_, let text):
                    if let attributed = try? AttributedString(
                        markdown: text,
                        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                    ) {
                        Text(attributed)
                            .font(.system(size: 15))
                            .lineSpacing(3.5)
                            .textSelection(.enabled)
                    } else {
                        Text(text)
                            .font(.system(size: 15))
                            .lineSpacing(3.5)
                            .textSelection(.enabled)
                    }

                case .code(_, let lang, let code):
                    VStack(alignment: .leading, spacing: 6) {
                        if !lang.isEmpty {
                            Text(lang)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(code)
                                .font(.system(size: 12.5, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Interactive Permission & Question Cards

private struct ApprovalPromptCard: View {
    let prompt: PendingApprovalPrompt
    let onApprove: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(.orange)
                Text("请求执行权限 · \(prompt.toolName)")
                    .font(.system(size: 13.5, weight: .semibold))
            }

            Text(prompt.commandPreview)
                .font(.system(size: 12, design: .monospaced))
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 10) {
                Button(role: .destructive, action: onDeny) {
                    Text("拒绝")
                        .font(.system(size: 13.5, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button(action: onApprove) {
                    Text("允许执行")
                        .font(.system(size: 13.5, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.orange.opacity(0.45), lineWidth: 1)
        )
    }
}

private struct QuestionPromptCard: View {
    let prompt: PendingQuestionPrompt
    let onSubmit: ([String]) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(prompt.question)
                .font(.system(size: 14, weight: .semibold))

            ForEach(prompt.options, id: \.self) { opt in
                Button {
                    onSubmit([opt])
                } label: {
                    HStack {
                        Text(opt)
                            .font(.system(size: 13.5))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - Unified Git Diff Sheet

private struct DiffViewerSheet: View {
    let branchName: String
    let files: [DiffFileSection]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if files.isEmpty {
                    ContentUnavailableView(
                        "工作区暂无未提交变更",
                        systemImage: "checkmark.circle",
                        description: Text("分支 `\(branchName)` 当前与基准一致")
                    )
                } else {
                    List {
                        ForEach(files) { file in
                            Section {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    VStack(alignment: .leading, spacing: 1) {
                                        ForEach(file.lines) { row in
                                            Text(row.text.isEmpty ? " " : row.text)
                                                .font(.system(size: 11.5, design: .monospaced))
                                                .foregroundStyle(color(for: row.kind))
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 1)
                                                .background(bg(for: row.kind))
                                        }
                                    }
                                }
                            } header: {
                                HStack {
                                    Text(file.path)
                                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                        .textCase(nil)
                                    Spacer()
                                    Text("+\(file.additions)")
                                        .foregroundStyle(.green)
                                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                    Text("−\(file.deletions)")
                                        .foregroundStyle(.red)
                                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Worktree Diff")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func color(for kind: DiffLineRow.Kind) -> Color {
        switch kind {
        case .addition: return .green
        case .deletion: return .red
        case .header: return .blue
        case .context: return .secondary
        }
    }

    private func bg(for kind: DiffLineRow.Kind) -> Color {
        switch kind {
        case .addition: return Color.green.opacity(0.1)
        case .deletion: return Color.red.opacity(0.1)
        case .header: return Color.blue.opacity(0.08)
        case .context: return .clear
        }
    }
}
