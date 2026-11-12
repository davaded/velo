import SwiftUI
import UIKit

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
                                onRequestMacLogin: { provider in
                                    await store.requestMacCLILogin(provider: provider)
                                },
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
                .onChange(of: session?.model) { _, newModel in
                    if let newModel, !newModel.isEmpty {
                        selectedModelId = newModel
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
    let onRequestMacLogin: (String) async -> Bool
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

    private var hasErrorWithoutAnswer: Bool {
        guard lastAssistantText == nil else { return false }
        return turn.items.contains {
            if case .error = $0.kind { return true }
            return false
        }
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
                    NativeMarkdownView(markdown: item.content)

                case .error(let isAuthRequired, let provider, let loginCommand, let authURL):
                    AgentErrorBannerView(
                        message: item.content,
                        isAuthRequired: isAuthRequired,
                        provider: provider,
                        loginCommand: loginCommand,
                        authURL: authURL,
                        onRequestMacLogin: onRequestMacLogin,
                        onRetry: (!isTurnRunning && isLast) ? onRetry : nil
                    )

                case .user:
                    EmptyView()
                }
            }

            // 3. Live / Completed Turn Status Footer
            if !hasErrorWithoutAnswer || isTurnRunning {
                TurnStatusFooterView(
                    isRunning: isTurnRunning,
                    phase: computedPhase,
                    startedAt: turnStartedAt,
                    durationMs: hasErrorWithoutAnswer ? nil : turn.userEvent?.durationMs,
                    completedAt: hasErrorWithoutAnswer ? nil : (turn.userEvent?.completedAt ?? turn.items.last?.timestamp),
                    assistantText: lastAssistantText,
                    onRetry: onRetry
                )
            }
        }
    }
}

// MARK: - CLI Auth Loss & Execution Error Card

private struct AgentErrorBannerView: View {
    let message: String
    let isAuthRequired: Bool
    let provider: String
    let loginCommand: String
    let authURL: String?
    let onRequestMacLogin: (String) async -> Bool
    let onRetry: (() -> Void)?

    @State private var isLaunchingLogin = false
    @State private var loginTriggered = false
    @State private var copiedCmd = false

    private var accent: Color {
        isAuthRequired ? .orange : .red
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: isAuthRequired ? "lock.trianglebadge.exclamationmark.fill" : "exclamationmark.octagon.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(accent)

                Text(isAuthRequired ? "CLI 认证已失效 · 需要重新登录" : "CLI 执行异常")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.primary)

                Spacer(minLength: 4)

                Text(VeloFormatting.providerDisplayName(provider))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(accent)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(accent.opacity(0.14), in: Capsule())
            }

            Text(message)
                .font(.system(size: 13.5))
                .foregroundStyle(.secondary)
                .lineSpacing(2.5)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if isAuthRequired && !loginCommand.isEmpty {
                HStack(spacing: 8) {
                    Text("$ \(loginCommand)")
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    Button {
                        UIPasteboard.general.string = loginCommand
                        copiedCmd = true
                        Task {
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            copiedCmd = false
                        }
                    } label: {
                        Image(systemName: copiedCmd ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(copiedCmd ? .green : .secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }

            HStack(spacing: 8) {
                if isAuthRequired {
                    Button {
                        guard !isLaunchingLogin else { return }
                        isLaunchingLogin = true
                        Task {
                            let ok = await onRequestMacLogin(provider)
                            isLaunchingLogin = false
                            if ok {
                                loginTriggered = true
                                try? await Task.sleep(nanoseconds: 4_000_000_000)
                                loginTriggered = false
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: loginTriggered ? "checkmark.circle.fill" : "terminal.fill")
                                .font(.system(size: 12, weight: .semibold))
                            Text(loginTriggered ? "已在 Mac 打开终端登录" : "在 Mac 终端拉起登录")
                                .font(.system(size: 12.5, weight: .semibold))
                        }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .foregroundStyle(loginTriggered ? Color.green : Color.white)
                        .background(
                            loginTriggered ? Color.green.opacity(0.16) : Color.orange,
                            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                        )
                    }
                    .buttonStyle(.plain)

                    if let authURL, let url = URL(string: authURL) {
                        Link(destination: url) {
                            HStack(spacing: 4) {
                                Text("授权网页")
                                Image(systemName: "arrow.up.right")
                                    .font(.system(size: 10.5, weight: .bold))
                            }
                            .font(.system(size: 12.5, weight: .medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .foregroundStyle(.primary)
                            .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        }
                    }
                }

                if let onRetry {
                    Button(action: onRetry) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text("重试")
                                .font(.system(size: 12.5, weight: .medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .foregroundStyle(.primary)
                        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }

                Spacer(minLength: 0)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(accent.opacity(0.42), lineWidth: 1)
        )
        .padding(.vertical, 2)
    }
}

// MARK: - Apple-Grade Native Block + Inline GFM Markdown Renderer

private struct NativeMarkdownView: View {
    let markdown: String

    fileprivate enum ListMarker: Equatable {
        case bullet
        case ordered(String)
        case task(checked: Bool)
    }

    fileprivate struct ListEntry: Identifiable, Equatable {
        let id: Int
        let depth: Int
        let marker: ListMarker
        var text: String
    }

    fileprivate enum Block: Identifiable, Equatable {
        case heading(id: Int, level: Int, text: String)
        case paragraph(id: Int, text: String)
        case list(id: Int, items: [ListEntry])
        case blockquote(id: Int, text: String)
        case codeBlock(id: Int, language: String, code: String)
        case table(id: Int, headers: [String], alignments: [Alignment], rows: [[String]])
        case horizontalRule(id: Int)

        var id: Int {
            switch self {
            case .heading(let id, _, _),
                 .paragraph(let id, _),
                 .list(let id, _),
                 .blockquote(let id, _),
                 .codeBlock(let id, _, _),
                 .table(let id, _, _, _),
                 .horizontalRule(let id):
                return id
            }
        }
    }

    private var blocks: [Block] {
        Self.parseBlocks(markdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block {
                case .heading(_, let level, let text):
                    HeadingBlockView(level: level, text: text)

                case .paragraph(_, let text):
                    InlineMarkdownText(text: text, baseSize: 15, baseWeight: .regular, lineSpacing: 3.5)

                case .list(_, let items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(items) { item in
                            MarkdownListRowView(entry: item)
                        }
                    }

                case .blockquote(_, let text):
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.accentColor.opacity(0.65))
                            .frame(width: 3)
                        InlineMarkdownText(
                            text: text,
                            baseSize: 14.5,
                            baseWeight: .regular,
                            secondary: true,
                            lineSpacing: 3
                        )
                        .padding(.vertical, 1)
                    }
                    .padding(.vertical, 2)

                case .codeBlock(_, let language, let code):
                    FencedCodeCardView(language: language, code: code)

                case .table(_, let headers, let alignments, let rows):
                    MarkdownTableCardView(headers: headers, alignments: alignments, rows: rows)

                case .horizontalRule:
                    Divider()
                        .padding(.vertical, 4)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Block Parser

    private static func parseBlocks(_ raw: String) -> [Block] {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var result: [Block] = []
        var nextId = 0
        var idx = 0

        var paragraphBuffer: [String] = []
        func flushParagraph() {
            let joined = paragraphBuffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                result.append(.paragraph(id: nextId, text: joined))
                nextId += 1
            }
            paragraphBuffer.removeAll()
        }

        while idx < lines.count {
            let line = lines[idx]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // 1. Blank line terminates open paragraph
            if trimmed.isEmpty {
                flushParagraph()
                idx += 1
                continue
            }

            // 2. Fenced Code Block (``` or ~~~)
            if let (fence, lang) = parseFenceOpen(line) {
                flushParagraph()
                idx += 1
                var codeLines: [String] = []
                while idx < lines.count {
                    let candidate = lines[idx].trimmingCharacters(in: .whitespaces)
                    if candidate.hasPrefix(fence) && candidate.dropFirst(fence.count).trimmingCharacters(in: .whitespaces).isEmpty {
                        idx += 1
                        break
                    }
                    codeLines.append(lines[idx])
                    idx += 1
                }
                result.append(.codeBlock(id: nextId, language: lang, code: codeLines.joined(separator: "\n")))
                nextId += 1
                continue
            }

            // 3. GFM Pipe Table
            if idx + 1 < lines.count,
               isTableRow(line),
               isTableSeparator(lines[idx + 1])
            {
                flushParagraph()
                let headers = splitTableCells(line)
                let colCount = max(1, headers.count)
                let alignments = parseTableAlignments(lines[idx + 1], count: colCount)
                idx += 2
                var rows: [[String]] = []
                while idx < lines.count, isTableRow(lines[idx]), !isTableSeparator(lines[idx]) {
                    var cells = splitTableCells(lines[idx])
                    if cells.count < colCount {
                        cells.append(contentsOf: Array(repeating: "", count: colCount - cells.count))
                    } else if cells.count > colCount {
                        cells = Array(cells.prefix(colCount))
                    }
                    rows.append(cells)
                    idx += 1
                }
                result.append(.table(id: nextId, headers: headers, alignments: alignments, rows: rows))
                nextId += 1
                continue
            }

            // 4. Horizontal Rule (`---`, `***`, `___`)
            if isHorizontalRule(trimmed) {
                flushParagraph()
                result.append(.horizontalRule(id: nextId))
                nextId += 1
                idx += 1
                continue
            }

            // 5. ATX Heading (`#` .. `######`)
            if let (level, headingText) = parseHeading(line) {
                flushParagraph()
                result.append(.heading(id: nextId, level: level, text: headingText))
                nextId += 1
                idx += 1
                continue
            }

            // 6. Blockquote (`> ...`)
            if let firstQuote = parseBlockquoteLine(line) {
                flushParagraph()
                var quoteLines: [String] = [firstQuote]
                idx += 1
                while idx < lines.count, let nextQuote = parseBlockquoteLine(lines[idx]) {
                    quoteLines.append(nextQuote)
                    idx += 1
                }
                result.append(.blockquote(id: nextId, text: quoteLines.joined(separator: "\n")))
                nextId += 1
                continue
            }

            // 7. Ordered / Unordered / Task List
            if let firstItem = parseListLine(line, id: 0) {
                flushParagraph()
                var listItems: [ListEntry] = [firstItem]
                var itemId = 1
                idx += 1
                while idx < lines.count {
                    let nextLine = lines[idx]
                    let nextTrim = nextLine.trimmingCharacters(in: .whitespaces)
                    if nextTrim.isEmpty {
                        // Allow single blank line inside a loose list if next line is another list item
                        if idx + 1 < lines.count, parseListLine(lines[idx + 1], id: itemId) != nil {
                            idx += 1
                            continue
                        }
                        break
                    }
                    if parseFenceOpen(nextLine) != nil
                        || isHorizontalRule(nextTrim)
                        || parseHeading(nextLine) != nil
                        || parseBlockquoteLine(nextLine) != nil
                    {
                        break
                    }
                    if let parsedNext = parseListLine(nextLine, id: itemId) {
                        listItems.append(parsedNext)
                        itemId += 1
                        idx += 1
                    } else if nextLine.hasPrefix("  ") || nextLine.hasPrefix("\t") {
                        // Indented continuation line belonging to previous list item
                        listItems[listItems.count - 1].text += "\n" + nextTrim
                        idx += 1
                    } else {
                        break
                    }
                }
                result.append(.list(id: nextId, items: listItems))
                nextId += 1
                continue
            }

            // 8. Normal Paragraph Line
            paragraphBuffer.append(line)
            idx += 1
        }

        flushParagraph()
        return result
    }

    private static func parseFenceOpen(_ line: String) -> (fence: String, lang: String)? {
        let trimmedLead = line.drop(while: { $0 == " " })
        guard line.count - trimmedLead.count <= 3 else { return nil }
        if trimmedLead.hasPrefix("```") {
            let info = trimmedLead.dropFirst(3).trimmingCharacters(in: .whitespaces)
            let lang = info.components(separatedBy: .whitespaces).first ?? ""
            return ("```", lang)
        }
        if trimmedLead.hasPrefix("~~~") {
            let info = trimmedLead.dropFirst(3).trimmingCharacters(in: .whitespaces)
            let lang = info.components(separatedBy: .whitespaces).first ?? ""
            return ("~~~", lang)
        }
        return nil
    }

    private static func isHorizontalRule(_ trimmed: String) -> Bool {
        guard trimmed.count >= 3 else { return false }
        for marker in [Character("-"), Character("*"), Character("_")] {
            var count = 0
            var valid = true
            for ch in trimmed {
                if ch == marker {
                    count += 1
                } else if ch != " " {
                    valid = false
                    break
                }
            }
            if valid && count >= 3 { return true }
        }
        return false
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        let sub = line.drop(while: { $0 == " " })
        guard line.count - sub.count <= 3 else { return nil }
        var hashes = 0
        for ch in sub {
            if ch == "#" { hashes += 1 } else { break }
        }
        guard (1...6).contains(hashes) else { return nil }
        let rest = sub.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
        var clean = rest.trimmingCharacters(in: .whitespaces)
        while clean.hasSuffix("#") {
            clean.removeLast()
        }
        clean = clean.trimmingCharacters(in: .whitespaces)
        return clean.isEmpty ? nil : (hashes, clean)
    }

    private static func parseBlockquoteLine(_ line: String) -> String? {
        let sub = line.drop(while: { $0 == " " })
        guard line.count - sub.count <= 3, sub.first == ">" else { return nil }
        var rest = sub.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    private static func parseListLine(_ line: String, id: Int) -> ListEntry? {
        var spaces = 0
        var idx = line.startIndex
        while idx < line.endIndex {
            if line[idx] == " " {
                spaces += 1
            } else if line[idx] == "\t" {
                spaces += 2
            } else {
                break
            }
            idx = line.index(after: idx)
        }
        let depth = min(4, spaces / 2)
        let rest = line[idx...]

        // Unordered (`- `, `* `, `+ `)
        if rest.hasPrefix("- ") || rest.hasPrefix("* ") || rest.hasPrefix("+ ") {
            let afterBullet = String(rest.dropFirst(2))
            if afterBullet.hasPrefix("[x] ") || afterBullet.hasPrefix("[X] ") {
                return ListEntry(
                    id: id,
                    depth: depth,
                    marker: .task(checked: true),
                    text: String(afterBullet.dropFirst(4))
                )
            }
            if afterBullet.hasPrefix("[ ] ") {
                return ListEntry(
                    id: id,
                    depth: depth,
                    marker: .task(checked: false),
                    text: String(afterBullet.dropFirst(4))
                )
            }
            return ListEntry(id: id, depth: depth, marker: .bullet, text: afterBullet)
        }

        // Ordered (`1. `, `2) `)
        var digitEnd = rest.startIndex
        var digitCount = 0
        while digitEnd < rest.endIndex, rest[digitEnd].isNumber, digitCount < 5 {
            digitEnd = rest.index(after: digitEnd)
            digitCount += 1
        }
        if digitCount > 0, digitEnd < rest.endIndex {
            let punct = rest[digitEnd]
            let afterPunct = rest.index(after: digitEnd)
            if (punct == "." || punct == ")"), afterPunct < rest.endIndex, rest[afterPunct] == " " {
                let digits = String(rest[..<digitEnd])
                let content = String(rest[rest.index(after: afterPunct)...])
                return ListEntry(id: id, depth: depth, marker: .ordered("\(digits)."), text: content)
            }
        }

        return nil
    }

    private static func isTableRow(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.contains("|") && t.count >= 3
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("|") && t.contains("-") else { return false }
        let cells = splitTableCells(t)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let c = cell.trimmingCharacters(in: .whitespaces)
            guard !c.isEmpty else { return false }
            let core = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return core.count >= 3 && core.allSatisfy { $0 == "-" }
        }
    }

    private static func splitTableCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func parseTableAlignments(_ line: String, count: Int) -> [Alignment] {
        let raw = splitTableCells(line)
        var out: [Alignment] = []
        for i in 0..<count {
            let spec = i < raw.count ? raw[i].trimmingCharacters(in: .whitespaces) : ""
            if spec.hasPrefix(":") && spec.hasSuffix(":") {
                out.append(.center)
            } else if spec.hasSuffix(":") {
                out.append(.trailing)
            } else {
                out.append(.leading)
            }
        }
        return out
    }
}

private struct HeadingBlockView: View {
    let level: Int
    let text: String

    private var fontSize: CGFloat {
        switch level {
        case 1: return 19.5
        case 2: return 17.5
        case 3: return 16.0
        case 4: return 15.0
        default: return 14.5
        }
    }

    private var fontWeight: Font.Weight {
        level <= 2 ? .bold : .semibold
    }

    var body: some View {
        InlineMarkdownText(
            text: text,
            baseSize: fontSize,
            baseWeight: fontWeight,
            secondary: level >= 6,
            lineSpacing: 2.5
        )
        .padding(.top, level <= 2 ? 4 : 2)
    }
}

private struct MarkdownListRowView: View {
    let entry: NativeMarkdownView.ListEntry

    private var bulletSymbol: String {
        switch entry.depth {
        case 0: return "•"
        case 1: return "◦"
        default: return "▪"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            switch entry.marker {
            case .bullet:
                Text(bulletSymbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 12, alignment: .center)

            case .ordered(let num):
                Text(num)
                    .font(.system(size: 14, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 18, alignment: .trailing)

            case .task(let checked):
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(checked ? Color.accentColor : Color.secondary)
                    .frame(minWidth: 16, alignment: .center)
            }

            InlineMarkdownText(
                text: entry.text,
                baseSize: 15,
                baseWeight: .regular,
                lineSpacing: 3
            )
        }
        .padding(.leading, CGFloat(entry.depth) * 14)
    }
}

private struct FencedCodeCardView: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language.lowercased())
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11, weight: .semibold))
                        Text(copied ? "已复制" : "复制")
                            .font(.system(size: 11.5, weight: .medium))
                    }
                    .foregroundStyle(copied ? .green : .secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color(.tertiarySystemFill).opacity(0.65))

            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(2.5)
                    .padding(12)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.8)
        )
    }
}

private struct MarkdownTableCardView: View {
    let headers: [String]
    let alignments: [Alignment]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { colIdx, title in
                        InlineMarkdownText(
                            text: title,
                            baseSize: 13,
                            baseWeight: .semibold,
                            lineSpacing: 2
                        )
                        .padding(.horizontal, 11)
                        .padding(.vertical, 8)
                        .frame(minWidth: 72, maxWidth: 260, alignment: alignments[safe: colIdx] ?? .leading)
                    }
                }
                .background(Color(.tertiarySystemFill))

                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    Divider()
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { colIdx, cell in
                            InlineMarkdownText(
                                text: cell.isEmpty ? " " : cell,
                                baseSize: 13,
                                baseWeight: .regular,
                                lineSpacing: 2
                            )
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7)
                            .frame(minWidth: 72, maxWidth: 260, alignment: alignments[safe: colIdx] ?? .leading)
                        }
                    }
                    .background(rowIdx.isMultiple(of: 2) ? Color.clear : Color(.tertiarySystemFill).opacity(0.35))
                }
            }
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.primary.opacity(0.1), lineWidth: 0.8)
            )
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct InlineMarkdownText: View {
    let text: String
    var baseSize: CGFloat = 15
    var baseWeight: Font.Weight = .regular
    var secondary: Bool = false
    var lineSpacing: CGFloat = 3.5

    var body: some View {
        Text(Self.buildAttributed(text, baseSize: baseSize, baseWeight: baseWeight, secondary: secondary))
            .lineSpacing(lineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private static func buildAttributed(
        _ raw: String,
        baseSize: CGFloat,
        baseWeight: Font.Weight,
        secondary: Bool
    ) -> AttributedString {
        guard var attributed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            var plain = AttributedString(raw)
            plain.font = .system(size: baseSize, weight: baseWeight)
            if secondary {
                plain.foregroundColor = .secondary
            }
            return plain
        }

        let runs = Array(attributed.runs)
        for run in runs {
            let range = run.range
            let intents = run.inlinePresentationIntent

            if intents?.contains(.code) == true {
                attributed[range].font = .system(
                    size: max(12.0, (baseSize * 0.88).rounded(.toNearestOrEven)),
                    weight: .medium,
                    design: .monospaced
                )
                attributed[range].backgroundColor = Color(.tertiarySystemFill)
            } else {
                let isBold = intents?.contains(.stronglyEmphasized) == true
                let isItalic = intents?.contains(.emphasized) == true
                var font = Font.system(size: baseSize, weight: isBold ? .bold : baseWeight)
                if isItalic {
                    font = font.italic()
                }
                attributed[range].font = font
            }

            if intents?.contains(.strikethrough) == true {
                attributed[range].strikethroughStyle = .single
            }

            if run.link != nil {
                attributed[range].foregroundColor = .accentColor
                attributed[range].underlineStyle = .single
            } else if secondary {
                attributed[range].foregroundColor = .secondary
            }
        }

        return attributed
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
