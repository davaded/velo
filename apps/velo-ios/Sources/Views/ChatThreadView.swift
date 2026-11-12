import SwiftUI
import UIKit

public struct ChatThreadView: View {
    @ObservedObject var store: VeloStore
    let sessionId: String
    var onSwitchedSession: ((String) -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @State private var draftPrompt: String = ""
    @State private var selectedModelId: String = "claude-fable-5-2"
    @State private var selectedEffort: String = "medium"
    @State private var showDiffSheet: Bool = false
    @State private var showModelSheet: Bool = false
    @FocusState private var composerFocused: Bool

    public init(
        store: VeloStore,
        sessionId: String,
        onSwitchedSession: ((String) -> Void)? = nil
    ) {
        self.store = store
        self.sessionId = sessionId
        self.onSwitchedSession = onSwitchedSession
    }

    private var session: VeloSessionItem? {
        store.sessions.first(where: { $0.id == sessionId })
    }

    private var turns: [ConversationTurnBlock] {
        VeloStore.groupIntoTurns(store.eventsBySession[sessionId] ?? [])
    }

    private var isEngineBound: Bool {
        !turns.isEmpty
    }

    private var isSessionRunning: Bool {
        guard let st = session?.status else { return false }
        return st == .running || st == .waitingApproval
    }

    private var activeModelOption: VeloModelOption {
        if let found = store.models.first(where: { $0.id == selectedModelId }) {
            return found
        }
        if let def = VeloModelOption.defaults.first(where: { $0.id == selectedModelId }) {
            return def
        }
        let cat = session?.engineCategory ?? .claude
        return VeloModelOption(
            id: selectedModelId,
            label: VeloModelOption.shortLabel(for: selectedModelId),
            shortLabel: VeloModelOption.shortLabel(for: selectedModelId),
            family: cat.vendor,
            agentKind: session?.agentKind ?? cat.rawValue
        )
    }

    public var body: some View {
        ZStack {
            VeloTheme.canvas(colorScheme)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // 1. Subtle Specular Context Strip (Bound Engine + Project/Branch + Handoff Origin)
                if let s = session {
                    threadContextBar(s)
                }

                // 2. Chronological Turn Stream
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            if turns.isEmpty {
                                emptyThreadHero
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

                            if let question = store.pendingQuestions[sessionId] {
                                QuestionPromptCard(prompt: question) { chosen in
                                    Task {
                                        await store.answerQuestion(sessionId: sessionId, questionId: question.id, answers: chosen)
                                    }
                                }
                            }

                            Color.clear
                                .frame(height: 6)
                                .id("BOTTOM_ANCHOR")
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 12)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: store.eventsBySession[sessionId]?.count ?? 0) { _, _ in
                        withAnimation(.easeOut(duration: 0.22)) {
                            proxy.scrollTo("BOTTOM_ANCHOR", anchor: .bottom)
                        }
                    }
                    .onChange(of: session?.model) { _, newModel in
                        if let newModel, !newModel.isEmpty {
                            selectedModelId = newModel
                        }
                    }
                    .onChange(of: sessionId) { _, newSid in
                        if let s = store.sessions.first(where: { $0.id == newSid }) {
                            selectedModelId = s.model
                            selectedEffort = s.effort
                        }
                        Task {
                            await store.loadEventsForSession(newSid)
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

                // 3. Floating Specular Composer Card (Rare UI / Beautiful UI)
                floatingComposerDock
            }
        }
        .navigationTitle(session?.title ?? "对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 8) {
                    Button {
                        showModelSheet = true
                    } label: {
                        Image(systemName: "arrow.triangle.swap")
                            .font(.system(size: 13.5, weight: .semibold))
                    }

                    Button {
                        showDiffSheet = true
                        Task { await store.fetchDiff(for: sessionId) }
                    } label: {
                        Image(systemName: "arrow.left.arrow.right.square")
                            .font(.system(size: 14, weight: .semibold))
                    }
                }
            }
        }
        .sheet(isPresented: $showDiffSheet) {
            DiffViewerSheet(
                branchName: session?.branchName ?? "main",
                files: store.diffsBySession[sessionId] ?? []
            )
        }
        .sheet(isPresented: $showModelSheet) {
            ModelAndHandoffSheet(
                store: store,
                session: session,
                isEngineBound: isEngineBound,
                selectedModelId: $selectedModelId,
                selectedEffort: $selectedEffort,
                onSelectInPlace: { chosenModel, effort in
                    selectedModelId = chosenModel.id
                    selectedEffort = effort
                    Task {
                        await store.updateSessionModelAndEffort(
                            sessionId: sessionId,
                            modelOption: chosenModel,
                            effort: effort
                        )
                    }
                },
                onHandoffToEngine: { targetModel, effort in
                    let pendingInstruction = draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
                    draftPrompt = ""
                    composerFocused = false
                    Task {
                        if let createdId = await store.handoffSession(
                            sourceSessionId: sessionId,
                            targetOption: targetModel,
                            effort: effort,
                            instructions: pendingInstruction.isEmpty ? nil : pendingInstruction
                        ) {
                            onSwitchedSession?(createdId)
                        }
                    }
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - Subviews

    private func threadContextBar(_ s: VeloSessionItem) -> some View {
        HStack(spacing: 7) {
            EngineBadgePill(category: s.engineCategory, compact: true)

            HStack(spacing: 3.5) {
                Image(systemName: s.isIsolatedWorktree ? "arrow.triangle.branch" : "folder.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(s.isIsolatedWorktree ? VeloTheme.accentVioletSoft : .secondary)
                Text("\(s.projectName) · \(s.branchName)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if s.parentSessionId != nil {
                Text("↗ 已继承上下文")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(VeloTheme.accentViolet.opacity(0.12), in: Capsule())
            }

            Spacer(minLength: 4)

            if s.insertions > 0 || s.deletions > 0 {
                Button {
                    showDiffSheet = true
                    Task { await store.fetchDiff(for: sessionId) }
                } label: {
                    HStack(spacing: 3) {
                        Text("+\(s.insertions)")
                            .foregroundStyle(VeloTheme.emerald)
                        Text("−\(s.deletions)")
                            .foregroundStyle(VeloTheme.coral)
                    }
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7.5)
        .background(VeloTheme.cardSurface(colorScheme).opacity(0.88))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(VeloTheme.hairline(colorScheme))
                .frame(height: 0.7)
        }
    }

    private var emptyThreadHero: some View {
        let cat = session?.engineCategory ?? activeModelOption.category
        return VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(cat.accentColor.opacity(0.14))
                    .frame(width: 60, height: 60)
                Image(systemName: cat.iconName)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(cat.accentColor)
            }

            Text(activeModelOption.cleanTitle)
                .font(.system(size: 16, weight: .bold))

            if session?.parentSessionId != nil {
                Text("已从前序会话无缝接力。输入下一条指令，\(cat.title) 将自动携带前序上下文与文件变更继续处理。")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .padding(.horizontal, 28)
            } else {
                Text("当前绑定 \(cat.title) 引擎，归属项目 `\(session?.projectName ?? "velo")`。在下方输入指令即可开始。")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .padding(.horizontal, 28)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
    }

    private var floatingComposerDock: some View {
        let cat = activeModelOption.category
        let supportedEfforts = cat.supportedEfforts
        let canSend = !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        return VStack(spacing: 10) {
            TextField("向 \(cat.shortBadge) 发送指令…", text: $draftPrompt, axis: .vertical)
                .lineLimit(1...5)
                .focused($composerFocused)
                .font(.system(size: 15))
                .padding(.horizontal, 4)
                .padding(.top, 2)

            HStack(spacing: 8) {
                // Categorized Model & Handoff Sheet Trigger
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showModelSheet = true
                } label: {
                    HStack(spacing: 5.5) {
                        Image(systemName: cat.iconName)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(cat.accentColor)

                        Text(activeModelOption.cleanTitle)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                    .overlay(
                        Capsule()
                            .stroke(cat.accentColor.opacity(0.28), lineWidth: 0.75)
                    )
                }
                .buttonStyle(VeloPressableButtonStyle())

                // Effort Quick Menu
                Menu {
                    ForEach(supportedEfforts, id: \.self) { level in
                        Button {
                            selectedEffort = level
                            Task {
                                await store.updateSessionModelAndEffort(
                                    sessionId: sessionId,
                                    modelOption: activeModelOption,
                                    effort: level
                                )
                            }
                        } label: {
                            HStack {
                                Text("推理强度 · \(level.uppercased())")
                                if level == selectedEffort {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "dial.medium.fill")
                            .font(.system(size: 10.5))
                        Text(selectedEffort.uppercased())
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }

                Spacer(minLength: 4)

                // Tactile Send / Stop Button
                if isSessionRunning && !canSend {
                    Button {
                        Task { await store.stopSession(sessionId) }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12.5, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(VeloTheme.coral, in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                } else {
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
                            .font(.system(size: 14.5, weight: .bold))
                            .foregroundStyle(canSend ? .white : .secondary.opacity(0.55))
                            .frame(width: 34, height: 34)
                            .background(
                                canSend
                                    ? AnyShapeStyle(
                                        LinearGradient(
                                            colors: [VeloTheme.accentViolet, cat.accentColor],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                                    : AnyShapeStyle(VeloTheme.elevatedSurface(colorScheme)),
                                in: Circle()
                            )
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                    .disabled(!canSend)
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(
            VeloTheme.cardSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 22, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 1)
        )
        .shadow(
            color: Color.black.opacity(colorScheme == .dark ? 0.35 : 0.06),
            radius: 12,
            x: 0,
            y: 4
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}

// MARK: - Categorized Model & Cross-Engine Handoff Half-Sheet

private struct ModelAndHandoffSheet: View {
    @ObservedObject var store: VeloStore
    let session: VeloSessionItem?
    let isEngineBound: Bool
    @Binding var selectedModelId: String
    @Binding var selectedEffort: String
    let onSelectInPlace: (VeloModelOption, String) -> Void
    let onHandoffToEngine: (VeloModelOption, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var currentCategory: VeloEngineCategory {
        session?.engineCategory ?? .claude
    }

    private var groupedCatalog: [(category: VeloEngineCategory, models: [VeloModelOption])] {
        let raw = VeloModelOption.groupedByCategory(store.models)
        return raw.sorted { a, b in
            (a.category == currentCategory ? 0 : 1) < (b.category == currentCategory ? 0 : 1)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        // Effort Selector Card for Current Session
                        VStack(alignment: .leading, spacing: 8) {
                            Text("推理强度 (Effort)")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.secondary)

                            HStack(spacing: 8) {
                                ForEach(currentCategory.supportedEfforts, id: \.self) { lv in
                                    let isSel = selectedEffort == lv
                                    Button {
                                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                        selectedEffort = lv
                                        if let curOpt = store.models.first(where: { $0.id == selectedModelId }) {
                                            onSelectInPlace(curOpt, lv)
                                        }
                                    } label: {
                                        Text(lv.uppercased())
                                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                                            .foregroundStyle(isSel ? .white : .secondary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 8)
                                            .background(
                                                isSel ? currentCategory.accentColor : VeloTheme.cardSurface(colorScheme),
                                                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: isSel ? 0 : 0.8)
                                            )
                                    }
                                    .buttonStyle(VeloPressableButtonStyle())
                                }
                            }
                        }

                        // Categorized Engine Sections
                        ForEach(groupedCatalog, id: \.category.id) { group in
                            let isSameEngine = group.category == currentCategory
                            let requiresHandoff = isEngineBound && !isSameEngine

                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 7) {
                                    EngineBadgePill(category: group.category, compact: false)

                                    Spacer()

                                    if requiresHandoff {
                                        Text("携上下文新建会话 ↗")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(VeloTheme.accentVioletSoft)
                                    } else if isSameEngine && isEngineBound {
                                        Text("当前绑定引擎 · 无损切换")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(VeloTheme.emerald)
                                    } else {
                                        Text("可直接切换")
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundStyle(.secondary)
                                    }
                                }

                                if requiresHandoff && group.category == groupedCatalog.first(where: { $0.category != currentCategory })?.category {
                                    Text("以下为其他厂商引擎。点击任意模型将在同一项目目录新建干净会话并自动继承上下文，保持当前 \(currentCategory.shortBadge) 会话纯净不串台。")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                        .lineSpacing(2)
                                        .padding(.bottom, 2)
                                }

                                VStack(spacing: 6) {
                                    ForEach(group.models) { m in
                                        let isCurrent = m.id == selectedModelId && !requiresHandoff
                                        Button {
                                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                            let eff = group.category.supportedEfforts.contains(selectedEffort)
                                                ? selectedEffort
                                                : (group.category.supportedEfforts.contains("high") ? "high" : "medium")
                                            dismiss()
                                            if requiresHandoff {
                                                onHandoffToEngine(m, eff)
                                            } else {
                                                onSelectInPlace(m, eff)
                                            }
                                        } label: {
                                            HStack(spacing: 10) {
                                                VStack(alignment: .leading, spacing: 2.5) {
                                                    HStack(spacing: 6) {
                                                        Text(m.cleanTitle)
                                                            .font(.system(size: 14, weight: .semibold))
                                                            .foregroundStyle(.primary)
                                                        if m.isDefault {
                                                            Text("默认")
                                                                .font(.system(size: 9.5, weight: .bold))
                                                                .foregroundStyle(group.category.accentColor)
                                                                .padding(.horizontal, 5.5)
                                                                .padding(.vertical, 1.5)
                                                                .background(group.category.accentColor.opacity(0.14), in: Capsule())
                                                        }
                                                    }
                                                    Text(m.cleanSubtitle)
                                                        .font(.system(size: 11.5))
                                                        .foregroundStyle(.secondary)
                                                        .lineLimit(1)
                                                }

                                                Spacer()

                                                if isCurrent {
                                                    Image(systemName: "checkmark.circle.fill")
                                                        .font(.system(size: 16))
                                                        .foregroundStyle(VeloTheme.emerald)
                                                } else if requiresHandoff {
                                                    Text("↗ 接力")
                                                        .font(.system(size: 11.5, weight: .semibold))
                                                        .foregroundStyle(VeloTheme.accentVioletSoft)
                                                        .padding(.horizontal, 8)
                                                        .padding(.vertical, 4)
                                                        .background(VeloTheme.accentViolet.opacity(0.13), in: Capsule())
                                                }
                                            }
                                            .padding(.horizontal, 13)
                                            .padding(.vertical, 10)
                                            .background(
                                                isCurrent
                                                    ? group.category.accentColor.opacity(0.1)
                                                    : VeloTheme.cardSurface(colorScheme),
                                                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                                    .stroke(
                                                        isCurrent
                                                            ? group.category.accentColor.opacity(0.5)
                                                            : VeloTheme.hairline(colorScheme),
                                                        lineWidth: isCurrent ? 1.15 : 0.8
                                                    )
                                            )
                                        }
                                        .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
                                    }
                                }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("模型分类与跨引擎接力")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Single Conversation Turn Block (With Grouped Consecutive Tool Calls!)

private struct TurnBlockView: View {
    let turn: ConversationTurnBlock
    let isTurnRunning: Bool
    let turnStartedAt: Date?
    let waitingApproval: PendingApprovalPrompt?
    let waitingQuestion: PendingQuestionPrompt?
    let onRequestMacLogin: (String) async -> Bool
    let onRetry: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme

    fileprivate enum RenderSegment: Identifiable {
        case single(item: TimelineEventItem, isLastItem: Bool)
        case toolGroup(id: String, items: [TimelineEventItem])

        var id: String {
            switch self {
            case .single(let item, _): return item.id
            case .toolGroup(let id, _): return id
            }
        }
    }

    private var segments: [RenderSegment] {
        var out: [RenderSegment] = []
        var idx = 0
        let total = turn.items.count

        while idx < total {
            let item = turn.items[idx]
            if case .toolCall = item.kind {
                var batch: [TimelineEventItem] = [item]
                var j = idx + 1
                while j < total, case .toolCall = turn.items[j].kind {
                    batch.append(turn.items[j])
                    j += 1
                }
                if batch.count >= 2 {
                    out.append(.toolGroup(id: "tg-\(item.id)", items: batch))
                } else {
                    out.append(.single(item: item, isLastItem: idx == total - 1))
                }
                idx = j
            } else {
                out.append(.single(item: item, isLastItem: idx == total - 1))
                idx += 1
            }
        }
        return out
    }

    private var computedPhase: AgentLivePhase {
        if let approval = waitingApproval {
            return .waiting(label: "等待权限确认 (\(approval.toolName))")
        }
        if waitingQuestion != nil {
            return .waiting(label: "等待你的回答")
        }
        guard let last = turn.items.last else {
            return .thinking
        }
        switch last.kind {
        case .thinking(_, _, true):
            return .thinking
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
        VStack(alignment: .leading, spacing: 10) {
            // 1. User Specular Right-Aligned Bubble
            if let userEv = turn.userEvent {
                HStack {
                    Spacer(minLength: 42)
                    Text(userEv.content)
                        .font(.system(size: 15))
                        .foregroundStyle(.primary)
                        .lineSpacing(3)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            VeloTheme.userBubble(colorScheme),
                            in: UnevenRoundedRectangle(
                                topLeadingRadius: 18,
                                bottomLeadingRadius: 18,
                                bottomTrailingRadius: 18,
                                topTrailingRadius: 5
                            )
                        )
                        .overlay(
                            UnevenRoundedRectangle(
                                topLeadingRadius: 18,
                                bottomLeadingRadius: 18,
                                bottomTrailingRadius: 18,
                                topTrailingRadius: 5
                            )
                            .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.9)
                        )
                        .textSelection(.enabled)
                }
            }

            // 2. Chronological Agent Segments (Reasoning + Grouped Tools + Editorial Markdown)
            ForEach(segments) { seg in
                switch seg {
                case .toolGroup(_, let batch):
                    ToolCallGroupRowView(items: batch)

                case .single(let item, let isLast):
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

                    case .assistant(let isStreaming):
                        VStack(alignment: .leading, spacing: 4) {
                            NativeMarkdownView(markdown: item.content)
                            if isStreaming && isTurnRunning && isLast {
                                StreamingCursorDot()
                            }
                        }

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

    @Environment(\.colorScheme) private var colorScheme
    @State private var isLaunchingLogin = false
    @State private var loginTriggered = false
    @State private var copiedCmd = false

    private var accent: Color {
        isAuthRequired ? VeloTheme.amber : VeloTheme.coral
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: isAuthRequired ? "lock.trianglebadge.exclamationmark.fill" : "exclamationmark.octagon.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(accent)

                Text(isAuthRequired ? "CLI 认证已失效 · 需重新登录" : "CLI 执行异常")
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
                            .foregroundStyle(copiedCmd ? VeloTheme.emerald : .secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(VeloTheme.codeSurface(colorScheme), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
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
                        .foregroundStyle(loginTriggered ? VeloTheme.emerald : Color.black)
                        .background(
                            loginTriggered ? VeloTheme.emerald.opacity(0.16) : VeloTheme.amber,
                            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                        )
                    }
                    .buttonStyle(VeloPressableButtonStyle())

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
                            .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
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
                        .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }

                Spacer(minLength: 0)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(accent.opacity(0.45), lineWidth: 1)
        )
        .padding(.vertical, 2)
    }
}

// MARK: - Editorial Native Block + Inline GFM Markdown Renderer

private struct NativeMarkdownView: View {
    let markdown: String
    @Environment(\.colorScheme) private var colorScheme

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
        VStack(alignment: .leading, spacing: 11) {
            ForEach(blocks) { block in
                switch block {
                case .heading(_, let level, let text):
                    HeadingBlockView(level: level, text: text)

                case .paragraph(_, let text):
                    InlineMarkdownText(text: text, baseSize: 15.2, baseWeight: .regular, lineSpacing: 4.2)

                case .list(_, let items):
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(items) { item in
                            MarkdownListRowView(entry: item)
                        }
                    }

                case .blockquote(_, let text):
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(VeloTheme.accentVioletSoft)
                            .frame(width: 3)
                        InlineMarkdownText(
                            text: text,
                            baseSize: 14.5,
                            baseWeight: .regular,
                            secondary: true,
                            lineSpacing: 3.5
                        )
                        .padding(.vertical, 2)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(VeloTheme.elevatedSurface(colorScheme).opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                case .codeBlock(_, let language, let code):
                    FencedCodeCardView(language: language, code: code)

                case .table(_, let headers, let alignments, let rows):
                    MarkdownTableCardView(headers: headers, alignments: alignments, rows: rows)

                case .horizontalRule:
                    Rectangle()
                        .fill(VeloTheme.hairline(colorScheme))
                        .frame(height: 1)
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

            if trimmed.isEmpty {
                flushParagraph()
                idx += 1
                continue
            }

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

            if isHorizontalRule(trimmed) {
                flushParagraph()
                result.append(.horizontalRule(id: nextId))
                nextId += 1
                idx += 1
                continue
            }

            if let (level, headingText) = parseHeading(line) {
                flushParagraph()
                result.append(.heading(id: nextId, level: level, text: headingText))
                nextId += 1
                idx += 1
                continue
            }

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

            if let firstItem = parseListLine(line, id: 0) {
                flushParagraph()
                var listItems: [ListEntry] = [firstItem]
                var itemId = 1
                idx += 1
                while idx < lines.count {
                    let nextLine = lines[idx]
                    let nextTrim = nextLine.trimmingCharacters(in: .whitespaces)
                    if nextTrim.isEmpty {
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
    @Environment(\.colorScheme) private var colorScheme

    private var fontSize: CGFloat {
        switch level {
        case 1: return 19.5
        case 2: return 17.5
        case 3: return 16.0
        case 4: return 15.2
        default: return 14.5
        }
    }

    private var fontWeight: Font.Weight {
        level <= 2 ? .bold : .semibold
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            InlineMarkdownText(
                text: text,
                baseSize: fontSize,
                baseWeight: fontWeight,
                secondary: level >= 6,
                lineSpacing: 2.5
            )
            if level <= 2 {
                Rectangle()
                    .fill(VeloTheme.hairline(colorScheme))
                    .frame(height: 0.8)
            }
        }
        .padding(.top, level <= 2 ? 5 : 2)
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
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch entry.marker {
            case .bullet:
                Text(bulletSymbol)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .frame(minWidth: 12, alignment: .center)

            case .ordered(let num):
                Text(num)
                    .font(.system(size: 13.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 18, alignment: .trailing)

            case .task(let checked):
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(checked ? VeloTheme.emerald : Color.secondary)
                    .frame(minWidth: 16, alignment: .center)
            }

            InlineMarkdownText(
                text: entry.text,
                baseSize: 15.2,
                baseWeight: .regular,
                lineSpacing: 3.5
            )
        }
        .padding(.leading, CGFloat(entry.depth) * 14)
    }
}

private struct FencedCodeCardView: View {
    let language: String
    let code: String
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Circle()
                    .fill(VeloTheme.accentVioletSoft.opacity(0.75))
                    .frame(width: 6.5, height: 6.5)

                Text(language.isEmpty ? "code" : language.lowercased())
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    UIPasteboard.general.string = code
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text(copied ? "已复制" : "复制")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(copied ? VeloTheme.emerald : .secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7.5)
            .background(VeloTheme.codeHeader(colorScheme))

            Rectangle()
                .fill(VeloTheme.hairline(colorScheme))
                .frame(height: 0.75)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .lineSpacing(3)
                    .padding(12)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            VeloTheme.codeSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.9)
        )
    }
}

private struct MarkdownTableCardView: View {
    let headers: [String]
    let alignments: [Alignment]
    let rows: [[String]]
    @Environment(\.colorScheme) private var colorScheme

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
                        .frame(minWidth: 74, maxWidth: 260, alignment: alignments[safe: colIdx] ?? .leading)
                    }
                }
                .background(VeloTheme.codeHeader(colorScheme))

                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    Rectangle()
                        .fill(VeloTheme.hairline(colorScheme))
                        .frame(height: 0.7)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { colIdx, cell in
                            InlineMarkdownText(
                                text: cell.isEmpty ? " " : cell,
                                baseSize: 13,
                                baseWeight: .regular,
                                lineSpacing: 2
                            )
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7.5)
                            .frame(minWidth: 74, maxWidth: 260, alignment: alignments[safe: colIdx] ?? .leading)
                        }
                    }
                    .background(rowIdx.isMultiple(of: 2) ? Color.clear : VeloTheme.elevatedSurface(colorScheme).opacity(0.35))
                }
            }
            .background(VeloTheme.cardSurface(colorScheme))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.85)
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
    var baseSize: CGFloat = 15.2
    var baseWeight: Font.Weight = .regular
    var secondary: Bool = false
    var lineSpacing: CGFloat = 4.0

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
                    size: max(12.2, (baseSize * 0.87).rounded(.toNearestOrEven)),
                    weight: .medium,
                    design: .monospaced
                )
                attributed[range].backgroundColor = VeloTheme.accentViolet.opacity(0.14)
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
                attributed[range].foregroundColor = VeloTheme.accentVioletSoft
                attributed[range].underlineStyle = .single
            } else if secondary {
                attributed[range].foregroundColor = .secondary
            }
        }

        return attributed
    }
}

// MARK: - Interactive Permission & Question Specular Cards

private struct ApprovalPromptCard: View {
    let prompt: PendingApprovalPrompt
    let onApprove: () -> Void
    let onDeny: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(VeloTheme.amber)
                Text("请求执行权限 · \(prompt.toolName)")
                    .font(.system(size: 13.5, weight: .semibold))
            }

            Text(prompt.commandPreview)
                .font(.system(size: 12, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VeloTheme.codeSurface(colorScheme), in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            HStack(spacing: 10) {
                Button(action: onDeny) {
                    Text("拒绝")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(VeloTheme.coral)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(VeloTheme.coral.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(VeloPressableButtonStyle())

                Button(action: onApprove) {
                    Text("允许执行")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(VeloTheme.emerald, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
        }
        .padding(14)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(VeloTheme.amber.opacity(0.45), lineWidth: 1)
        )
    }
}

private struct QuestionPromptCard: View {
    let prompt: PendingQuestionPrompt
    let onSubmit: ([String]) -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                Text(prompt.question)
                    .font(.system(size: 14, weight: .semibold))
            }

            ForEach(prompt.options, id: \.self) { opt in
                Button {
                    onSubmit([opt])
                } label: {
                    HStack {
                        Text(opt)
                            .font(.system(size: 13.5, weight: .medium))
                            .foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(11)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
        }
        .padding(14)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 1)
        )
    }
}

// MARK: - Unified Git Diff Sheet

private struct DiffViewerSheet: View {
    let branchName: String
    let files: [DiffFileSection]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                if files.isEmpty {
                    ContentUnavailableView(
                        "工作区暂无未提交变更",
                        systemImage: "checkmark.circle",
                        description: Text("分支 `\(branchName)` 当前与基准一致")
                    )
                } else {
                    ScrollView {
                        VStack(spacing: 12) {
                            ForEach(files) { file in
                                VStack(alignment: .leading, spacing: 0) {
                                    HStack {
                                        Text(file.path)
                                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                            .lineLimit(1)
                                        Spacer()
                                        Text("+\(file.additions)")
                                            .foregroundStyle(VeloTheme.emerald)
                                            .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                                        Text("−\(file.deletions)")
                                            .foregroundStyle(VeloTheme.coral)
                                            .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(VeloTheme.codeHeader(colorScheme))

                                    ScrollView(.horizontal, showsIndicators: false) {
                                        VStack(alignment: .leading, spacing: 1) {
                                            ForEach(file.lines) { row in
                                                Text(row.text.isEmpty ? " " : row.text)
                                                    .font(.system(size: 11.5, design: .monospaced))
                                                    .foregroundStyle(color(for: row.kind))
                                                    .frame(maxWidth: .infinity, alignment: .leading)
                                                    .padding(.horizontal, 8)
                                                    .padding(.vertical, 1.5)
                                                    .background(bg(for: row.kind))
                                            }
                                        }
                                        .padding(.vertical, 4)
                                    }
                                }
                                .background(VeloTheme.codeSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.85)
                                )
                            }
                        }
                        .padding(14)
                    }
                }
            }
            .navigationTitle("变更对比 (Diff)")
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
        case .addition: return VeloTheme.emerald
        case .deletion: return VeloTheme.coral
        case .header: return VeloTheme.accentVioletSoft
        case .context: return .secondary
        }
    }

    private func bg(for kind: DiffLineRow.Kind) -> Color {
        switch kind {
        case .addition: return VeloTheme.emerald.opacity(0.11)
        case .deletion: return VeloTheme.coral.opacity(0.11)
        case .header: return VeloTheme.accentViolet.opacity(0.10)
        case .context: return .clear
        }
    }
}
