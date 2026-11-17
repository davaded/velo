import PhotosUI
import SwiftUI
import UIKit

public struct RootSessionsView: View {
    @ObservedObject var store: VeloStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var showPairSheet = false
    @State private var showNewThreadSheet = false
    @State private var prefillRepoForNewSession: String?
    @State private var selectedEngineFilter: VeloEngineCategory?
    @State private var collapsedProjects: Set<String> = []
    @State private var navigationPath: [String] = []
    @State private var renamingSessionId: String?
    @State private var renameDraftTitle: String = ""

    public init(store: VeloStore) {
        self.store = store
    }

    private var filteredSessions: [VeloSessionItem] {
        guard let filter = selectedEngineFilter else {
            return store.sessions
        }
        return store.sessions.filter { $0.engineCategory == filter }
    }

    private var groupedByProject: [(repoRoot: String, projectName: String, sessions: [VeloSessionItem])] {
        var order: [String] = []
        var bucket: [String: [VeloSessionItem]] = [:]
        for s in filteredSessions {
            let root = VeloFormatting.canonicalWorkspacePath(s.repoRoot)
            if bucket[root] == nil {
                order.append(root)
            }
            bucket[root, default: []].append(s)
        }
        // Include synced daemon workspaces when viewing all engines so iOS & Desktop folders match 1:1
        if selectedEngineFilter == nil {
            for rawWs in store.workspaces {
                let root = VeloFormatting.canonicalWorkspacePath(rawWs)
                guard !root.isEmpty,
                      !root.hasSuffix("/.velo/workspace"),
                      bucket[root] == nil
                else { continue }
                order.append(root)
                bucket[root] = []
            }
        }
        return order.map { root in
            let list = bucket[root] ?? []
            let name = list.first?.projectName ?? URL(fileURLWithPath: root).lastPathComponent
            return (root, name.isEmpty ? "workspace" : name, list)
        }
    }

    private var runningCount: Int {
        store.sessions.filter { $0.status == .running || $0.status == .waitingApproval }.count
    }

    public var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack(alignment: .bottom) {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                if store.connectionConfig == nil {
                    unpairedWelcomeState
                } else if store.sessions.isEmpty && store.workspaces.isEmpty {
                    emptyConnectedState
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            // 1. Live Specular Connection Status Card
                            connectionStatusCard

                            // 2. Categorized Engine Filter Strip
                            engineFilterStrip

                            // 3. Project-Grouped Collapsible Session Cards
                            if groupedByProject.isEmpty {
                                VStack(spacing: 10) {
                                    Image(systemName: "line.3.horizontal.decrease.circle")
                                        .font(.system(size: 28, weight: .light))
                                        .foregroundStyle(.secondary)
                                    Text("当前引擎分类下暂无会话")
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                            } else {
                                ForEach(groupedByProject, id: \.repoRoot) { group in
                                    projectSectionView(group: group)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .padding(.bottom, 96)
                    }
                    .refreshable {
                        await store.refreshSessionsAndActiveEvents()
                    }
                }

                // Floating Specular New Session Button
                if store.connectionConfig != nil {
                    floatingNewSessionBar
                }
            }
            .navigationTitle("Velo")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { sessionId in
                ChatThreadView(store: store, sessionId: sessionId) { handoffNewId in
                    // Replace or push cleanly to the newly handed-off session
                    if !navigationPath.isEmpty {
                        navigationPath[navigationPath.count - 1] = handoffNewId
                    } else {
                        navigationPath.append(handoffNewId)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showPairSheet = true
                    } label: {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(store.isConnected ? VeloTheme.emerald : VeloTheme.amber)
                                .frame(width: 7.5, height: 7.5)
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        prefillRepoForNewSession = nil
                        showNewThreadSheet = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.primary)
                            .frame(width: 30, height: 30)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                    .disabled(store.connectionConfig == nil)
                }
            }
            .sheet(isPresented: $showPairSheet) {
                PairingSheetView(store: store)
            }
            .sheet(isPresented: $showNewThreadSheet) {
                NewSessionSheetView(
                    store: store,
                    initialRepoPath: prefillRepoForNewSession
                ) { createdId in
                    if let createdId {
                        navigationPath = [createdId]
                    }
                }
            }
            .alert(
                "重命名会话",
                isPresented: Binding(
                    get: { renamingSessionId != nil },
                    set: { if !$0 { renamingSessionId = nil } }
                )
            ) {
                TextField("输入会话名称", text: $renameDraftTitle)
                Button("取消", role: .cancel) {
                    renamingSessionId = nil
                }
                Button("保存") {
                    if let sid = renamingSessionId {
                        let newName = renameDraftTitle
                        renamingSessionId = nil
                        Task { await store.renameSession(sid, newTitle: newName) }
                    }
                }
            } message: {
                Text("修改后将自动同步至 Mac 桌面端")
            }
            .onChange(of: store.latestCreatedOrHandoffSessionId) { _, newSid in
                guard let newSid, !newSid.isEmpty else { return }
                if navigationPath.last != newSid {
                    if navigationPath.isEmpty {
                        navigationPath = [newSid]
                    } else {
                        navigationPath[navigationPath.count - 1] = newSid
                    }
                }
                store.latestCreatedOrHandoffSessionId = nil
            }
        }
    }

    // MARK: - Subviews

    private var connectionStatusCard: some View {
        Button {
            showPairSheet = true
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill((store.isConnected ? VeloTheme.emerald : VeloTheme.amber).opacity(0.18))
                        .frame(width: 28, height: 28)
                    Circle()
                        .fill(store.isConnected ? VeloTheme.emerald : VeloTheme.amber)
                        .frame(width: 8.5, height: 8.5)
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(store.isConnected ? "Mac 守护进程在线" : "正在重连 Mac 守护进程…")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.primary)

                        if store.connectionConfig?.isEncryptedRelay == true {
                            HStack(spacing: 3) {
                                Image(systemName: "lock.shield.fill")
                                    .font(.system(size: 9.5, weight: .bold))
                                Text(store.isForwardSecretRatcheted ? "E2EE · FS" : "E2EE")
                                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                            }
                            .foregroundStyle(VeloTheme.emerald)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(VeloTheme.emerald.opacity(0.14), in: Capsule())
                        }
                    }

                    Text(store.connectionConfig?.displayTitle ?? "")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if runningCount > 0 {
                    HStack(spacing: 5) {
                        OrbitalStatusIcon(phase: .working)
                        Text("\(runningCount) 运行中")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(VeloTheme.accentVioletSoft)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(
                VeloTheme.cardSurface(colorScheme),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 1)
            )
        }
        .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
    }

    private var engineFilterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                filterCapsule(
                    title: "全部",
                    icon: "square.grid.2x2.fill",
                    count: store.sessions.count,
                    accent: VeloTheme.accentViolet,
                    isSelected: selectedEngineFilter == nil
                ) {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                        selectedEngineFilter = nil
                    }
                }

                ForEach(VeloEngineCategory.primaryCategories) { cat in
                    let count = store.sessions.filter { $0.engineCategory == cat }.count
                    filterCapsule(
                        title: cat.shortBadge,
                        icon: cat.iconName,
                        count: count,
                        accent: cat.accentColor,
                        isSelected: selectedEngineFilter == cat
                    ) {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                            selectedEngineFilter = (selectedEngineFilter == cat) ? nil : cat
                        }
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func filterCapsule(
        title: String,
        icon: String,
        count: Int,
        accent: Color,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(isSelected ? accent : .secondary)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isSelected ? .primary : .secondary)
                if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(isSelected ? accent : Color.secondary.opacity(0.6))
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 6.5)
            .background(
                isSelected ? accent.opacity(0.15) : VeloTheme.cardSurface(colorScheme),
                in: Capsule()
            )
            .overlay(
                Capsule()
                    .stroke(
                        isSelected ? accent.opacity(0.45) : VeloTheme.hairline(colorScheme),
                        lineWidth: 0.9
                    )
            )
        }
        .buttonStyle(VeloPressableButtonStyle())
    }

    private func projectSectionView(
        group: (repoRoot: String, projectName: String, sessions: [VeloSessionItem])
    ) -> some View {
        let isCollapsed = collapsedProjects.contains(group.repoRoot)
        let shortPath = group.repoRoot.replacingOccurrences(of: "/Users/daiyudai", with: "~")

        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        if isCollapsed {
                            collapsedProjects.remove(group.repoRoot)
                        } else {
                            collapsedProjects.insert(group.repoRoot)
                        }
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isCollapsed ? 0 : 90))

                        Image(systemName: "folder.fill")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(VeloTheme.accentVioletSoft)

                        Text(group.projectName)
                            .font(.system(size: 13.5, weight: .bold))
                            .foregroundStyle(.primary)

                        Text(shortPath)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)

                        Text("\(group.sessions.count)")
                            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                    }
                }
                .buttonStyle(.plain)

                Spacer(minLength: 4)

                Button {
                    prefillRepoForNewSession = group.repoRoot
                    showNewThreadSheet = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: Circle())
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
            .padding(.horizontal, 4)

            if !isCollapsed {
                if group.sessions.isEmpty {
                    Button {
                        prefillRepoForNewSession = group.repoRoot
                        showNewThreadSheet = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus.circle")
                                .font(.system(size: 12, weight: .medium))
                            Text("此目录暂无会话 · 点击新建")
                                .font(.system(size: 12.5))
                            Spacer()
                        }
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            VeloTheme.cardSurface(colorScheme).opacity(0.65),
                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.7)
                        )
                    }
                    .buttonStyle(VeloPressableButtonStyle(scale: 0.99))
                } else {
                    VStack(spacing: 9) {
                        ForEach(group.sessions) { session in
                            NavigationLink(value: session.id) {
                                SessionCardView(session: session)
                            }
                            .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
                            .contextMenu {
                                Button {
                                    renameDraftTitle = session.title
                                    renamingSessionId = session.id
                                } label: {
                                    Label("重命名会话", systemImage: "pencil")
                                }

                                Button {
                                    navigationPath.append(session.id)
                                } label: {
                                    Label("进入对话", systemImage: "bubble.left.and.bubble.right")
                                }

                                Button(role: .destructive) {
                                    Task { await store.deleteSession(session.id) }
                                } label: {
                                    Label("删除此会话", systemImage: "trash")
                                }
                            }
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var floatingNewSessionBar: some View {
        HStack {
            Spacer()
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                prefillRepoForNewSession = nil
                showNewThreadSheet = true
            } label: {
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(Color.white.opacity(0.2))
                            .frame(width: 24, height: 24)
                        Image(systemName: "plus")
                            .font(.system(size: 12.5, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    Text("新建对话")
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .padding(.leading, 10)
                .padding(.trailing, 16)
                .padding(.vertical, 10)
                .background(
                    LinearGradient(
                        colors: [
                            VeloTheme.accentViolet,
                            Color(red: 0.42, green: 0.28, blue: 0.92),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: Capsule()
                )
                .overlay(
                    Capsule()
                        .stroke(Color.white.opacity(0.25), lineWidth: 0.8)
                )
                .shadow(color: VeloTheme.accentViolet.opacity(0.35), radius: 14, x: 0, y: 6)
            }
            .buttonStyle(VeloPressableButtonStyle())
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
    }

    private var unpairedWelcomeState: some View {
        VStack(spacing: 20) {
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(VeloTheme.cardSurface(colorScheme))
                    .frame(width: 88, height: 88)
                    .overlay(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 1)
                    )
                Image(systemName: "bolt.horizontal.icloud.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
            }

            VStack(spacing: 8) {
                Text("Velo Mobile")
                    .font(.system(size: 23, weight: .bold))

                Text("扫描 Mac 端二维码，通过 ChaCha20-Poly1305 零信任盲中继随时随地操控本地 Claude Code、Codex、Antigravity 与 Grok。")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .padding(.horizontal, 32)
            }

            Button {
                showPairSheet = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "qrcode.viewfinder")
                    Text("扫码配对 Mac")
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .background(VeloTheme.accentViolet, in: Capsule())
            }
            .buttonStyle(VeloPressableButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyConnectedState: some View {
        VStack(spacing: 16) {
            connectionStatusCard
                .padding(.horizontal, 16)

            Spacer()

            ZStack {
                Circle()
                    .fill(VeloTheme.accentViolet.opacity(0.12))
                    .frame(width: 72, height: 72)
                Image(systemName: "sparkles.rectangle.stack.fill")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
            }

            Text("暂无活跃对话")
                .font(.system(size: 18, weight: .bold))

            Text(store.isConnected ? "选择引擎分类（Claude / Codex / AGY / Grok / Cursor），直接在真实项目目录中开启对话。" : (store.connectionError ?? "正在连接 Mac 守护进程…"))
                .font(.system(size: 13.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)

            Spacer()
        }
        .padding(.top, 8)
    }
}

// MARK: - Specular Session Card (Rare UI / BeUI)

private struct SessionCardView: View {
    let session: VeloSessionItem
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let cat = session.engineCategory
        let isRunning = session.status == .running
        let isWaiting = session.status == .waitingApproval

        VStack(alignment: .leading, spacing: 9) {
            // Row 1: Live Indicator + Engine Pill + Clean Session Title + Timestamp
            HStack(spacing: 7) {
                if isRunning {
                    OrbitalStatusIcon(phase: .working)
                } else if isWaiting {
                    OrbitalStatusIcon(phase: .waiting(label: ""))
                }

                EngineBadgePill(category: cat, compact: true)

                if isRunning {
                    ShimmerTextView(session.title, font: .system(size: 15, weight: .semibold))
                        .lineLimit(1)
                } else {
                    Text(session.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                Text(session.updatedAtLabel)
                    .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                    .foregroundStyle(.tertiary)
            }

            // Row 2: Model Chip + Workspace Ownership Badge + Handoff Tag + Git Diff Pill
            HStack(spacing: 6) {
                Text(session.modelShort)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                    .lineLimit(1)

                if session.isIsolatedWorktree {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 9.5, weight: .semibold))
                        Text(session.branchName)
                            .font(.system(size: 11, design: .monospaced))
                            .lineLimit(1)
                    }
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(VeloTheme.accentViolet.opacity(0.12), in: Capsule())
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "folder")
                            .font(.system(size: 9.5, weight: .medium))
                        Text(session.branchName)
                            .font(.system(size: 11, design: .monospaced))
                            .lineLimit(1)
                    }
                    .foregroundStyle(.tertiary)
                }

                if session.parentSessionId != nil {
                    Text("↗ 接力")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(VeloTheme.accentVioletSoft)
                }

                Spacer(minLength: 2)

                if session.tokensUsed > 0 {
                    Text("\(VeloFormatting.formatCompactTokens(session.tokensUsed)) tok")
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                if session.insertions > 0 || session.deletions > 0 {
                    HStack(spacing: 3.5) {
                        Text("+\(session.insertions)")
                            .foregroundStyle(VeloTheme.emerald)
                        Text("−\(session.deletions)")
                            .foregroundStyle(VeloTheme.coral)
                    }
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            VeloTheme.cardSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    isRunning
                        ? LinearGradient(
                            colors: [cat.accentColor.opacity(0.55), VeloTheme.accentViolet.opacity(0.25)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        : VeloTheme.specularRim(colorScheme),
                    lineWidth: isRunning ? 1.15 : 0.9
                )
        )
    }
}

// MARK: - Categorized New Session Sheet (Engine -> Filtered Models -> Effort -> In-Place Repo)

private struct NewSessionSheetView: View {
    @ObservedObject var store: VeloStore
    var initialRepoPath: String?
    var onCreated: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedCategory: VeloEngineCategory = .claude
    @State private var selectedModelId: String = "claude-fable-5-2"
    @State private var effort: String = "medium"
    @State private var repoPath: String = "/Users/daiyudai/code/velo"
    @State private var useWorktree: Bool = false
    @State private var branch: String = ""
    @State private var customTitle: String = ""
    @State private var prompt: String = ""
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pendingImages: [PendingComposerImage] = []
    @State private var isCreating: Bool = false

    private var categoryModels: [VeloModelOption] {
        let matched = store.models.filter { $0.category == selectedCategory }
        if !matched.isEmpty { return matched }
        return VeloModelOption.defaults.filter { $0.category == selectedCategory }
    }

    private var selectedModelOption: VeloModelOption {
        categoryModels.first(where: { $0.id == selectedModelId })
            ?? categoryModels.first
            ?? VeloModelOption.defaults[0]
    }

    private var recentRepos: [String] {
        var seen: Set<String> = []
        var result: [String] = []
        for ws in store.workspaces {
            let canon = VeloFormatting.canonicalWorkspacePath(ws)
            if !canon.isEmpty, !canon.hasSuffix("/.velo/workspace"), seen.insert(canon).inserted {
                result.append(canon)
            }
        }
        for s in store.sessions {
            let canon = VeloFormatting.canonicalWorkspacePath(s.repoRoot)
            if !canon.isEmpty, !canon.hasSuffix("/.velo/workspace"), seen.insert(canon).inserted {
                result.append(canon)
            }
        }
        if result.isEmpty {
            result.append("/Users/daiyudai/code/velo")
        }
        return result
    }

    var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // 1. Engine Category Cards
                        VStack(alignment: .leading, spacing: 9) {
                            sectionHeader("1. 选择对话引擎", subtitle: "单会话绑定单一引擎，彻底告别跨引擎串台")

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 9) {
                                    ForEach(VeloEngineCategory.primaryCategories) { cat in
                                        let isSelected = selectedCategory == cat
                                        let count = store.models.filter { $0.category == cat }.count
                                        Button {
                                            selectEngineCategory(cat)
                                        } label: {
                                            VStack(alignment: .leading, spacing: 8) {
                                                HStack {
                                                    ZStack {
                                                        Circle()
                                                            .fill(cat.accentColor.opacity(0.18))
                                                            .frame(width: 28, height: 28)
                                                        Image(systemName: cat.iconName)
                                                            .font(.system(size: 13, weight: .semibold))
                                                            .foregroundStyle(cat.accentColor)
                                                    }
                                                    Spacer()
                                                    if isSelected {
                                                        Image(systemName: "checkmark.circle.fill")
                                                            .font(.system(size: 14))
                                                            .foregroundStyle(cat.accentColor)
                                                    }
                                                }

                                                VStack(alignment: .leading, spacing: 2) {
                                                    Text(cat.vendor)
                                                        .font(.system(size: 10.5, weight: .semibold))
                                                        .foregroundStyle(.secondary)
                                                    Text(cat.title)
                                                        .font(.system(size: 13.5, weight: .bold))
                                                        .foregroundStyle(.primary)
                                                        .lineLimit(1)
                                                    Text("\(max(1, count)) 个模型")
                                                        .font(.system(size: 10.5))
                                                        .foregroundStyle(.tertiary)
                                                }
                                            }
                                            .padding(12)
                                            .frame(width: 132, alignment: .leading)
                                            .background(
                                                isSelected
                                                    ? cat.accentColor.opacity(0.11)
                                                    : VeloTheme.cardSurface(colorScheme),
                                                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 15, style: .continuous)
                                                    .stroke(
                                                        isSelected
                                                            ? cat.accentColor.opacity(0.65)
                                                            : VeloTheme.hairline(colorScheme),
                                                        lineWidth: isSelected ? 1.4 : 0.85
                                                    )
                                            )
                                        }
                                        .buttonStyle(VeloPressableButtonStyle())
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }

                        // 2. Filtered Models inside Selected Engine
                        VStack(alignment: .leading, spacing: 9) {
                            sectionHeader("2. 选择 \(selectedCategory.title) 模型", subtitle: "同引擎内后续可随时无损切换模型")

                            VStack(spacing: 7) {
                                ForEach(categoryModels) { m in
                                    let isSelected = m.id == selectedModelOption.id
                                    Button {
                                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                        withAnimation(.snappy(duration: 0.2)) {
                                            selectedModelId = m.id
                                        }
                                    } label: {
                                        HStack(spacing: 10) {
                                            VStack(alignment: .leading, spacing: 3) {
                                                HStack(spacing: 6) {
                                                    Text(m.cleanTitle)
                                                        .font(.system(size: 14, weight: .semibold))
                                                        .foregroundStyle(.primary)
                                                    if m.isDefault {
                                                        Text("默认")
                                                            .font(.system(size: 10, weight: .bold))
                                                            .foregroundStyle(selectedCategory.accentColor)
                                                            .padding(.horizontal, 6)
                                                            .padding(.vertical, 1.5)
                                                            .background(selectedCategory.accentColor.opacity(0.14), in: Capsule())
                                                    }
                                                }
                                                Text(m.cleanSubtitle)
                                                    .font(.system(size: 11.5))
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(1)
                                            }
                                            Spacer()
                                            Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                                                .font(.system(size: 16, weight: .semibold))
                                                .foregroundStyle(isSelected ? selectedCategory.accentColor : Color.secondary.opacity(0.4))
                                        }
                                        .padding(.horizontal, 13)
                                        .padding(.vertical, 10.5)
                                        .background(
                                            isSelected
                                                ? selectedCategory.accentColor.opacity(0.09)
                                                : VeloTheme.cardSurface(colorScheme),
                                            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                                .stroke(
                                                    isSelected
                                                        ? selectedCategory.accentColor.opacity(0.5)
                                                        : VeloTheme.hairline(colorScheme),
                                                    lineWidth: isSelected ? 1.15 : 0.8
                                                )
                                        )
                                    }
                                    .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
                                }
                            }
                        }

                        // 3. Effort Capsules
                        VStack(alignment: .leading, spacing: 9) {
                            sectionHeader("3. 推理强度 (Effort)", subtitle: nil)

                            HStack(spacing: 8) {
                                ForEach(selectedCategory.supportedEfforts, id: \.self) { lv in
                                    let isSel = effort == lv
                                    Button {
                                        withAnimation(.snappy(duration: 0.18)) {
                                            effort = lv
                                        }
                                    } label: {
                                        Text(lv.uppercased())
                                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                                            .foregroundStyle(isSel ? .white : .secondary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 9)
                                            .background(
                                                isSel ? selectedCategory.accentColor : VeloTheme.cardSurface(colorScheme),
                                                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                                            )
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: isSel ? 0 : 0.8)
                                            )
                                    }
                                    .buttonStyle(VeloPressableButtonStyle())
                                }
                            }
                        }

                        // 4. Project Ownership & Optional Git Worktree
                        VStack(alignment: .leading, spacing: 9) {
                            sectionHeader("4. 所属项目目录", subtitle: "默认直接在真实项目目录运行，或点「快速对话」零目录直接开聊")

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    let quickPath = "~/.velo/workspace"
                                    let isQuick = repoPath == quickPath
                                    Button {
                                        repoPath = quickPath
                                    } label: {
                                        HStack(spacing: 4) {
                                            Image(systemName: "bolt.fill")
                                                .font(.system(size: 10.5))
                                            Text("快速对话（默认空间）")
                                                .font(.system(size: 12, weight: .semibold))
                                        }
                                        .foregroundStyle(isQuick ? VeloTheme.emerald : .secondary)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(
                                            isQuick ? VeloTheme.emerald.opacity(0.14) : VeloTheme.cardSurface(colorScheme),
                                            in: Capsule()
                                        )
                                    }
                                    .buttonStyle(.plain)

                                    ForEach(recentRepos.filter { $0 != quickPath }, id: \.self) { rp in
                                        let name = URL(fileURLWithPath: rp).lastPathComponent
                                        let isCur = repoPath == rp
                                        Button {
                                            repoPath = rp
                                        } label: {
                                            HStack(spacing: 4) {
                                                Image(systemName: "folder.fill")
                                                    .font(.system(size: 10.5))
                                                Text(name)
                                                    .font(.system(size: 12, weight: .semibold))
                                            }
                                            .foregroundStyle(isCur ? VeloTheme.accentVioletSoft : .secondary)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 6)
                                            .background(
                                                isCur ? VeloTheme.accentViolet.opacity(0.14) : VeloTheme.cardSurface(colorScheme),
                                                in: Capsule()
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }

                            VStack(spacing: 10) {
                                TextField("项目路径", text: $repoPath)
                                    .font(.system(size: 13, design: .monospaced))
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(11)
                                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                                Toggle(isOn: $useWorktree.animation(.snappy(duration: 0.2))) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("创建隔离 Git Worktree 副本")
                                            .font(.system(size: 13.5, weight: .semibold))
                                        Text("仅在需要多 Agent 同时改同一仓库互不干扰时开启")
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .tint(VeloTheme.accentViolet)

                                if useWorktree {
                                    TextField("新分支名称（留空自动生成）", text: $branch)
                                        .font(.system(size: 13, design: .monospaced))
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                        .padding(11)
                                        .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                            }
                            .padding(13)
                            .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                            )
                        }

                        // 5. Optional Session Title & Initial Task Prompt
                        initialPromptSection
                    }
                    .padding(16)
                }
            }
            .navigationTitle("新建对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    confirmToolbarButton
                }
            }
            .onChange(of: pickerItems) { _, newItems in
                handlePickedItems(newItems)
            }
            .onAppear {
                handleOnAppear()
            }
        }
    }

    private func selectEngineCategory(_ cat: VeloEngineCategory) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let defModel: VeloModelOption? = {
            if let m = store.models.first(where: { $0.category == cat && $0.isDefault }) { return m }
            if let m = store.models.first(where: { $0.category == cat }) { return m }
            return VeloModelOption.defaults.first(where: { $0.category == cat })
        }()
        withAnimation(.spring(response: 0.26, dampingFraction: 0.8)) {
            selectedCategory = cat
            if let defModel {
                selectedModelId = defModel.id
            }
            if !cat.supportedEfforts.contains(effort) {
                effort = cat.supportedEfforts.contains("high") ? "high" : "medium"
            }
        }
    }

    private var initialPromptSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("5. 会话名称与首条消息（选填）", subtitle: "名称留空将按首条消息自动命名；消息留空将创建干净会话")

            TextField("会话名称（选填，例如：修复登录鉴权）", text: $customTitle)
                .font(.system(size: 14))
                .padding(12)
                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                )

            TextField("输入任务需求，或留空直接进入对话…", text: $prompt, axis: .vertical)
                .lineLimit(3...6)
                .font(.system(size: 14.5))
                .padding(13)
                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                )

            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingImages) { item in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: item.preview)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 60, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .overlay {
                                        if item.isUploading {
                                            ZStack {
                                                Color.black.opacity(0.35)
                                                ProgressView().tint(.white).scaleEffect(0.75)
                                            }
                                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                        }
                                    }
                                Button {
                                    pendingImages.removeAll { $0.id == item.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 16))
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, Color.black.opacity(0.72))
                                }
                                .offset(x: 4, y: -4)
                            }
                            .padding(.top, 4)
                            .padding(.trailing, 4)
                        }
                    }
                }
            }

            PhotosPicker(
                selection: $pickerItems,
                maxSelectionCount: max(1, 4 - pendingImages.count),
                matching: .images
            ) {
                HStack(spacing: 6) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 12.5, weight: .semibold))
                    Text("添加截图 / 参考图（自动压缩加密直传）")
                        .font(.system(size: 12.5, weight: .medium))
                }
                .foregroundStyle(VeloTheme.accentVioletSoft)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(VeloTheme.accentViolet.opacity(0.11), in: Capsule())
            }
            .disabled(pendingImages.count >= 4)
        }
    }

    private var confirmToolbarButton: some View {
        let uploadedPaths = pendingImages.compactMap(\.uploadedPath)
        let isUploadingAny = pendingImages.contains(where: \.isUploading)
        let hasPrompt = !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !uploadedPaths.isEmpty
        let label = isCreating ? "创建中…" : (hasPrompt ? "立即启动" : "进入对话")
        let isDisabled = isCreating || isUploadingAny || repoPath.trimmingCharacters(in: .whitespaces).isEmpty
        return Button(label) {
            isCreating = true
            Task {
                await store.addWorkspace(repoPath)
                let cleanCustomTitle = customTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                let createdId = await store.createNewSession(
                    title: cleanCustomTitle.isEmpty ? nil : cleanCustomTitle,
                    prompt: prompt,
                    repoPath: repoPath,
                    branch: (useWorktree && !branch.isEmpty) ? branch : nil,
                    modelOption: selectedModelOption,
                    effort: effort,
                    images: uploadedPaths,
                    useWorktree: useWorktree
                )
                isCreating = false
                dismiss()
                onCreated(createdId)
            }
        }
        .fontWeight(.semibold)
        .disabled(isDisabled)
    }

    private func handlePickedItems(_ newItems: [PhotosPickerItem]) {
        guard !newItems.isEmpty else { return }
        let picked = newItems
        pickerItems = []
        Task {
            for (i, item) in picked.enumerated() {
                guard pendingImages.count < 4,
                      let rawData = try? await item.loadTransferable(type: Data.self),
                      let rawImg = UIImage(data: rawData),
                      let compressed = VeloAttachmentCache.compressForAgentUpload(rawImg)
                else { continue }
                let fname = "init-\(Int(Date().timeIntervalSince1970))-\(i).jpg"
                let entry = PendingComposerImage(
                    preview: compressed.preview,
                    jpegData: compressed.jpegData,
                    filename: fname
                )
                let eid = entry.id
                pendingImages.append(entry)
                Task {
                    let savedPath = await store.uploadAttachment(
                        jpegData: compressed.jpegData,
                        preview: compressed.preview,
                        filename: fname
                    )
                    if let idx = pendingImages.firstIndex(where: { $0.id == eid }) {
                        if let savedPath {
                            pendingImages[idx].uploadedPath = savedPath
                        } else {
                            pendingImages[idx].uploadFailed = true
                        }
                    }
                }
            }
        }
    }

    private func handleOnAppear() {
        if let initRepo = initialRepoPath, !initRepo.isEmpty {
            repoPath = initRepo
        } else if let activeRepo = store.sessions.first?.repoRoot, !activeRepo.isEmpty {
            repoPath = activeRepo
        }
        if let activeCat = store.sessions.first?.engineCategory, activeCat != .other {
            selectedCategory = activeCat
        }
        let defModel = store.models.first(where: { $0.category == selectedCategory && $0.isDefault })
            ?? store.models.first(where: { $0.category == selectedCategory })
        if let defModel {
            selectedModelId = defModel.id
        }
        if selectedCategory == .codex || selectedCategory == .grok {
            effort = "high"
        }
    }

    private func sectionHeader(_ title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.primary)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
            }
        }
    }
}
