import PhotosUI
import SwiftUI
import UIKit

private struct PreviewImageTarget: Identifiable {
    let id = UUID()
    let ref: String
}

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
    @State private var showExtensionsCheckpointsSheet: Bool = false
    @State private var extensionsCheckpointsTab: Int = 0
    @State private var showRenameAlert: Bool = false
    @State private var renameDraftTitle: String = ""
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pendingImages: [PendingComposerImage] = []
    @State private var annotatingImageId: UUID? = nil
    @State private var previewImageItem: PreviewImageTarget?
    @State private var jumpTargetTurnId: String? = nil
    @StateObject private var voiceRecorder = VeloVoiceRecorder()
    @State private var isTranscribingVoice: Bool = false
    @State private var isLoadingOlderHistory: Bool = false
    @State private var didInitialBottomScroll: Bool = false
    @State private var lastTailEventId: String? = nil
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
                if let s = session {
                    threadContextBar(s)
                }
                scrollStreamSection
                floatingComposerDock
            }
        }
        .navigationTitle(session?.title ?? "对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    renameDraftTitle = session?.title ?? ""
                    showRenameAlert = true
                } label: {
                    HStack(spacing: 4.5) {
                        Text(session?.title ?? "对话")
                            .font(.system(size: 15.5, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Image(systemName: "pencil")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: 210)
                }
                .buttonStyle(.plain)
            }

            ToolbarItem(placement: .topBarTrailing) {
                trailingToolbarView
            }
        }
        .alert("重命名会话", isPresented: $showRenameAlert) {
            TextField("输入会话名称", text: $renameDraftTitle)
            Button("取消", role: .cancel) {}
            Button("保存") {
                let newName = renameDraftTitle
                Task { await store.renameSession(sessionId, newTitle: newName) }
            }
        } message: {
            Text("修改后将自动同步至 Mac 桌面端")
        }
        .sheet(isPresented: $showDiffSheet) {
            DiffViewerSheet(
                store: store,
                sessionId: sessionId,
                branchName: session?.branchName ?? "main",
                files: store.diffsBySession[sessionId] ?? []
            )
        }
        .sheet(isPresented: $showExtensionsCheckpointsSheet) {
            VeloExtensionsAndCheckpointsSheet(
                store: store,
                sessionId: sessionId,
                initialTab: extensionsCheckpointsTab,
                onInjectSkillPrompt: { injected in
                    draftPrompt = draftPrompt.isEmpty ? injected : "\(draftPrompt)\n\(injected)"
                    composerFocused = true
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
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
        .fullScreenCover(item: $previewImageItem) { target in
            FullscreenImagePreviewSheet(store: store, ref: target.ref)
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { annotatingImageId != nil },
                set: { if !$0 { annotatingImageId = nil } }
            )
        ) {
            annotatorSheetView
        }
        .onChange(of: pickerItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            let picked = newItems
            pickerItems = []
            Task {
                for (i, item) in picked.enumerated() {
                    if let rawData = try? await item.loadTransferable(type: Data.self),
                       let rawUIImage = UIImage(data: rawData)
                    {
                        enqueueComposerImage(rawUIImage, filename: "photo-\(Int(Date().timeIntervalSince1970))-\(i).jpg")
                    }
                }
            }
        }
    }

    private var trailingToolbarView: some View {
        HStack(spacing: 8) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
                    store.autoCollapseSteps.toggle()
                }
            } label: {
                Image(
                    systemName: store.autoCollapseSteps
                        ? "rectangle.compress.vertical"
                        : "rectangle.expand.vertical"
                )
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(store.autoCollapseSteps ? VeloTheme.accentVioletSoft : .secondary)
            }
            .accessibilityLabel(store.autoCollapseSteps ? "默认收起执行流" : "默认展开执行流")

            Menu {
                Button {
                    showModelSheet = true
                } label: {
                    Label("切换模型 / 跨引擎接力", systemImage: "arrow.triangle.swap")
                }
                Button {
                    extensionsCheckpointsTab = 0
                    showExtensionsCheckpointsSheet = true
                    Task { await store.fetchCheckpoints(for: sessionId) }
                } label: {
                    Label("每轮 Git 检查点与回滚", systemImage: "clock.arrow.circlepath")
                }
                Button {
                    extensionsCheckpointsTab = 1
                    showExtensionsCheckpointsSheet = true
                    Task { await store.fetchExtensions() }
                } label: {
                    Label("MCP 与 Skills 检查器", systemImage: "puzzlepiece.extension")
                }
                if !turns.isEmpty && !isSessionRunning {
                    Button {
                        Task {
                            if let forkedId = await store.forkSession(sessionId, upToUserTurn: nil) {
                                onSwitchedSession?(forkedId)
                            }
                        }
                    } label: {
                        Label("从当前上下文分叉新会话 (Fork)", systemImage: "arrow.branch")
                    }
                }
                if turns.count >= 2 {
                    turnOutlineMenu
                }
                Button {
                    let targetProv = (session?.agentKind == "codex") ? "claude" : "codex"
                    Task {
                        if let advId = await store.requestAdvisorReview(sessionId: sessionId, advisorProvider: targetProv) {
                            onSwitchedSession?(advId)
                        }
                    }
                } label: {
                    Label("请求 Advisor 第二架构意见", systemImage: "person.2.wave.2")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 14.5, weight: .semibold))
            }

            Button {
                showDiffSheet = true
                Task {
                    await store.fetchDiff(for: sessionId)
                    await store.fetchPrStatus(for: sessionId)
                }
            } label: {
                Image(systemName: "arrow.left.arrow.right.square")
                    .font(.system(size: 14, weight: .semibold))
            }
        }
    }

    private var turnOutlineMenu: some View {
        Menu {
            ForEach(Array(turns.enumerated()), id: \.element.id) { idx, t in
                let rawContent = t.userEvent?.content ?? "对话轮次"
                let snippet = String(rawContent.replacingOccurrences(of: "\n", with: " ").prefix(34))
                let titleStr = "#\(idx + 1) \(snippet)"
                Button(titleStr) {
                    jumpTargetTurnId = t.id
                }
            }
        } label: {
            Label("对话轮次导航 (\(turns.count))", systemImage: "list.bullet.indent")
        }
    }

    @ViewBuilder
    private var annotatorSheetView: some View {
        if let targetId = annotatingImageId,
           let idx = pendingImages.firstIndex(where: { $0.id == targetId })
        {
            let item = pendingImages[idx]
            let fullImg = UIImage(data: item.jpegData) ?? item.preview
            VeloImageAnnotatorSheet(
                originalImage: fullImg,
                onCommit: { newJpegData, renderedImage in
                    if let curIdx = pendingImages.firstIndex(where: { $0.id == targetId }) {
                        pendingImages[curIdx].jpegData = newJpegData
                        pendingImages[curIdx].preview = renderedImage
                        pendingImages[curIdx].uploadedPath = nil
                        pendingImages[curIdx].uploadFailed = false
                        retryComposerImageUpload(targetId)
                    }
                    annotatingImageId = nil
                },
                onCancel: {
                    annotatingImageId = nil
                }
            )
        }
    }

    private var scrollStreamSection: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if turns.isEmpty {
                        emptyThreadHero
                    } else if store.hasMoreHistoryBySession[sessionId] == true {
                        olderHistoryButton
                    }

                    ForEach(Array(turns.enumerated()), id: \.element.id) { idx, turn in
                        turnRowView(idx: idx, turn: turn)
                    }

                    planReviewExecuteCard

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
            .onChange(of: store.eventsBySession[sessionId]?.last?.id) { _, newTailId in
                handleTailEventChanged(newTailId: newTailId, proxy: proxy)
            }
            .onChange(of: jumpTargetTurnId) { _, targetId in
                guard let targetId else { return }
                jumpTargetTurnId = nil
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(targetId, anchor: .top)
                }
            }
            .onChange(of: session?.model) { _, newModel in
                if let newModel, !newModel.isEmpty {
                    selectedModelId = newModel
                }
            }
            .onChange(of: sessionId) { _, newSid in
                syncAndScrollInitial(sid: newSid, proxy: proxy)
            }
            .onAppear {
                syncAndScrollInitial(sid: sessionId, proxy: proxy)
            }
        }
    }

    private var olderHistoryButton: some View {
        Button {
            guard !isLoadingOlderHistory else { return }
            isLoadingOlderHistory = true
            Task {
                await store.loadOlderEventsPage(for: sessionId)
                try? await Task.sleep(nanoseconds: 250_000_000)
                isLoadingOlderHistory = false
            }
        } label: {
            HStack(spacing: 5) {
                if isLoadingOlderHistory {
                    ProgressView().scaleEffect(0.72)
                } else {
                    Image(systemName: "arrow.up.circle")
                }
                Text(isLoadingOlderHistory ? "正在加载更早记录…" : "加载更早历史消息")
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
        }
        .frame(maxWidth: .infinity)
        .onAppear {
            guard didInitialBottomScroll, !isLoadingOlderHistory, !turns.isEmpty else { return }
            isLoadingOlderHistory = true
            Task {
                await store.loadOlderEventsPage(for: sessionId)
                try? await Task.sleep(nanoseconds: 350_000_000)
                isLoadingOlderHistory = false
            }
        }
    }

    private func turnRowView(idx: Int, turn: ConversationTurnBlock) -> some View {
        let isLatest = idx == turns.count - 1
        let turnRunning = isLatest && isSessionRunning
        let userTurnOrdinal = turns[0...idx].filter { $0.userEvent != nil }.count - 1

        return TurnBlockView(
            store: store,
            turn: turn,
            isTurnRunning: turnRunning,
            turnStartedAt: isLatest ? store.turnStartedAtBySession[sessionId] : nil,
            liveTps: isLatest ? store.liveTpsBySession[sessionId] : nil,
            autoCollapseSteps: store.autoCollapseSteps,
            waitingApproval: isLatest ? store.pendingApprovals[sessionId] : nil,
            waitingQuestion: isLatest ? store.pendingQuestions[sessionId] : nil,
            onPreviewImage: { ref in
                previewImageItem = PreviewImageTarget(ref: ref)
            },
            onRequestMacLogin: { provider in
                await store.requestMacCLILogin(provider: provider)
            },
            onRetry: retryTurnClosure(turn: turn, userTurnOrdinal: userTurnOrdinal),
            onFork: forkTurnClosure(turn: turn, userTurnOrdinal: userTurnOrdinal)
        )
        .id(turn.id)
    }

    private func handleTailEventChanged(newTailId: String?, proxy: ScrollViewProxy) {
        guard let newTailId, newTailId != lastTailEventId else { return }
        lastTailEventId = newTailId
        guard let lastEv = store.eventsBySession[sessionId]?.last else { return }
        let shouldScroll: Bool = {
            if !store.autoCollapseSteps { return true }
            switch lastEv.kind {
            case .user, .assistant, .error:
                return true
            case .thinking, .toolCall:
                return false
            }
        }()
        if shouldScroll {
            withAnimation(.easeOut(duration: 0.22)) {
                proxy.scrollTo("BOTTOM_ANCHOR", anchor: .bottom)
            }
        }
    }

    private func syncAndScrollInitial(sid: String, proxy: ScrollViewProxy) {
        didInitialBottomScroll = false
        if let s = store.sessions.first(where: { $0.id == sid }) {
            selectedModelId = s.model
            selectedEffort = s.effort
        }
        Task {
            await store.loadEventsForSession(sid)
            proxy.scrollTo("BOTTOM_ANCHOR", anchor: .bottom)
            try? await Task.sleep(nanoseconds: 350_000_000)
            didInitialBottomScroll = true
        }
    }

    private func retryTurnClosure(
        turn: ConversationTurnBlock,
        userTurnOrdinal: Int
    ) -> (() -> Void)? {
        guard !isSessionRunning, let userEv = turn.userEvent else { return nil }
        return {
            let retryImages: [String] = {
                if case .user(let imgs) = userEv.kind { return imgs }
                return []
            }()
            Task {
                await store.sendPrompt(
                    sessionId: sessionId,
                    text: userEv.content,
                    model: selectedModelId,
                    effort: selectedEffort,
                    images: retryImages,
                    truncateToUserTurn: max(0, userTurnOrdinal)
                )
            }
        }
    }

    private func forkTurnClosure(
        turn: ConversationTurnBlock,
        userTurnOrdinal: Int
    ) -> (() -> Void)? {
        guard !isSessionRunning, turn.userEvent != nil else { return nil }
        return {
            Task {
                if let forkedId = await store.forkSession(
                    sessionId,
                    upToUserTurn: max(1, userTurnOrdinal + 1)
                ) {
                    onSwitchedSession?(forkedId)
                }
            }
        }
    }

    private func enqueueComposerImage(_ rawImage: UIImage, filename: String) {
        guard pendingImages.count < 4,
              let compressed = VeloAttachmentCache.compressForAgentUpload(rawImage)
        else { return }
        let entry = PendingComposerImage(
            preview: compressed.preview,
            jpegData: compressed.jpegData,
            filename: filename
        )
        let entryId = entry.id
        pendingImages.append(entry)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()

        Task {
            let uploadedPath = await store.uploadAttachment(
                jpegData: compressed.jpegData,
                preview: compressed.preview,
                filename: filename
            )
            if let idx = pendingImages.firstIndex(where: { $0.id == entryId }) {
                if let uploadedPath {
                    pendingImages[idx].uploadedPath = uploadedPath
                    pendingImages[idx].uploadFailed = false
                } else {
                    pendingImages[idx].uploadFailed = true
                }
            }
        }
    }

    private func retryComposerImageUpload(_ entryId: UUID) {
        guard let idx = pendingImages.firstIndex(where: { $0.id == entryId }) else { return }
        pendingImages[idx].uploadFailed = false
        pendingImages[idx].uploadedPath = nil
        let jpegData = pendingImages[idx].jpegData
        let preview = pendingImages[idx].preview
        let filename = pendingImages[idx].filename
        Task {
            let uploadedPath = await store.uploadAttachment(
                jpegData: jpegData,
                preview: preview,
                filename: filename
            )
            if let curIdx = pendingImages.firstIndex(where: { $0.id == entryId }) {
                if let uploadedPath {
                    pendingImages[curIdx].uploadedPath = uploadedPath
                    pendingImages[curIdx].uploadFailed = false
                } else {
                    pendingImages[curIdx].uploadFailed = true
                }
            }
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

            if let tps = store.latestThroughput(for: sessionId), tps >= 0.5 {
                HStack(spacing: 2.5) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 9, weight: .bold))
                    Text(String(format: "%.1f tok/s", tps))
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .contentTransition(.numericText())
                }
                .foregroundStyle(VeloTheme.accentVioletSoft)
                .padding(.horizontal, 6.5)
                .padding(.vertical, 2.5)
                .background(
                    VeloTheme.accentViolet.opacity(isSessionRunning ? 0.18 : 0.11),
                    in: Capsule()
                )
            }

            if s.tokensUsed > 0 {
                let ctxPct: String = {
                    guard s.contextWindow > 0 else { return "" }
                    let pct = min(100, Int((Double(s.inputTokens > 0 ? s.inputTokens : s.tokensUsed) / Double(s.contextWindow) * 100.0).rounded()))
                    return pct > 0 ? " · \(pct)%" : ""
                }()
                let costPart = s.costUsd >= 0.001 ? " · \(VeloFormatting.formatUsd(s.costUsd))" : ""
                Text("\(VeloFormatting.formatCompactTokens(s.tokensUsed)) tok\(ctxPct)\(costPart)")
                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

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

    private var latestTurnLooksLikePlan: Bool {
        guard !isSessionRunning, let lastTurn = turns.last else { return false }
        let assistantText = lastTurn.items.compactMap { item -> String? in
            if case .assistant = item.kind { return item.content }
            return nil
        }.joined(separator: "\n")
        guard !assistantText.isEmpty else { return false }
        if assistantText.contains("<plan>") { return true }
        let pattern = #"(?im)(?:^|\n)#{1,3}\s*(?:Implementation Plan|实施计划|实现计划|行动计划|执行计划|Plan\b)"#
        return assistantText.range(of: pattern, options: .regularExpression) != nil
    }

    @ViewBuilder
    private var planReviewExecuteCard: some View {
        if latestTurnLooksLikePlan {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2.5) {
                    HStack(spacing: 5) {
                        Image(systemName: "checklist.checked")
                            .font(.system(size: 11.5, weight: .bold))
                        Text("检测到结构化实施计划")
                            .font(.system(size: 12.5, weight: .bold))
                    }
                    .foregroundStyle(VeloTheme.emerald)
                    Text("确认方案后可一键下发执行指令")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    Task {
                        await store.sendPrompt(
                            sessionId: sessionId,
                            text: "计划确认无误，请按上述实施方案开始逐步落地代码修改并完成验证。",
                            model: selectedModelId,
                            effort: selectedEffort
                        )
                    }
                } label: {
                    HStack(spacing: 4.5) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 10))
                        Text("批准并执行计划")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .foregroundStyle(.black)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(VeloTheme.emerald, in: Capsule())
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(
                VeloTheme.emerald.opacity(0.09),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(VeloTheme.emerald.opacity(0.32), lineWidth: 0.9)
            )
        }
    }

    private var offlinePromptsForSession: [VeloOfflineQueuedPrompt] {
        store.offlineOutbox.filter { $0.sessionId == sessionId }
    }

    @ViewBuilder
    private var offlineOutboxBanner: some View {
        let items = offlinePromptsForSession
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "wifi.slash")
                        .font(.system(size: 11, weight: .semibold))
                    Text("离线暂存 (\(items.count)) · 重连 Mac 后自动发送")
                        .font(.system(size: 11.5, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(VeloTheme.amber)

                ForEach(items) { item in
                    HStack(spacing: 7) {
                        Text(item.text)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            store.removeOfflinePrompt(id: item.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 14))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(
                        VeloTheme.elevatedSurface(colorScheme),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                    )
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                VeloTheme.amber.opacity(0.11),
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
        }
    }

    private struct SlashQuickAction: Identifiable {
        let id: String
        let cmd: String
        let title: String
        let icon: String
    }

    private var matchingSlashActions: [SlashQuickAction] {
        let trimmed = draftPrompt.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("/") else { return [] }
        let query = trimmed.lowercased()
        let catalog: [SlashQuickAction] = [
            SlashQuickAction(id: "rewind", cmd: "/rewind", title: "回滚检查点", icon: "clock.arrow.circlepath"),
            SlashQuickAction(id: "mcp", cmd: "/mcp", title: "MCP & Skills", icon: "puzzlepiece.extension"),
            SlashQuickAction(id: "fork", cmd: "/fork", title: "分叉上下文", icon: "arrow.branch"),
            SlashQuickAction(id: "plan", cmd: "/plan", title: "先写实施方案", icon: "checklist"),
            SlashQuickAction(id: "review", cmd: "/review", title: "代码审查", icon: "magnifyingglass.circle"),
            SlashQuickAction(id: "compact", cmd: "/compact", title: "压缩总结上下文", icon: "arrow.down.right.and.arrow.up.left"),
        ]
        if query == "/" { return catalog }
        return catalog.filter { $0.cmd.hasPrefix(query) || $0.title.lowercased().contains(query.dropFirst()) }
    }

    @ViewBuilder
    private var slashCommandStrip: some View {
        let items = matchingSlashActions
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items) { act in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            executeSlashQuickAction(act.cmd)
                        } label: {
                            HStack(spacing: 4.5) {
                                Image(systemName: act.icon)
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(VeloTheme.accentVioletSoft)
                                Text(act.cmd)
                                    .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(.primary)
                                Text(act.title)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5.5)
                            .background(
                                VeloTheme.elevatedSurface(colorScheme),
                                in: Capsule()
                            )
                            .overlay(
                                Capsule()
                                    .stroke(VeloTheme.accentViolet.opacity(0.28), lineWidth: 0.75)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    private func executeSlashQuickAction(_ cmd: String) {
        switch cmd {
        case "/rewind":
            draftPrompt = ""
            composerFocused = false
            extensionsCheckpointsTab = 0
            showExtensionsCheckpointsSheet = true
            Task { await store.fetchCheckpoints(for: sessionId) }
        case "/mcp":
            draftPrompt = ""
            composerFocused = false
            extensionsCheckpointsTab = 1
            showExtensionsCheckpointsSheet = true
            Task { await store.fetchExtensions() }
        case "/fork":
            draftPrompt = ""
            composerFocused = false
            Task {
                if let forkedId = await store.forkSession(sessionId, upToUserTurn: nil) {
                    onSwitchedSession?(forkedId)
                }
            }
        case "/plan":
            draftPrompt = "先不要修改文件，请先给出包含具体改动文件的 `## 实施计划`（Implementation Plan），等我确认后再动手："
            composerFocused = true
        case "/review":
            draftPrompt = "请结合当前分支改动做一次严格的代码审查，列出潜在 Bug、边界情况和性能风险。"
            composerFocused = true
        case "/compact":
            draftPrompt = "/compact "
            composerFocused = true
        default:
            draftPrompt = "\(cmd) "
            composerFocused = true
        }
    }

    private var floatingComposerDock: some View {
        let cat = activeModelOption.category
        let supportedEfforts = cat.supportedEfforts
        let hasText = !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let uploadedPaths = pendingImages.compactMap(\.uploadedPath)
        let isUploadingAny = pendingImages.contains(where: \.isUploading)
        let canSend = (hasText || !uploadedPaths.isEmpty) && !isUploadingAny
        let queuedList = session?.activeQueuedPrompts ?? []

        return VStack(spacing: 10) {
            offlineOutboxBanner
            slashCommandStrip

            if !queuedList.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 5) {
                        Image(systemName: "text.append")
                            .font(.system(size: 11, weight: .semibold))
                        Text("队列待发 (\(queuedList.count)) · 当前轮结束后自动执行")
                            .font(.system(size: 11.5, weight: .semibold))
                        Spacer()
                    }
                    .foregroundStyle(VeloTheme.accentVioletSoft)

                    ForEach(Array(queuedList.enumerated()), id: \.element.id) { idx, q in
                        HStack(spacing: 7) {
                            Text("#\(idx + 1)")
                                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text(q.input)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Button {
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                Task {
                                    await store.removeQueuedPrompt(sessionId: sessionId, queueId: q.id)
                                }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(VeloTheme.accentViolet.opacity(0.09), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }

            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 9) {
                        ForEach(pendingImages) { item in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: item.preview)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                                            .stroke(
                                                item.uploadFailed
                                                    ? AnyShapeStyle(VeloTheme.coral)
                                                    : AnyShapeStyle(VeloTheme.specularRim(colorScheme)),
                                                lineWidth: item.uploadFailed ? 1.3 : 0.85
                                            )
                                    )
                                    .overlay {
                                        if item.isUploading {
                                            ZStack {
                                                Color.black.opacity(0.35)
                                                ProgressView()
                                                    .tint(.white)
                                                    .scaleEffect(0.8)
                                            }
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        } else if item.uploadFailed {
                                            Button {
                                                retryComposerImageUpload(item.id)
                                            } label: {
                                                ZStack {
                                                    Color.black.opacity(0.55)
                                                    VStack(spacing: 2) {
                                                        Image(systemName: "arrow.clockwise")
                                                            .font(.system(size: 13, weight: .bold))
                                                        Text("重试")
                                                            .font(.system(size: 9.5, weight: .semibold))
                                                    }
                                                    .foregroundStyle(.white)
                                                }
                                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                            }
                                            .buttonStyle(.plain)
                                        }
                                    }
                                    .onTapGesture {
                                        annotatingImageId = item.id
                                    }
                                    .overlay(alignment: .bottomLeading) {
                                        Button {
                                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                            annotatingImageId = item.id
                                        } label: {
                                            Image(systemName: "pencil.tip.crop.circle.fill")
                                                .font(.system(size: 16))
                                                .symbolRenderingMode(.palette)
                                                .foregroundStyle(.white, VeloTheme.accentViolet)
                                        }
                                        .offset(x: -4, y: 4)
                                    }

                                Button {
                                    withAnimation(.snappy(duration: 0.18)) {
                                        pendingImages.removeAll { $0.id == item.id }
                                    }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 17))
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, Color.black.opacity(0.72))
                                }
                                .offset(x: 5, y: -5)
                            }
                            .padding(.top, 5)
                            .padding(.trailing, 5)
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }

            if voiceRecorder.isRecording {
                // Pure Visual Acoustic Soundwave Feedback (Zero Text Labels)
                HStack(spacing: 10) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.snappy(duration: 0.2)) {
                            voiceRecorder.cancelRecording()
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12.5, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 32, height: 32)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())

                    VoiceRecordingWaveformBar(levels: voiceRecorder.barLevels)
                        .frame(height: 34)
                        .frame(maxWidth: .infinity)

                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        isTranscribingVoice = true
                        Task {
                            let outcome = await voiceRecorder.stopAndTranscribe()
                            var recognized = outcome.text
                            if (recognized == nil || recognized?.isEmpty == true),
                               let backupData = outcome.fallbackAudio
                            {
                                recognized = await store.transcribeVoiceData(backupData)
                            }
                            if let text = recognized, !text.isEmpty {
                                draftPrompt = draftPrompt.isEmpty ? text : "\(draftPrompt) \(text)"
                                composerFocused = true
                            }
                            isTranscribingVoice = false
                        }
                    } label: {
                        ZStack {
                            Circle()
                                .fill(VeloTheme.coral.opacity(0.18))
                                .frame(width: 34, height: 34)
                            Image(systemName: "checkmark")
                                .font(.system(size: 13.5, weight: .bold))
                                .foregroundStyle(VeloTheme.coral)
                        }
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 3)
                .transition(.opacity.combined(with: .scale(scale: 0.98)))
            } else {
                TextField("向 \(cat.shortBadge) 发送指令或附图…", text: $draftPrompt, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .font(.system(size: 15))
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }

            HStack(spacing: 7) {
                // Paseo-Style Compressed Photo / Screenshot Picker
                PhotosPicker(
                    selection: $pickerItems,
                    maxSelectionCount: max(1, 4 - pendingImages.count),
                    matching: .images
                ) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(pendingImages.isEmpty ? Color.secondary : VeloTheme.accentVioletSoft)
                        .frame(width: 31, height: 31)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                }
                .disabled(pendingImages.count >= 4 || voiceRecorder.isRecording)

                if UIPasteboard.general.hasImages && pendingImages.count < 4 && !voiceRecorder.isRecording {
                    Button {
                        if let pasted = UIPasteboard.general.image {
                            enqueueComposerImage(pasted, filename: "clipboard-\(Int(Date().timeIntervalSince1970)).jpg")
                        }
                    } label: {
                        Image(systemName: "doc.on.clipboard")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(VeloTheme.accentVioletSoft)
                            .frame(width: 31, height: 31)
                            .background(VeloTheme.accentViolet.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                    .accessibilityLabel("粘贴剪贴板图片")
                }

                // Voice-to-Prompt Microphone Dictation Button (Icon-only, zero text)
                if !voiceRecorder.isRecording {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        composerFocused = false
                        Task {
                            _ = await voiceRecorder.startRecording()
                        }
                    } label: {
                        Group {
                            if isTranscribingVoice {
                                ProgressView()
                                    .scaleEffect(0.75)
                            } else {
                                Image(systemName: "mic.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.secondary)
                            }
                        }
                        .frame(width: 31, height: 31)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                    .disabled(isTranscribingVoice)
                    .accessibilityLabel("语音输入")
                }

                // Categorized Model & Handoff Sheet Trigger
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showModelSheet = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: cat.iconName)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(cat.accentColor)

                        Text(activeModelOption.cleanTitle)
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 9)
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
                    HStack(spacing: 3.5) {
                        Image(systemName: "dial.medium.fill")
                            .font(.system(size: 10))
                        Text(selectedEffort.uppercased())
                            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }

                Spacer(minLength: 2)

                // Tactile Send / Queue / Steer / Stop Controls
                if isSessionRunning {
                    HStack(spacing: 6) {
                        if canSend {
                            Button {
                                let toSend = draftPrompt
                                let attached = uploadedPaths
                                draftPrompt = ""
                                pendingImages.removeAll()
                                composerFocused = false
                                Task {
                                    await store.sendPrompt(
                                        sessionId: sessionId,
                                        text: toSend,
                                        model: selectedModelId,
                                        effort: selectedEffort,
                                        images: attached,
                                        executionMode: "queue"
                                    )
                                }
                            } label: {
                                Text("排队")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(VeloTheme.accentVioletSoft)
                                    .padding(.horizontal, 10)
                                    .frame(height: 32)
                                    .background(VeloTheme.accentViolet.opacity(0.16), in: Capsule())
                            }
                            .buttonStyle(VeloPressableButtonStyle())

                            Button {
                                let toSend = draftPrompt
                                let attached = uploadedPaths
                                draftPrompt = ""
                                pendingImages.removeAll()
                                composerFocused = false
                                Task {
                                    await store.sendPrompt(
                                        sessionId: sessionId,
                                        text: toSend,
                                        model: selectedModelId,
                                        effort: selectedEffort,
                                        images: attached,
                                        executionMode: "steer"
                                    )
                                }
                            } label: {
                                Text("纠偏")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(VeloTheme.amber)
                                    .padding(.horizontal, 10)
                                    .frame(height: 32)
                                    .background(VeloTheme.amber.opacity(0.18), in: Capsule())
                            }
                            .buttonStyle(VeloPressableButtonStyle())
                        }

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
                    }
                } else {
                    Button {
                        let toSend = draftPrompt
                        let trimmedCmd = toSend.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        if trimmedCmd == "/rewind" || trimmedCmd == "/mcp" || trimmedCmd == "/fork" {
                            executeSlashQuickAction(trimmedCmd)
                            return
                        }
                        let attached = uploadedPaths
                        draftPrompt = ""
                        pendingImages.removeAll()
                        composerFocused = false
                        Task {
                            await store.sendPrompt(
                                sessionId: sessionId,
                                text: toSend,
                                model: selectedModelId,
                                effort: selectedEffort,
                                images: attached
                            )
                        }
                    } label: {
                        if isUploadingAny {
                            ProgressView()
                                .tint(VeloTheme.accentVioletSoft)
                                .frame(width: 34, height: 34)
                                .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                        } else {
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
    @ObservedObject var store: VeloStore
    let turn: ConversationTurnBlock
    let isTurnRunning: Bool
    let turnStartedAt: Date?
    let liveTps: Double?
    let autoCollapseSteps: Bool
    let waitingApproval: PendingApprovalPrompt?
    let waitingQuestion: PendingQuestionPrompt?
    let onPreviewImage: (String) -> Void
    let onRequestMacLogin: (String) async -> Bool
    let onRetry: (() -> Void)?
    let onFork: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme

    fileprivate enum RenderSegment: Identifiable {
        case single(item: TimelineEventItem, isLastItem: Bool)
        case traceGroup(id: String, items: [TimelineEventItem])

        var id: String {
            switch self {
            case .single(let item, _): return item.id
            case .traceGroup(let id, _): return id
            }
        }
    }

    private func isProcessStep(_ kind: TimelineEventKind) -> Bool {
        switch kind {
        case .thinking, .toolCall:
            return true
        default:
            return false
        }
    }

    private var segments: [RenderSegment] {
        var out: [RenderSegment] = []
        var idx = 0
        let total = turn.items.count

        while idx < total {
            let item = turn.items[idx]
            if isProcessStep(item.kind) {
                var batch: [TimelineEventItem] = [item]
                var j = idx + 1
                while j < total, isProcessStep(turn.items[j].kind) {
                    batch.append(turn.items[j])
                    j += 1
                }
                if batch.count >= 2 {
                    out.append(.traceGroup(id: "trace-\(item.id)", items: batch))
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
            // 1. User Specular Right-Aligned Bubble (With Attached Screenshots / Photos)
            if let userEv = turn.userEvent {
                let userImages: [String] = {
                    if case .user(let imgs) = userEv.kind { return imgs }
                    return []
                }()
                let cleanUserText = userEv.content.trimmingCharacters(in: .whitespacesAndNewlines)
                let shouldShowText = !cleanUserText.isEmpty && !(cleanUserText == "请查看附图" && !userImages.isEmpty)

                VStack(alignment: .trailing, spacing: 7) {
                    if !userImages.isEmpty {
                        HStack {
                            Spacer(minLength: 42)
                            if userImages.count == 1, let singleRef = userImages.first {
                                VeloRemoteImageView(
                                    store: store,
                                    ref: singleRef,
                                    maxWidth: 236,
                                    maxHeight: 196,
                                    onTapFull: onPreviewImage
                                )
                            } else {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 7) {
                                        ForEach(Array(userImages.enumerated()), id: \.offset) { _, imgRef in
                                            VeloRemoteImageView(
                                                store: store,
                                                ref: imgRef,
                                                maxWidth: 124,
                                                maxHeight: 124,
                                                squareCrop: true,
                                                onTapFull: onPreviewImage
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if shouldShowText {
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
                }
            }

            // 2. Chronological Agent Segments (Unified Collapsible Execution Trace + Editorial Markdown)
            ForEach(segments) { seg in
                switch seg {
                case .traceGroup(_, let batch):
                    ExecutionTraceGroupView(
                        items: batch,
                        isTurnRunning: isTurnRunning,
                        turnStartedAt: turnStartedAt,
                        defaultExpanded: !autoCollapseSteps
                    )

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
                            isError: isError,
                            inlineDiffOld: item.inlineDiffOld,
                            inlineDiffNew: item.inlineDiffNew,
                            subagentRole: item.subagentRole,
                            subagentPrompt: item.subagentPrompt
                        )

                    case .assistant(let isStreaming):
                        VStack(alignment: .leading, spacing: 4) {
                            NativeMarkdownView(
                                store: store,
                                markdown: item.content,
                                onPreviewImage: onPreviewImage
                            )
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

            // 3. Live / Completed Turn Status & Telemetry Footer
            if !hasErrorWithoutAnswer || isTurnRunning {
                TurnStatusFooterView(
                    isRunning: isTurnRunning,
                    phase: computedPhase,
                    startedAt: turnStartedAt,
                    durationMs: hasErrorWithoutAnswer ? nil : turn.userEvent?.durationMs,
                    completedAt: hasErrorWithoutAnswer ? nil : (turn.userEvent?.completedAt ?? turn.items.last?.timestamp),
                    liveTps: isTurnRunning ? liveTps : nil,
                    telemetry: hasErrorWithoutAnswer ? nil : turn.userEvent?.telemetry,
                    assistantText: lastAssistantText,
                    onRetry: onRetry,
                    onFork: onFork
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
    @ObservedObject var store: VeloStore
    let markdown: String
    let onPreviewImage: (String) -> Void
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
        case image(id: Int, alt: String, ref: String)
        case list(id: Int, items: [ListEntry])
        case blockquote(id: Int, text: String)
        case codeBlock(id: Int, language: String, code: String)
        case table(id: Int, headers: [String], alignments: [Alignment], rows: [[String]])
        case horizontalRule(id: Int)

        var id: Int {
            switch self {
            case .heading(let id, _, _),
                 .paragraph(let id, _),
                 .image(let id, _, _),
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

                case .image(_, let alt, let ref):
                    VStack(alignment: .leading, spacing: 5) {
                        VeloRemoteImageView(
                            store: store,
                            ref: ref,
                            maxWidth: 300,
                            maxHeight: 230,
                            onTapFull: onPreviewImage
                        )
                        if !alt.isEmpty && alt.lowercased() != "image" && alt.lowercased() != "screenshot" {
                            Text(alt)
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)

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
                let segments = splitInlineMarkdownImages(joined)
                for seg in segments {
                    switch seg {
                    case .text(let txt):
                        let clean = txt.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !clean.isEmpty {
                            result.append(.paragraph(id: nextId, text: clean))
                            nextId += 1
                        }
                    case .image(let alt, let ref):
                        result.append(.image(id: nextId, alt: alt, ref: ref))
                        nextId += 1
                    }
                }
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

            if let (alt, imgRef) = parseStandaloneImage(trimmed) {
                flushParagraph()
                result.append(.image(id: nextId, alt: alt, ref: imgRef))
                nextId += 1
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
        return t.contains("|") && t.count >= 2
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
            return !core.isEmpty && core.allSatisfy { $0 == "-" }
        }
    }

    /// Splits a GFM table row while respecting escaped pipes (`\|`) and inline code spans (`` `a | b` ``),
    /// and normalizes HTML `<br>` tags inside cells into line breaks.
    private static func splitTableCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|") { t.removeLast() }

        var cells: [String] = []
        var current = ""
        var inCodeSpan = false
        var iterator = t.makeIterator()

        while let ch = iterator.next() {
            if ch == "\\" {
                if let next = iterator.next() {
                    if next == "|" {
                        current.append("|")
                    } else {
                        current.append(ch)
                        current.append(next)
                    }
                } else {
                    current.append(ch)
                }
                continue
            }
            if ch == "`" {
                inCodeSpan.toggle()
                current.append(ch)
                continue
            }
            if ch == "|" && !inCodeSpan {
                cells.append(normalizeTableCellText(current))
                current = ""
            } else {
                current.append(ch)
            }
        }
        cells.append(normalizeTableCellText(current))
        return cells
    }

    private static func normalizeTableCellText(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "<br/>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br />", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
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

    private enum InlineImageSegment {
        case text(String)
        case image(alt: String, ref: String)
    }

    private static func cleanMarkdownImageRef(_ rawTarget: String) -> String {
        var s = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("<") && s.hasSuffix(">") && s.count > 2 {
            s.removeFirst()
            s.removeLast()
        }
        if let quoteRange = s.range(of: " \"") ?? s.range(of: " '") {
            s = String(s[..<quoteRange.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return s
    }

    private static func parseStandaloneImage(_ trimmed: String) -> (alt: String, ref: String)? {
        guard trimmed.hasPrefix("!["), trimmed.hasSuffix(")"),
              let midRange = trimmed.range(of: "](")
        else { return nil }
        let altStart = trimmed.index(trimmed.startIndex, offsetBy: 2)
        let alt = String(trimmed[altStart..<midRange.lowerBound])
        let refEnd = trimmed.index(before: trimmed.endIndex)
        guard midRange.upperBound < refEnd else { return nil }
        let rawRef = String(trimmed[midRange.upperBound..<refEnd])
        if rawRef.contains("](") { return nil }
        let cleanRef = cleanMarkdownImageRef(rawRef)
        return cleanRef.isEmpty ? nil : (alt, cleanRef)
    }

    private static func splitInlineMarkdownImages(_ raw: String) -> [InlineImageSegment] {
        guard raw.contains("![") && raw.contains("](") else {
            return [.text(raw)]
        }
        var out: [InlineImageSegment] = []
        var cursor = raw.startIndex
        while cursor < raw.endIndex {
            guard let bangRange = raw.range(of: "![", range: cursor..<raw.endIndex),
                  let midRange = raw.range(of: "](", range: bangRange.upperBound..<raw.endIndex),
                  let closeRange = raw.range(of: ")", range: midRange.upperBound..<raw.endIndex)
            else {
                out.append(.text(String(raw[cursor..<raw.endIndex])))
                break
            }
            if bangRange.lowerBound > cursor {
                out.append(.text(String(raw[cursor..<bangRange.lowerBound])))
            }
            let alt = String(raw[bangRange.upperBound..<midRange.lowerBound])
            let cleanRef = cleanMarkdownImageRef(String(raw[midRange.upperBound..<closeRange.lowerBound]))
            if !cleanRef.isEmpty {
                out.append(.image(alt: alt, ref: cleanRef))
            }
            cursor = closeRange.upperBound
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

private struct VoiceRecordingWaveformBar: View {
    let levels: [CGFloat]
    @State private var pulseDot: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(VeloTheme.coral)
                .frame(width: 7.5, height: 7.5)
                .scaleEffect(pulseDot ? 1.18 : 0.78)
                .opacity(pulseDot ? 1.0 : 0.45)
                .animation(.easeInOut(duration: 0.65).repeatForever(autoreverses: true), value: pulseDot)

            HStack(alignment: .center, spacing: 3.2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, lv in
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [VeloTheme.coral, VeloTheme.accentVioletSoft],
                                startPoint: .bottom,
                                endPoint: .top
                            )
                        )
                        .frame(width: 3.0, height: max(4, min(26, lv * 26)))
                        .animation(.interpolatingSpring(stiffness: 260, damping: 19), value: lv)
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(VeloTheme.coral.opacity(0.09), in: Capsule())
        .overlay(
            Capsule()
                .stroke(VeloTheme.coral.opacity(0.24), lineWidth: 0.8)
        )
        .onAppear {
            pulseDot = true
        }
    }
}

private struct MarkdownTableCardView: View {
    let headers: [String]
    let alignments: [Alignment]
    let rows: [[String]]
    @Environment(\.colorScheme) private var colorScheme

    private static let minColumnWidth: CGFloat = 78
    private static let maxColumnWidth: CGFloat = 250
    private static let cellHorizontalPadding: CGFloat = 22

    private var columnWidths: [CGFloat] {
        headers.indices.map { col in
            var widest = Self.measure(headers[col], weight: .semibold)
            for row in rows {
                if let cell = row[safe: col] {
                    widest = max(widest, Self.measure(cell, weight: .regular))
                }
            }
            let width = ceil(widest * 1.08) + Self.cellHorizontalPadding
            return min(max(width, Self.minColumnWidth), Self.maxColumnWidth)
        }
    }

    private var totalTableWidth: CGFloat {
        let widths = columnWidths
        let dividers = CGFloat(max(0, widths.count - 1)) * 0.6
        return widths.reduce(0, +) + dividers
    }

    private static func measure(_ text: String, weight: UIFont.Weight) -> CGFloat {
        let plain = text
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
        return plain
            .components(separatedBy: .newlines)
            .map { line in
                (line as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 13, weight: weight)]).width
            }
            .max() ?? 0
    }

    private func textAlignment(for align: Alignment) -> TextAlignment {
        if align == .center { return .center }
        if align == .trailing { return .trailing }
        return .leading
    }

    var body: some View {
        let widths = columnWidths
        let tableWidth = totalTableWidth

        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                // Header Row
                HStack(alignment: .center, spacing: 0) {
                    ForEach(Array(headers.enumerated()), id: \.offset) { colIdx, title in
                        let colAlign = alignments[safe: colIdx] ?? .leading
                        let colWidth = widths[safe: colIdx] ?? Self.minColumnWidth
                        InlineMarkdownText(
                            text: title.isEmpty ? " " : title,
                            baseSize: 13,
                            baseWeight: .semibold,
                            lineSpacing: 2,
                            alignment: textAlignment(for: colAlign)
                        )
                        .padding(.horizontal, 11)
                        .padding(.vertical, 9)
                        .frame(width: colWidth, alignment: colAlign)

                        if colIdx < headers.count - 1 {
                            Rectangle()
                                .fill(VeloTheme.hairline(colorScheme))
                                .frame(width: 0.6)
                        }
                    }
                }
                .frame(width: tableWidth, alignment: .leading)
                .background(VeloTheme.codeHeader(colorScheme))

                // Data Rows
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    Rectangle()
                        .fill(VeloTheme.hairline(colorScheme))
                        .frame(width: tableWidth, height: 0.7)

                    HStack(alignment: .top, spacing: 0) {
                        ForEach(0..<headers.count, id: \.self) { colIdx in
                            let cell = row[safe: colIdx] ?? ""
                            let colAlign = alignments[safe: colIdx] ?? .leading
                            let colWidth = widths[safe: colIdx] ?? Self.minColumnWidth
                            InlineMarkdownText(
                                text: cell.isEmpty ? " " : cell,
                                baseSize: 13,
                                baseWeight: .regular,
                                lineSpacing: 2.5,
                                alignment: textAlignment(for: colAlign)
                            )
                            .padding(.horizontal, 11)
                            .padding(.vertical, 8.5)
                            .frame(width: colWidth, alignment: colAlign)

                            if colIdx < headers.count - 1 {
                                Rectangle()
                                    .fill(VeloTheme.hairline(colorScheme).opacity(0.65))
                                    .frame(width: 0.6)
                            }
                        }
                    }
                    .frame(width: tableWidth, alignment: .leading)
                    .background(
                        rowIdx.isMultiple(of: 2)
                            ? Color.clear
                            : VeloTheme.elevatedSurface(colorScheme).opacity(0.35)
                    )
                }
            }
            .frame(width: tableWidth, alignment: .leading)
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
    var alignment: TextAlignment = .leading

    var body: some View {
        Text(Self.buildAttributed(text, baseSize: baseSize, baseWeight: baseWeight, secondary: secondary))
            .lineSpacing(lineSpacing)
            .multilineTextAlignment(alignment)
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

// MARK: - Unified Git Diff, Commit/Push & Pull Request Studio Sheet

private struct DiffViewerSheet: View {
    @ObservedObject var store: VeloStore
    let sessionId: String
    let branchName: String
    let files: [DiffFileSection]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var mode: Int = 0 // 0 = Diff & Git, 1 = PR & CI
    @State private var commitMessage: String = ""
    @State private var pushAfterCommit: Bool = true
    @State private var prTitle: String = ""
    @State private var prBody: String = ""
    @State private var isBusy: Bool = false

    var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    Picker("模式", selection: $mode) {
                        Text("代码变更与提交 (\(files.count))").tag(0)
                        Text("GitHub PR 与 CI").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)

                    if let banner = store.lastActionBanner, !banner.isEmpty {
                        Text(banner)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(VeloTheme.emerald)
                            .padding(.bottom, 6)
                    }

                    if mode == 0 {
                        gitDiffPane
                    } else {
                        pullRequestPane
                    }
                }
            }
            .navigationTitle("分支 `\(branchName)`")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !files.isEmpty && mode == 0 {
                        Menu {
                            Button(role: .destructive) {
                                Task { await store.gitDiscard(sessionId: sessionId, all: true) }
                            } label: {
                                Label("放弃全部未提交修改", systemImage: "trash")
                            }
                            Button {
                                Task { await store.gitMerge(sessionId: sessionId) }
                            } label: {
                                Label("合并当前分支回主工作区", systemImage: "arrow.triangle.merge")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var gitDiffPane: some View {
        if files.isEmpty {
            ContentUnavailableView(
                "工作区暂无未提交变更",
                systemImage: "checkmark.circle",
                description: Text("分支 `\(branchName)` 当前干净无未提交修改")
            )
        } else {
            VStack(spacing: 0) {
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
                                    Button(role: .destructive) {
                                        Task { await store.gitDiscard(sessionId: sessionId, filePath: file.path) }
                                    } label: {
                                        Image(systemName: "arrow.uturn.backward")
                                            .font(.system(size: 11))
                                            .foregroundStyle(.secondary)
                                    }
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

                VStack(spacing: 8) {
                    TextField("输入 Commit Message（留空自动生成）", text: $commitMessage)
                        .font(.system(size: 13.5))
                        .padding(10)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                    HStack(spacing: 10) {
                        Toggle("同步 Push 远端", isOn: $pushAfterCommit)
                            .font(.system(size: 12.5, weight: .medium))

                        Button {
                            isBusy = true
                            Task {
                                await store.gitCommit(
                                    sessionId: sessionId,
                                    message: commitMessage,
                                    push: pushAfterCommit
                                )
                                commitMessage = ""
                                isBusy = false
                            }
                        } label: {
                            Label(pushAfterCommit ? "Commit & Push" : "Commit", systemImage: "paperplane.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(VeloTheme.emerald, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .disabled(isBusy)
                    }
                }
                .padding(14)
                .background(VeloTheme.cardSurface(colorScheme))
            }
        }
    }

    @ViewBuilder
    private var pullRequestPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let pr = store.prBySession[sessionId], pr.exists {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("#\(pr.number ?? 0) \(pr.title)")
                                .font(.system(size: 15, weight: .bold))
                            Spacer()
                            Text(pr.state)
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(VeloTheme.emerald)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(VeloTheme.emerald.opacity(0.14), in: Capsule())
                        }
                        if !pr.url.isEmpty, let u = URL(string: pr.url) {
                            Link(pr.url, destination: u)
                                .font(.system(size: 12, design: .monospaced))
                                .lineLimit(1)
                        }
                    }
                    .padding(14)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    if !pr.checks.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("CI Checks (\(pr.checks.count))")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.secondary)
                            ForEach(pr.checks) { ck in
                                HStack {
                                    Image(
                                        systemName: ck.conclusion == "SUCCESS"
                                            ? "checkmark.circle.fill"
                                            : (ck.conclusion == "FAILURE" ? "xmark.circle.fill" : "clock.fill")
                                    )
                                    .foregroundStyle(
                                        ck.conclusion == "SUCCESS"
                                            ? VeloTheme.emerald
                                            : (ck.conclusion == "FAILURE" ? VeloTheme.coral : VeloTheme.amber)
                                    )
                                    Text(ck.name)
                                        .font(.system(size: 13, weight: .medium))
                                    Spacer()
                                    Text(ck.conclusion.isEmpty ? ck.status : ck.conclusion)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                                .padding(10)
                                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                            }
                        }
                    }

                    if pr.state == "OPEN" {
                        Button {
                            Task { await store.mergePullRequest(sessionId: sessionId, method: "squash") }
                        } label: {
                            Label("Squash & Merge PR", systemImage: "arrow.triangle.merge")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(VeloTheme.accentViolet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("当前分支尚未关联打开的 Pull Request")
                            .font(.system(size: 13.5, weight: .semibold))
                        TextField("PR 标题（如 feat: mobile git & sqlite wal）", text: $prTitle)
                            .font(.system(size: 13.5))
                            .padding(10)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        TextField("PR 描述说明（可选）", text: $prBody, axis: .vertical)
                            .lineLimit(3...6)
                            .font(.system(size: 13.5))
                            .padding(10)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                        Button {
                            Task {
                                await store.createPullRequest(
                                    sessionId: sessionId,
                                    title: prTitle.isEmpty ? "feat(\(branchName)): update via Velo Mobile" : prTitle,
                                    body: prBody
                                )
                            }
                        } label: {
                            Label("推送分支并创建 GitHub PR", systemImage: "arrow.up.right.square.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(VeloTheme.accentViolet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    .padding(14)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(14)
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

// MARK: - Paseo-Style Tiered E2EE Remote Image & Fullscreen Pinch-to-Zoom HD Viewer

private struct VeloRemoteImageView: View {
    @ObservedObject var store: VeloStore
    let ref: String
    var maxWidth: CGFloat = 260
    var maxHeight: CGFloat = 200
    var squareCrop: Bool = false
    let onTapFull: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var loadedImage: UIImage?
    @State private var didFail: Bool = false

    init(
        store: VeloStore,
        ref: String,
        maxWidth: CGFloat = 260,
        maxHeight: CGFloat = 200,
        squareCrop: Bool = false,
        onTapFull: @escaping (String) -> Void
    ) {
        self.store = store
        self.ref = ref
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.squareCrop = squareCrop
        self.onTapFull = onTapFull
        _loadedImage = State(initialValue: VeloAttachmentCache.shared.cachedImage(for: ref, tier: .thumb))
    }

    var body: some View {
        Group {
            if let uiImg = loadedImage {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onTapFull(ref)
                } label: {
                    if squareCrop {
                        Image(uiImage: uiImg)
                            .resizable()
                            .scaledToFill()
                            .frame(width: maxWidth, height: maxHeight)
                            .clipped()
                    } else {
                        let ratio = max(0.35, min(2.6, uiImg.size.width / max(1, uiImg.size.height)))
                        Image(uiImage: uiImg)
                            .resizable()
                            .aspectRatio(ratio, contentMode: .fit)
                            .frame(maxWidth: maxWidth, maxHeight: maxHeight)
                    }
                }
                .buttonStyle(VeloPressableButtonStyle(scale: 0.98))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.9)
                )
            } else if didFail {
                Button {
                    didFail = false
                    Task {
                        if let img = await store.loadAttachmentImage(ref: ref, tier: .thumb) {
                            loadedImage = img
                        } else {
                            didFail = true
                        }
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1.5) {
                            Text("图片加载失败 · 点击重试")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.primary)
                            Text(URL(fileURLWithPath: ref).lastPathComponent)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                    )
                }
                .buttonStyle(.plain)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(VeloTheme.cardSurface(colorScheme))
                    VStack(spacing: 7) {
                        ProgressView()
                            .controlSize(.small)
                        Text("加密拉取缩略图…")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(width: squareCrop ? maxWidth : min(210, maxWidth), height: squareCrop ? maxHeight : 136)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                )
            }
        }
        .task(id: ref) {
            guard loadedImage == nil else { return }
            if let cached = VeloAttachmentCache.shared.cachedImage(for: ref, tier: .thumb) {
                loadedImage = cached
                return
            }
            if let fetched = await store.loadAttachmentImage(ref: ref, tier: .thumb) {
                withAnimation(.easeOut(duration: 0.18)) {
                    loadedImage = fetched
                }
            } else {
                didFail = true
            }
        }
    }
}

private struct FullscreenImagePreviewSheet: View {
    @ObservedObject var store: VeloStore
    let ref: String

    @Environment(\.dismiss) private var dismiss
    @State private var displayImage: UIImage?
    @State private var isLoadingHD: Bool = false
    @State private var savedToPhotos: Bool = false

    @State private var steadyScale: CGFloat = 1.0
    @State private var gestureScale: CGFloat = 1.0
    @State private var steadyOffset: CGSize = .zero
    @State private var gestureOffset: CGSize = .zero

    init(store: VeloStore, ref: String) {
        self.store = store
        self.ref = ref
        let initial = VeloAttachmentCache.shared.cachedImage(for: ref, tier: .full)
            ?? VeloAttachmentCache.shared.cachedImage(for: ref, tier: .thumb)
        _displayImage = State(initialValue: initial)
    }

    private var currentScale: CGFloat {
        max(1.0, min(5.0, steadyScale * gestureScale))
    }

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            if let uiImage = displayImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(currentScale)
                    .offset(
                        x: steadyOffset.width + gestureOffset.width,
                        y: steadyOffset.height + gestureOffset.height
                    )
                    .gesture(
                        MagnificationGesture()
                            .onChanged { val in
                                gestureScale = val
                            }
                            .onEnded { val in
                                let next = max(1.0, min(5.0, steadyScale * val))
                                gestureScale = 1.0
                                withAnimation(.spring(response: 0.25, dampingFraction: 0.82)) {
                                    steadyScale = next
                                    if next <= 1.02 {
                                        steadyScale = 1.0
                                        steadyOffset = .zero
                                    }
                                }
                            }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                if steadyScale > 1.01 {
                                    gestureOffset = value.translation
                                } else if value.translation.height > 0 {
                                    gestureOffset = CGSize(width: 0, height: value.translation.height)
                                }
                            }
                            .onEnded { value in
                                if steadyScale > 1.01 {
                                    steadyOffset = CGSize(
                                        width: steadyOffset.width + value.translation.width,
                                        height: steadyOffset.height + value.translation.height
                                    )
                                    gestureOffset = .zero
                                } else {
                                    if value.translation.height > 110 {
                                        dismiss()
                                    } else {
                                        withAnimation(.spring(response: 0.24, dampingFraction: 0.8)) {
                                            gestureOffset = .zero
                                        }
                                    }
                                }
                            }
                    )
                    .onTapGesture(count: 2) {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.26, dampingFraction: 0.82)) {
                            if steadyScale > 1.1 {
                                steadyScale = 1.0
                                steadyOffset = .zero
                            } else {
                                steadyScale = 2.4
                            }
                        }
                    }
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                        .tint(.white)
                    Text("正在拉取高清原图…")
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.75))
                }
            }

            // Top Chrome Bar
            VStack {
                HStack(spacing: 10) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                    }

                    if isLoadingHD {
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(.white)
                            Text("HD")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.9))
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(.ultraThinMaterial, in: Capsule())
                    }

                    Spacer()

                    if let uiImage = displayImage {
                        Button {
                            UIImageWriteToSavedPhotosAlbum(uiImage, nil, nil, nil)
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                            withAnimation(.snappy(duration: 0.2)) {
                                savedToPhotos = true
                            }
                            Task {
                                try? await Task.sleep(nanoseconds: 1_800_000_000)
                                withAnimation(.snappy(duration: 0.2)) {
                                    savedToPhotos = false
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: savedToPhotos ? "checkmark" : "square.and.arrow.down")
                                    .font(.system(size: 12.5, weight: .semibold))
                                Text(savedToPhotos ? "已保存" : "保存")
                                    .font(.system(size: 12.5, weight: .semibold))
                            }
                            .foregroundStyle(savedToPhotos ? VeloTheme.emerald : .white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(.ultraThinMaterial, in: Capsule())
                        }

                        ShareLink(
                            item: Image(uiImage: uiImage),
                            preview: SharePreview(URL(fileURLWithPath: ref).lastPathComponent, image: Image(uiImage: uiImage))
                        ) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)

                Spacer()
            }
        }
        .task(id: ref) {
            if let cachedFull = VeloAttachmentCache.shared.cachedImage(for: ref, tier: .full) {
                displayImage = cachedFull
                return
            }
            isLoadingHD = true
            if let full = await store.loadAttachmentImage(ref: ref, tier: .full) {
                displayImage = full
            }
            isLoadingHD = false
        }
    }
}
