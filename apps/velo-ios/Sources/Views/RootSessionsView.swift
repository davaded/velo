import PhotosUI
import SwiftUI
import UIKit

// MARK: - Root 3-Tab Native iOS Architecture (Monochrome Editorial + 120fps Pure Solid Lists)

public struct RootSessionsView: View {
    public enum AppTab: Hashable {
        case sessions
        case insights
        case control
    }

    @ObservedObject var store: VeloStore
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedTab: AppTab = .sessions
    @State private var navigationPath: [String] = []
    @State private var showPairSheet = false
    @State private var showNewTray = false
    @State private var prefillRepoForNewSession: String?
    @State private var showCliImportSheet = false
    @State private var showRemoteHostsSheet = false
    @State private var showAppearanceSheet = false
    @State private var showAnalyticsModal = false
    @State private var analyticsModalTab: VeloAnalyticsHubSheet.HubTab = .search

    // Home list states
    @State private var showArchivedSection = false
    @State private var repoFolderState: [String: String] = RootSessionsView.loadFolderState()
    @State private var expandedProjects: Set<String> = []
    @State private var openSwipeSessionId: String? = nil
    @State private var refreshingQuotas: Bool = false
    @State private var renamingSessionId: String?
    @State private var renameDraftTitle: String = ""
    @State private var relocatingFolderOldPath: String?
    @State private var relocatingSessionId: String?
    @State private var relocateDraftPath: String = ""
    @State private var pendingDeleteSessionId: String?
    @State private var pendingDeleteSessionTitle: String = ""
    @Namespace private var heroZoomNS

    public init(store: VeloStore) {
        self.store = store
    }

    private var tokens: VeloPaletteTokens {
        VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
    }

    private var activeSessions: [VeloSessionItem] {
        store.sessions.filter { !$0.isArchived }
    }

    private var liveSessions: [VeloSessionItem] {
        activeSessions.filter { $0.status == .running || $0.status == .waitingApproval }
    }

    private var archivedSessions: [VeloSessionItem] {
        store.sessions.filter { $0.isArchived }
    }

    private var groupedByProject: [(repoRoot: String, projectName: String, sessions: [VeloSessionItem])] {
        var order: [String] = []
        var bucket: [String: [VeloSessionItem]] = [:]
        for s in activeSessions {
            let root = VeloFormatting.canonicalWorkspacePath(s.repoRoot)
            if bucket[root] == nil { order.append(root) }
            bucket[root, default: []].append(s)
        }
        for rawWs in store.workspaces {
            let root = VeloFormatting.canonicalWorkspacePath(rawWs)
            guard !root.isEmpty, !root.hasSuffix("/.velo/workspace"), bucket[root] == nil else { continue }
            order.append(root)
            bucket[root] = []
        }
        return order.map { root in
            let list = bucket[root] ?? []
            let name = list.first?.projectName ?? URL(fileURLWithPath: root).lastPathComponent
            return (root, name.isEmpty ? "workspace" : name, list)
        }
    }

    private static let folderStateDefaultsKey = "velo.repoFolderState.v2"

    private static func loadFolderState() -> [String: String] {
        (UserDefaults.standard.dictionary(forKey: folderStateDefaultsKey) as? [String: String]) ?? [:]
    }

    private func saveFolderState(_ state: [String: String]) {
        UserDefaults.standard.set(state, forKey: Self.folderStateDefaultsKey)
    }

    private func isFolderCollapsed(_ repoRoot: String, sessionCount: Int) -> Bool {
        if let explicit = repoFolderState[repoRoot] {
            return explicit == "closed"
        }
        // Expand every active project with sessions by default (matches design mockup density!)
        return sessionCount == 0
    }

    public var body: some View {
        ZStack {
            TabView(selection: $selectedTab) {
                sessionsTab
                    .tabItem {
                        Label("会话", systemImage: "bubble.left.and.bubble.right")
                    }
                    .tag(AppTab.sessions)

                insightsTab
                    .tabItem {
                        Label("配额账单", systemImage: "chart.pie")
                    }
                    .tag(AppTab.insights)

                controlTab
                    .tabItem {
                        Label("控制中心", systemImage: "slider.horizontal.3")
                    }
                    .tag(AppTab.control)
            }
            .tint(tokens.accentText)

            // Family-Style Dynamic Morphing New-Session Tray (Zero 5-Step Form Friction!)
            if showNewTray {
                FamilyNewSessionTray(
                    store: store,
                    initialRepoPath: prefillRepoForNewSession,
                    onDismiss: {
                        withAnimation(VeloMotion.crisp) {
                            showNewTray = false
                        }
                    },
                    onCreated: { createdId in
                        withAnimation(VeloMotion.crisp) {
                            showNewTray = false
                        }
                        if let createdId {
                            selectedTab = .sessions
                            navigationPath = [createdId]
                        }
                    }
                )
                .zIndex(50)
            }
        }
        .onChange(of: selectedTab) { _, _ in
            VeloHaptics.selection()
        }
        .onChange(of: store.deepLinkTargetSessionId) { _, targetSid in
            guard let targetSid, !targetSid.isEmpty else { return }
            store.deepLinkTargetSessionId = nil
            selectedTab = .sessions
            if navigationPath.last != targetSid {
                navigationPath = [targetSid]
            }
        }
        .onChange(of: store.latestCreatedOrHandoffSessionId) { _, newSid in
            guard let newSid, !newSid.isEmpty else { return }
            selectedTab = .sessions
            if navigationPath.last != newSid {
                if navigationPath.isEmpty {
                    navigationPath = [newSid]
                } else {
                    navigationPath[navigationPath.count - 1] = newSid
                }
            }
            store.latestCreatedOrHandoffSessionId = nil
        }
        .sheet(isPresented: $showPairSheet) {
            PairingSheetView(store: store)
        }
        .sheet(isPresented: $showCliImportSheet) {
            VeloCliSessionsSheet(store: store) { importedSid in
                selectedTab = .sessions
                navigationPath = [importedSid]
            }
        }
        .sheet(isPresented: $showRemoteHostsSheet) {
            VeloRemoteHostsSheet(store: store) {
                showPairSheet = true
            }
        }
        .sheet(isPresented: $showAppearanceSheet) {
            VeloAppearanceSettingsSheet()
        }
        .sheet(isPresented: $showAnalyticsModal) {
            VeloAnalyticsHubSheet(store: store, initialTab: analyticsModalTab) { targetSid in
                store.activeSessionId = targetSid
                Task { await store.loadEventsForSession(targetSid) }
                selectedTab = .sessions
                navigationPath = [targetSid]
            }
        }
    }

    // MARK: - TAB 1: Sessions Home (Exact Design Mockup: Inline Header + Live Hero + Crisp Bordered Inset Cards)

    private var sessionsTab: some View {
        NavigationStack(path: $navigationPath) {
            VStack(spacing: 0) {
                // Crisp Mockup Top Header (Zero iOS 26 Liquid Glass Pill-in-Pill Blob!)
                HStack(spacing: 10) {
                    Text("Velo")
                        .font(.system(size: 28, weight: .bold))
                        .tracking(-0.6)
                        .foregroundStyle(.primary)

                    if store.connectionConfig != nil {
                        Button {
                            VeloHaptics.tap()
                            selectedTab = .control
                        } label: {
                            HStack(spacing: 5.5) {
                                Circle()
                                    .fill(store.isConnected ? VeloTheme.emerald : VeloTheme.amber)
                                    .frame(width: 6.5, height: 6.5)
                                Text(store.isConnected ? "Mac 在线" : "重连中")
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(tokens.elevated, in: Capsule())
                        }
                        .buttonStyle(VeloPressableButtonStyle(scale: 0.96))
                    }

                    Spacer()

                    if store.connectionConfig != nil {
                        Button {
                            VeloHaptics.tap()
                            openSwipeSessionId = nil
                            prefillRepoForNewSession = nil
                            withAnimation(VeloMotion.crisp) {
                                showNewTray = true
                            }
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(tokens.accentForeground)
                                .frame(width: 34, height: 34)
                                .background(tokens.accent, in: Circle())
                        }
                        .buttonStyle(VeloPressableButtonStyle(scale: 0.93))
                        .accessibilityLabel("新建对话")
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 10)

                Group {
                    if store.connectionConfig == nil {
                        unpairedWelcomeView
                    } else if store.sessions.isEmpty && store.workspaces.isEmpty {
                        emptyConnectedView
                    } else {
                        sessionsListContent
                    }
                }
            }
            .background(tokens.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { sessionId in
                let dest = ChatThreadView(store: store, sessionId: sessionId) { handoffNewId in
                    if !navigationPath.isEmpty {
                        navigationPath[navigationPath.count - 1] = handoffNewId
                    } else {
                        navigationPath.append(handoffNewId)
                    }
                }
                .toolbar(.visible, for: .navigationBar)
                .toolbar(.hidden, for: .tabBar)
                if #available(iOS 18.0, *),
                   !appearance.reduceMotion,
                   liveSessions.contains(where: { $0.id == sessionId })
                {
                    dest.navigationTransition(.zoom(sourceID: "hero-\(sessionId)", in: heroZoomNS))
                } else {
                    dest
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
                Button("取消", role: .cancel) { renamingSessionId = nil }
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
            .alert(
                relocatingSessionId != nil ? "修改会话归属目录" : "修改文件夹归属路径",
                isPresented: Binding(
                    get: { relocatingFolderOldPath != nil || relocatingSessionId != nil },
                    set: {
                        if !$0 {
                            relocatingFolderOldPath = nil
                            relocatingSessionId = nil
                        }
                    }
                )
            ) {
                TextField("/Users/you/code/project", text: $relocateDraftPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("取消", role: .cancel) {
                    relocatingFolderOldPath = nil
                    relocatingSessionId = nil
                }
                Button("保存路径") {
                    let targetNew = relocateDraftPath
                    let sid = relocatingSessionId
                    let oldFolder = relocatingFolderOldPath
                    relocatingSessionId = nil
                    relocatingFolderOldPath = nil
                    Task {
                        if let sid {
                            await store.moveSessionToRepo(sessionId: sid, newRepoPath: targetNew)
                        } else if let oldFolder {
                            await store.relocateWorkspace(oldPath: oldFolder, newPath: targetNew)
                        }
                    }
                }
            }
            .alert(
                "删除会话？",
                isPresented: Binding(
                    get: { pendingDeleteSessionId != nil },
                    set: { if !$0 { pendingDeleteSessionId = nil } }
                )
            ) {
                Button("取消", role: .cancel) { pendingDeleteSessionId = nil }
                Button("永久删除", role: .destructive) {
                    if let sid = pendingDeleteSessionId {
                        pendingDeleteSessionId = nil
                        Task { await store.deleteSession(sid) }
                    }
                }
            } message: {
                Text("将永久删除「\(pendingDeleteSessionTitle)」，对话记录会一起清掉。")
            }
        }
    }

    private var sessionsListContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                // 1. Flighty-Style LIVE HERO SECTION (Full 16pt alignment, zero double-indent!)
                if !liveSessions.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("正在进行 · \(liveSessions.count)")
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text("轻点进入")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 4)

                        VStack(spacing: 10) {
                            ForEach(liveSessions) { session in
                                liveHeroRow(for: session)
                            }
                        }
                    }
                }

                // 2. Things 3 / Linear Crisp Bordered Solid Inset Cards (ZERO `>` Chevrons, 120fps!)
                ForEach(groupedByProject, id: \.repoRoot) { group in
                    let collapsed = isFolderCollapsed(group.repoRoot, sessionCount: group.sessions.count)
                    let isExpandedAll = expandedProjects.contains(group.repoRoot)
                    let visibleSessions = (isExpandedAll || group.sessions.count <= 5)
                        ? group.sessions
                        : Array(group.sessions.prefix(5))
                    let hiddenCount = max(0, group.sessions.count - visibleSessions.count)

                    VStack(alignment: .leading, spacing: 7) {
                        // Compact Section Header
                        HStack(spacing: 6) {
                            Button {
                                VeloHaptics.selection()
                                withAnimation(VeloMotion.crisp) {
                                    var next = repoFolderState
                                    next[group.repoRoot] = collapsed ? "open" : "closed"
                                    repoFolderState = next
                                    saveFolderState(next)
                                }
                            } label: {
                                HStack(spacing: 5.5) {
                                    Text(group.projectName)
                                        .font(.system(size: 12.5, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                    Text("\(group.sessions.count)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                    if collapsed {
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Spacer()

                            Button {
                                VeloHaptics.tap()
                                openSwipeSessionId = nil
                                prefillRepoForNewSession = group.repoRoot
                                withAnimation(VeloMotion.crisp) {
                                    showNewTray = true
                                }
                            } label: {
                                Image(systemName: "plus")
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 24, height: 22)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 4)

                        if !collapsed {
                            VStack(spacing: 0) {
                                if group.sessions.isEmpty {
                                    Button {
                                        VeloHaptics.tap()
                                        prefillRepoForNewSession = group.repoRoot
                                        withAnimation(VeloMotion.crisp) {
                                            showNewTray = true
                                        }
                                    } label: {
                                        HStack(spacing: 8) {
                                            Image(systemName: "plus.circle")
                                                .font(.system(size: 13))
                                            Text("暂无会话 · 轻点新建")
                                                .font(.system(size: 13))
                                            Spacer()
                                        }
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 12)
                                    }
                                    .buttonStyle(.plain)
                                } else {
                                    ForEach(Array(visibleSessions.enumerated()), id: \.element.id) { idx, session in
                                        if idx > 0 {
                                            Rectangle()
                                                .fill(tokens.divider)
                                                .frame(height: 0.6)
                                                .padding(.leading, 42)
                                        }

                                        SwipeableSessionRow(
                                            session: session,
                                            isUnread: store.unreadSessionIds.contains(session.id),
                                            tokens: tokens,
                                            isSwipeOpen: openSwipeSessionId == session.id,
                                            onSetSwipeOpen: { open in
                                                withAnimation(VeloMotion.crisp) {
                                                    openSwipeSessionId = open ? session.id : nil
                                                }
                                            },
                                            onTap: {
                                                if openSwipeSessionId != nil {
                                                    withAnimation(VeloMotion.crisp) { openSwipeSessionId = nil }
                                                    return
                                                }
                                                VeloHaptics.tap()
                                                navigationPath.append(session.id)
                                            },
                                            onArchive: {
                                                VeloHaptics.tap()
                                                openSwipeSessionId = nil
                                                Task { await store.archiveSession(session.id, archived: true) }
                                            },
                                            onDelete: {
                                                VeloHaptics.warning()
                                                openSwipeSessionId = nil
                                                pendingDeleteSessionTitle = session.title
                                                pendingDeleteSessionId = session.id
                                            }
                                        )
                                        .contextMenu {
                                            Button {
                                                renameDraftTitle = session.title
                                                renamingSessionId = session.id
                                            } label: {
                                                Label("重命名会话", systemImage: "pencil")
                                            }

                                            Button {
                                                relocateDraftPath = session.repoRoot
                                                relocatingFolderOldPath = nil
                                                relocatingSessionId = session.id
                                            } label: {
                                                Label("修改归属目录", systemImage: "folder.badge.gearshape")
                                            }

                                            Button {
                                                Task { await store.archiveSession(session.id, archived: true) }
                                            } label: {
                                                Label("归档会话", systemImage: "archivebox")
                                            }

                                            Button(role: .destructive) {
                                                pendingDeleteSessionTitle = session.title
                                                pendingDeleteSessionId = session.id
                                            } label: {
                                                Label("永久删除", systemImage: "trash")
                                            }
                                        }
                                    }

                                    if hiddenCount > 0 {
                                        Rectangle()
                                            .fill(tokens.divider)
                                            .frame(height: 0.6)
                                            .padding(.leading, 14)

                                        Button {
                                            VeloHaptics.selection()
                                            withAnimation(VeloMotion.crisp) {
                                                expandedProjects.insert(group.repoRoot)
                                            }
                                        } label: {
                                            HStack {
                                                Text("展开其余 \(hiddenCount) 条会话")
                                                    .font(.system(size: 12, weight: .medium))
                                                    .foregroundStyle(.secondary)
                                                Spacer()
                                                Image(systemName: "chevron.down")
                                                    .font(.system(size: 10, weight: .semibold))
                                                    .foregroundStyle(.tertiary)
                                            }
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 10)
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                            .background(tokens.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(tokens.divider, lineWidth: 0.85)
                            )
                        }
                    }
                }

                // 3. Collapsible Archived Sessions
                if !archivedSessions.isEmpty {
                    VStack(alignment: .leading, spacing: 7) {
                        Button {
                            VeloHaptics.selection()
                            withAnimation(VeloMotion.crisp) {
                                showArchivedSection.toggle()
                            }
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9.5, weight: .bold))
                                    .rotationEffect(.degrees(showArchivedSection ? 90 : 0))
                                Text("已归档 (\(archivedSessions.count))")
                                    .font(.system(size: 12, weight: .semibold))
                                Spacer()
                            }
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 4)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if showArchivedSection {
                            VStack(spacing: 0) {
                                ForEach(Array(archivedSessions.enumerated()), id: \.element.id) { idx, arch in
                                    if idx > 0 {
                                        Rectangle()
                                            .fill(tokens.divider)
                                            .frame(height: 0.6)
                                            .padding(.leading, 42)
                                    }
                                    Button {
                                        VeloHaptics.tap()
                                        navigationPath.append(arch.id)
                                    } label: {
                                        HStack(spacing: 11) {
                                            VeloBrandIcon(provider: arch.agentKind, size: 15, colored: false)
                                                .foregroundStyle(.secondary)
                                                .frame(width: 20, height: 20)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(arch.title)
                                                    .font(.system(size: 14, weight: .medium))
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(1)
                                                Text("\(arch.projectName) · \(arch.branchName)")
                                                    .font(.system(size: 11, design: .monospaced))
                                                    .foregroundStyle(.tertiary)
                                                    .lineLimit(1)
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 11)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        Button {
                                            Task { await store.archiveSession(arch.id, archived: false) }
                                        } label: {
                                            Label("恢复会话", systemImage: "tray.and.arrow.up")
                                        }
                                        Button(role: .destructive) {
                                            pendingDeleteSessionTitle = arch.title
                                            pendingDeleteSessionId = arch.id
                                        } label: {
                                            Label("永久删除", systemImage: "trash")
                                        }
                                    }
                                }
                            }
                            .background(tokens.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(tokens.divider, lineWidth: 0.85)
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 28)
        }
        .background(tokens.canvas)
        .refreshable {
            if !store.isConnected && store.connectionConfig != nil {
                store.connect()
            }
            await store.refreshSessionsAndActiveEvents()
            await store.fetchQuotas()
        }
    }

    @ViewBuilder
    private func liveHeroRow(for session: VeloSessionItem) -> some View {
        let isWaiting = session.status == .waitingApproval
        let pendingApproval = store.pendingApprovals[session.id]

        let cardBody = VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                VeloBrandIcon(provider: session.agentKind, size: 15, colored: true)

                Text(isWaiting ? "等待审批 · \(session.projectName)" : "\(session.engineCategory.shortBadge) · \(session.projectName)")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(isWaiting ? VeloTheme.amber : tokens.accentText)
                    .lineLimit(1)

                Spacer()

                if isWaiting {
                    Text("待确认")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(VeloTheme.amber)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(VeloTheme.amber.opacity(0.15), in: Capsule())
                } else {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(VeloTheme.emerald)
                            .frame(width: 6, height: 6)
                        Text("运行中")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Text(session.title)
                .font(.system(size: 15.5, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)

            if isWaiting, let approval = pendingApproval {
                Text(approval.commandPreview)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(tokens.codeBg, in: RoundedRectangle(cornerRadius: 9, style: .continuous))

                HStack(spacing: 8) {
                    Button {
                        VeloHaptics.warning()
                        Task { await store.resolveApproval(sessionId: session.id, requestId: approval.id, approve: false) }
                    } label: {
                        Text("拒绝")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(tokens.elevated, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                    .buttonStyle(VeloPressableButtonStyle())

                    Button {
                        VeloHaptics.success()
                        Task { await store.resolveApproval(sessionId: session.id, requestId: approval.id, approve: true) }
                    } label: {
                        Text("允许执行")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(tokens.accentForeground)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(tokens.accent, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }
            } else {
                HStack(spacing: 8) {
                    Text("\(session.modelShort) · \(session.branchName)")
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if session.insertions > 0 || session.deletions > 0 {
                        HStack(spacing: 3) {
                            Text("+\(session.insertions)").foregroundStyle(VeloTheme.emerald)
                            Text("−\(session.deletions)").foregroundStyle(VeloTheme.coral)
                        }
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .contentTransition(.numericText())
                    }
                }
            }
        }
        .padding(14)
        .background {
            let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
            ZStack {
                shape.fill(tokens.surface)
                shape.fill(
                    RadialGradient(
                        colors: [
                            (isWaiting ? VeloTheme.amber.opacity(colorScheme == .dark ? 0.14 : 0.09) : tokens.heroTint),
                            Color.clear,
                        ],
                        center: .topLeading,
                        startRadius: 8,
                        endRadius: 210
                    )
                )
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(isWaiting ? VeloTheme.amber.opacity(0.38) : tokens.border, lineWidth: 0.9)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture {
            VeloHaptics.tap()
            navigationPath.append(session.id)
        }

        if #available(iOS 18.0, *), !appearance.reduceMotion {
            cardBody.matchedTransitionSource(id: "hero-\(session.id)", in: heroZoomNS)
        } else {
            cardBody
        }
    }

    private var unpairedWelcomeView: some View {
        VStack(spacing: 24) {
            Spacer()

            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(tokens.surface)
                    .frame(width: 82, height: 82)
                    .overlay(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .stroke(tokens.border, lineWidth: 0.9)
                    )
                Text("V")
                    .font(.system(size: 38, weight: .heavy, design: .rounded))
                    .foregroundStyle(.primary)
            }

            VStack(spacing: 8) {
                Text("Velo")
                    .font(.system(size: 26, weight: .bold))
                Text("扫一下 Mac 端二维码，离开电脑也能随时遥控 Claude、Codex、Antigravity 与 Cursor。")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3.5)
                    .padding(.horizontal, 36)
            }

            HStack(spacing: 16) {
                VeloBrandIcon(provider: "claude", size: 20, colored: true)
                VeloBrandIcon(provider: "codex", size: 20, colored: true)
                VeloBrandIcon(provider: "antigravity", size: 20, colored: true)
                VeloBrandIcon(provider: "cursor", size: 20, colored: true)
                VeloBrandIcon(provider: "grok", size: 20, colored: true)
            }
            .padding(.vertical, 6)

            Button {
                VeloHaptics.medium()
                showPairSheet = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 15, weight: .semibold))
                    Text("扫码配对 Mac")
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tokens.accentForeground)
                .padding(.horizontal, 28)
                .padding(.vertical, 13.5)
                .background(tokens.accent, in: Capsule())
            }
            .buttonStyle(VeloPressableButtonStyle(scale: 0.96))

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyConnectedView: some View {
        VStack(spacing: 16) {
            Spacer()
            HStack(spacing: 14) {
                VeloBrandIcon(provider: "claude", size: 20, colored: true)
                VeloBrandIcon(provider: "codex", size: 20, colored: true)
                VeloBrandIcon(provider: "antigravity", size: 20, colored: true)
                VeloBrandIcon(provider: "cursor", size: 20, colored: true)
            }
            Text("还没有对话")
                .font(.system(size: 18, weight: .bold))
            Text("点右上角「+」新建对话，直接选项目和模型开聊。")
                .font(.system(size: 13.5))
                .foregroundStyle(.secondary)
            Button {
                VeloHaptics.medium()
                prefillRepoForNewSession = nil
                withAnimation(VeloMotion.crisp) { showNewTray = true }
            } label: {
                Text("新建对话")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tokens.accentForeground)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 11)
                    .background(tokens.accent, in: Capsule())
            }
            .buttonStyle(VeloPressableButtonStyle())
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - TAB 2: Copilot Money-Style Ring Quotas & Transparent Billing

    private var insightsTab: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Text("配额与账单")
                        .font(.system(size: 28, weight: .bold))
                        .tracking(-0.6)
                    Spacer()
                    Button {
                        VeloHaptics.tap()
                        refreshingQuotas = true
                        Task {
                            await store.fetchQuotas()
                            await store.fetchUsageAnalytics()
                            refreshingQuotas = false
                        }
                    } label: {
                        HStack(spacing: 4.5) {
                            if refreshingQuotas {
                                ProgressView().scaleEffect(0.65)
                            }
                            Text(refreshingQuotas ? "同步中" : "实时同步")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle(scale: 0.96))
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 10)

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                    // 1. Dual Ring Quota Grid
                    let subCards = store.quotaCards.filter { $0.mode == "subscription" && !$0.windows.isEmpty }
                    let otherCards = store.quotaCards.filter { $0.mode != "subscription" || $0.windows.isEmpty }

                    if !subCards.isEmpty {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                            ForEach(Array(subCards.enumerated()), id: \.element.id) { idx, card in
                                if let wPrimary = card.windows.first(where: { $0.id == "5h" }) ?? card.windows.first {
                                    let w7d = card.windows.first(where: { $0.id == "7d" })
                                    let ringColor = VeloQuotaPalette.ringColor(
                                        for: card.provider,
                                        status: wPrimary.status,
                                        tokens: tokens,
                                        isFirst: idx == 0
                                    )
                                    let caption = wPrimary.id == "5h" ? "5h 剩余" : (wPrimary.id == "30d" ? "月度剩余" : "剩余")
                                    let metaLine: String = {
                                        if let dt = wPrimary.detailText, !dt.isEmpty {
                                            return dt.replacingOccurrences(of: " / ", with: "/")
                                        }
                                        if let w7d {
                                            return "7d \(Int(w7d.remainingPercent.rounded()))%"
                                        }
                                        return card.planBadge
                                    }()

                                    VStack(spacing: 10) {
                                        VeloQuotaRingView(
                                            remainingPercent: wPrimary.remainingPercent,
                                            ringColor: ringColor,
                                            centerCaption: caption,
                                            size: 84
                                        )

                                        VStack(spacing: 3) {
                                            HStack(spacing: 5) {
                                                VeloBrandIcon(provider: card.provider, size: 13.5, colored: true)
                                                Text(VeloQuotaPalette.shortName(for: card.provider, fallback: card.label))
                                                    .font(.system(size: 13, weight: .semibold))
                                                    .lineLimit(1)
                                            }
                                            Text(
                                                wPrimary.resetCountdownLabel.isEmpty
                                                    ? metaLine
                                                    : "\(metaLine) · \(wPrimary.resetCountdownLabel)"
                                            )
                                            .font(.system(size: 10.5, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 16)
                                    .padding(.horizontal, 10)
                                    .veloSurface(cornerRadius: 20)
                                }
                            }
                        }

                        // Detailed Window Rows (e.g. Gemini 5h/7d + Claude/GPT 5h/7d)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("窗口明细")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)

                            VStack(spacing: 0) {
                                ForEach(Array(subCards.enumerated()), id: \.element.id) { cIdx, card in
                                    ForEach(Array(card.windows.enumerated()), id: \.element.id) { wIdx, w in
                                        if cIdx > 0 || wIdx > 0 {
                                            Rectangle()
                                                .fill(tokens.divider)
                                                .frame(height: 0.7)
                                                .padding(.leading, 40)
                                        }
                                        HStack(spacing: 10) {
                                            VeloBrandIcon(provider: card.provider, size: 15, colored: true)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(w.label)
                                                    .font(.system(size: 13.5, weight: .medium))
                                                    .foregroundStyle(.primary)
                                                if let dt = w.detailText, !dt.isEmpty {
                                                    Text(dt)
                                                        .font(.system(size: 11, design: .monospaced))
                                                        .foregroundStyle(.secondary)
                                                } else if !w.resetCountdownLabel.isEmpty {
                                                    Text("\(w.resetCountdownLabel) 后重置")
                                                        .font(.system(size: 11, design: .monospaced))
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                            Spacer()
                                            Text("\(Int(max(0, min(100, w.remainingPercent)).rounded()))%")
                                                .font(.system(size: 14, weight: .bold, design: .monospaced))
                                                .foregroundStyle(VeloQuotaPalette.pctColor(for: w.status))
                                                .contentTransition(.numericText())
                                        }
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 11)
                                    }
                                }
                            }
                            .veloSurface(cornerRadius: 16)
                        }
                    }

                    if !otherCards.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(otherCards) { card in
                                    HStack(spacing: 6) {
                                        VeloBrandIcon(provider: card.provider, size: 13, colored: card.mode == "api_key")
                                        Text(card.label)
                                            .font(.system(size: 12, weight: .semibold))
                                        Text(card.planBadge)
                                            .font(.system(size: 10.5, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 11)
                                    .padding(.vertical, 7)
                                    .veloSurface(cornerRadius: 12)
                                }
                            }
                        }
                    }

                    // 2. Total API-Equivalent Summary Card
                    if let a = store.usageAnalytics {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("API 等效折算总额")
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                    Text(VeloFormatting.formatUsd(a.totalCostUsd))
                                        .font(.system(size: 28, weight: .bold, design: .monospaced))
                                        .contentTransition(.numericText())
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 3) {
                                    Text("今日 \(VeloFormatting.formatUsd(a.todayCostUsd))")
                                        .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(VeloTheme.emerald)
                                        .contentTransition(.numericText())
                                    Text("订阅制不额外扣费")
                                        .font(.system(size: 10.5))
                                        .foregroundStyle(.tertiary)
                                }
                            }

                            Rectangle()
                                .fill(tokens.divider)
                                .frame(height: 0.7)

                            HStack {
                                statColumn(value: VeloFormatting.formatCompactTokens(a.totalTokens), label: "总 Token")
                                Spacer()
                                statColumn(value: String(format: "%.1f%%", a.cacheHitPct), label: "缓存命中")
                                Spacer()
                                statColumn(value: a.avgTps > 0 ? String(format: "%.1f", a.avgTps) : "—", label: "均速 tok/s")
                            }
                        }
                        .padding(16)
                        .veloSurface(cornerRadius: 20)

                        // 3. Per-Model Breakdown Inset List
                        if !a.byModel.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("按模型 API 等效账单")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 4)

                                VStack(spacing: 0) {
                                    ForEach(Array(a.byModel.enumerated()), id: \.element.id) { idx, m in
                                        if idx > 0 {
                                            Rectangle()
                                                .fill(tokens.divider)
                                                .frame(height: 0.7)
                                                .padding(.leading, 42)
                                        }
                                        HStack(spacing: 10) {
                                            VeloBrandIcon(provider: m.provider, size: 16, colored: true)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(m.model)
                                                    .font(.system(size: 13.5, weight: .semibold))
                                                    .lineLimit(1)
                                                Text("\(m.turnsCount) 轮 · 缓 \(VeloFormatting.formatCompactTokens(m.cacheReadTokens)) · 出 \(VeloFormatting.formatCompactTokens(m.outputTokens))")
                                                    .font(.system(size: 11, design: .monospaced))
                                                    .foregroundStyle(.secondary)
                                                    .lineLimit(1)
                                            }
                                            Spacer()
                                            Text(VeloFormatting.formatUsd(m.costUsd))
                                                .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                                                .contentTransition(.numericText())
                                        }
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 11)
                                    }
                                }
                                .veloSurface(cornerRadius: 16)
                            }
                        }
                    } else if store.connectionConfig != nil {
                        ProgressView("正在同步账单与配额…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 48)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 28)
            }
            .refreshable {
                await store.fetchQuotas()
                await store.fetchUsageAnalytics()
            }
            }
            .background(tokens.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .task {
                if store.connectionConfig != nil {
                    await store.fetchQuotas()
                    await store.fetchUsageAnalytics()
                }
            }
        }
    }

    private func statColumn(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(.primary)
                .contentTransition(.numericText())
            Text(label)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - TAB 3: Control Center (Exact Mockup: Bordered Solid Cards, Crisp Inline Header)

    private var controlTab: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Text("控制中心")
                        .font(.system(size: 28, weight: .bold))
                        .tracking(-0.6)
                    Spacer()
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 10)

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // 1. Mac Connection Status Card
                        Button {
                            VeloHaptics.tap()
                            showPairSheet = true
                        } label: {
                            HStack(spacing: 12) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .fill(tokens.accentSoft)
                                        .frame(width: 42, height: 42)
                                    Text("Mac")
                                        .font(.system(size: 13.5, weight: .bold))
                                        .foregroundStyle(tokens.accentText)
                                }
                                VStack(alignment: .leading, spacing: 2.5) {
                                    Text(store.connectionConfig == nil ? "尚未配对 Mac" : (store.isConnected ? "MacBook · 已连接" : "正在重连 Mac…"))
                                        .font(.system(size: 14.5, weight: .semibold))
                                        .foregroundStyle(.primary)
                                    Text(store.connectionConfig?.displayTitle ?? "轻点扫描 Mac 端二维码配对")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Text(store.connectionConfig == nil ? "配对" : "管理")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(tokens.accentText)
                            }
                            .padding(14)
                            .veloSurface(cornerRadius: 18)
                        }
                        .buttonStyle(VeloPressableButtonStyle(scale: 0.985))

                        // 2. Remote Capabilities Bordered Inset Card
                        VStack(spacing: 0) {
                            controlRow(icon: "magnifyingglass", title: "全局搜索历史对话") {
                                analyticsModalTab = .search
                                showAnalyticsModal = true
                            }
                            .disabled(store.connectionConfig == nil)

                            controlDivider

                            controlRow(icon: "apple.terminal", title: "接管 Mac 终端会话") {
                                showCliImportSheet = true
                            }
                            .disabled(store.connectionConfig == nil)

                            controlDivider

                            controlRow(icon: "server.rack", title: "多机与远端 SSH 主机") {
                                showRemoteHostsSheet = true
                            }

                            controlDivider

                            controlRow(icon: "calendar.badge.clock", title: "定时任务与自动化") {
                                analyticsModalTab = .automations
                                showAnalyticsModal = true
                            }
                            .disabled(store.connectionConfig == nil)

                            controlDivider

                            controlRow(icon: "bell.badge", title: "锁屏唤醒推送（Bark）") {
                                analyticsModalTab = .push
                                showAnalyticsModal = true
                            }
                            .disabled(store.connectionConfig == nil)
                        }
                        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(tokens.divider, lineWidth: 0.85)
                        )

                        // 3. Appearance & Palette Card
                        Button {
                            VeloHaptics.tap()
                            showAppearanceSheet = true
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "paintbrush")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(.primary)
                                    .frame(width: 22)
                                Text("外观与配色")
                                    .font(.system(size: 14.5))
                                    .foregroundStyle(.primary)
                                Spacer()
                                HStack(spacing: -4) {
                                    ForEach(Array(appearance.palette.swatchColors.enumerated()), id: \.offset) { _, c in
                                        Circle()
                                            .fill(c)
                                            .frame(width: 13, height: 13)
                                            .overlay(Circle().stroke(tokens.surface, lineWidth: 1.2))
                                    }
                                }
                                Text("\(appearance.palette.title)")
                                    .font(.system(size: 12.5))
                                    .foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 15)
                            .padding(.vertical, 13.5)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(tokens.divider, lineWidth: 0.85)
                        )
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 28)
                }
            }
            .background(tokens.canvas.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var controlDivider: some View {
        Rectangle()
            .fill(tokens.divider)
            .frame(height: 0.6)
            .padding(.leading, 48)
    }

    private func controlRow(
        icon: String,
        title: String,
        trailing: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            VeloHaptics.tap()
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 22)
                Text(title)
                    .font(.system(size: 14.5))
                    .foregroundStyle(.primary)
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 13.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Things 3 / Linear Crisp 120fps Inset Session Row with Swipe-to-Archive/Delete (ZERO `>` Chevron!)

private struct SwipeableSessionRow: View {
    let session: VeloSessionItem
    let isUnread: Bool
    let tokens: VeloPaletteTokens
    let isSwipeOpen: Bool
    let onSetSwipeOpen: (Bool) -> Void
    let onTap: () -> Void
    let onArchive: () -> Void
    let onDelete: () -> Void

    @State private var dragX: CGFloat = 0
    private let actionsWidth: CGFloat = 132

    private var effectiveOffset: CGFloat {
        let base: CGFloat = isSwipeOpen ? -actionsWidth : 0
        let raw = base + dragX
        return max(-actionsWidth - 20, min(0, raw))
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Trailing Swipe Actions (Exact Mockup: Solid Zinc Archive + Red Delete)
            if effectiveOffset < -2 {
                HStack(spacing: 0) {
                    Button(action: onArchive) {
                        Text("归档")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: actionsWidth / 2)
                            .frame(maxHeight: .infinity)
                            .background(Color(hex: 0x52525B))
                    }
                    .buttonStyle(.plain)

                    Button(action: onDelete) {
                        Text("删除")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: actionsWidth / 2)
                            .frame(maxHeight: .infinity)
                            .background(Color(hex: 0xEF4444))
                    }
                    .buttonStyle(.plain)
                }
                .frame(width: actionsWidth)
            }

            // Main Row Foreground (Pure Solid Opaque = 120fps!)
            SessionInsetRow(
                session: session,
                isUnread: isUnread,
                tokens: tokens
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 11.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.surface)
            .contentShape(Rectangle())
            .offset(x: effectiveOffset)
            .onTapGesture(perform: onTap)
            .simultaneousGesture(
                DragGesture(minimumDistance: 20, coordinateSpace: .local)
                    .onChanged { val in
                        // Only capture predominantly horizontal swipes so vertical ScrollView stays 100% 120fps native!
                        guard abs(val.translation.width) > abs(val.translation.height) * 1.6 else { return }
                        dragX = val.translation.width
                    }
                    .onEnded { val in
                        guard abs(val.translation.width) > abs(val.translation.height) * 1.3 else {
                            if dragX != 0 {
                                withAnimation(VeloMotion.crisp) { dragX = 0 }
                            }
                            return
                        }
                        let predicted = (isSwipeOpen ? -actionsWidth : 0) + val.predictedEndTranslation.width
                        withAnimation(VeloMotion.crisp) {
                            dragX = 0
                            onSetSwipeOpen(predicted < -actionsWidth * 0.45)
                        }
                    }
            )
        }
        .clipped()
    }
}

private struct SessionInsetRow: View {
    let session: VeloSessionItem
    let isUnread: Bool
    let tokens: VeloPaletteTokens

    var body: some View {
        HStack(spacing: 11) {
            ZStack(alignment: .bottomTrailing) {
                VeloBrandIcon(
                    provider: session.agentKind,
                    size: 16.5,
                    colored: true
                )
                .foregroundStyle(.primary)
                .frame(width: 20, height: 20)

                if isUnread {
                    Circle()
                        .fill(Color(hex: 0x38BDF8))
                        .frame(width: 6.5, height: 6.5)
                        .overlay(Circle().stroke(tokens.surface, lineWidth: 1.2))
                        .offset(x: 2, y: 2)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.title)
                        .font(.system(size: 14.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(session.updatedAtLabel)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                HStack(spacing: 5) {
                    Text(session.modelShort)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text(session.branchName)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 6)

                    if session.insertions > 0 || session.deletions > 0 {
                        HStack(spacing: 3) {
                            Text("+\(session.insertions)").foregroundStyle(VeloTheme.emerald)
                            Text("−\(session.deletions)").foregroundStyle(VeloTheme.coral)
                        }
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    }
                }
            }
        }
    }
}

// MARK: - Family Dynamic Morphing New-Session Tray (Replaces Legacy 5-Step Form!)

private struct FamilyNewSessionTray: View {
    private enum TrayStep {
        case prompt
        case model
        case project
    }

    @ObservedObject var store: VeloStore
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    var initialRepoPath: String?
    var onDismiss: () -> Void
    var onCreated: (String?) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var promptFocused: Bool

    @State private var step: TrayStep = .prompt
    @State private var selectedCategory: VeloEngineCategory = .claude
    @State private var selectedModelId: String = "claude-fable-5-2"
    @State private var effort: String = "medium"
    @State private var repoPath: String = "~/.velo/workspace"
    @State private var useWorktree: Bool = false
    @State private var branch: String = ""
    @State private var prompt: String = ""
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pendingImages: [PendingComposerImage] = []
    @State private var isCreating: Bool = false

    private var tokens: VeloPaletteTokens {
        VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
    }

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
        return result
    }

    private var repoDisplayName: String {
        if repoPath == "~/.velo/workspace" || repoPath.hasSuffix("/.velo/workspace") {
            return "快速对话"
        }
        let name = URL(fileURLWithPath: repoPath).lastPathComponent
        return name.isEmpty ? "项目" : name
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture {
                    promptFocused = false
                    onDismiss()
                }
                .transition(.opacity)

            VStack(alignment: .leading, spacing: 14) {
                // Morphing Header (Family Values: dual Back/Close affordance)
                HStack(spacing: 10) {
                    if step != .prompt {
                        Button {
                            VeloHaptics.selection()
                            withAnimation(VeloMotion.crisp) {
                                step = .prompt
                            }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(.primary)
                                .frame(width: 28, height: 28)
                                .background(tokens.elevated, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .transition(.opacity.combined(with: .scale(scale: 0.85)))
                    }

                    Text(step == .prompt ? "新建对话" : (step == .model ? "选择引擎与模型" : "选择项目目录"))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.primary)

                    Spacer()

                    Button {
                        promptFocused = false
                        onDismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 28, height: 28)
                            .background(tokens.elevated, in: Circle())
                    }
                    .buttonStyle(.plain)
                }

                // Dynamic Morphing Step Body
                switch step {
                case .prompt:
                    promptStepView
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                case .model:
                    modelStepView
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                case .project:
                    projectStepView
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                }
            }
            .padding(18)
            .background(tokens.surface, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(tokens.border, lineWidth: 0.9)
            )
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(VeloMotion.crisp, value: step)
            .animation(VeloMotion.crisp, value: useWorktree)
        }
        .onAppear {
            initializeDefaults()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                promptFocused = true
            }
        }
        .onChange(of: pickerItems) { _, newItems in
            handlePickedItems(newItems)
        }
    }

    private var promptStepView: some View {
        let uploadedPaths = pendingImages.compactMap(\.uploadedPath)
        let isUploadingAny = pendingImages.contains(where: \.isUploading)
        let hasPrompt = !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !uploadedPaths.isEmpty

        return VStack(alignment: .leading, spacing: 12) {
            TextField("直接描述你要改什么，留空也可进入空白对话…", text: $prompt, axis: .vertical)
                .focused($promptFocused)
                .lineLimit(2...5)
                .font(.system(size: 15))
                .padding(12)
                .background(tokens.canvas, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .stroke(tokens.divider, lineWidth: 0.8)
                )

            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingImages) { item in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: item.preview)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 54, height: 54)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                Button {
                                    pendingImages.removeAll { $0.id == item.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 15))
                                        .foregroundStyle(.white, Color.black.opacity(0.75))
                                }
                                .offset(x: 4, y: -4)
                            }
                            .padding(.top, 4)
                            .padding(.trailing, 4)
                        }
                    }
                }
            }

            // Inline Context Pills (Tap -> Morph Tray In-Place!)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    Button {
                        VeloHaptics.selection()
                        promptFocused = false
                        withAnimation(VeloMotion.crisp) { step = .project }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "folder")
                                .font(.system(size: 11, weight: .semibold))
                            Text(repoDisplayName)
                                .font(.system(size: 12, weight: .medium))
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.tertiary)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 10.5)
                        .padding(.vertical, 7)
                        .background(tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle())

                    Button {
                        VeloHaptics.selection()
                        promptFocused = false
                        withAnimation(VeloMotion.crisp) { step = .model }
                    } label: {
                        HStack(spacing: 5.5) {
                            VeloBrandIcon(category: selectedCategory, size: 13, colored: true)
                            Text(selectedModelOption.cleanTitle)
                                .font(.system(size: 12, weight: .medium))
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.tertiary)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 10.5)
                        .padding(.vertical, 7)
                        .background(tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle())

                    Button {
                        VeloHaptics.selection()
                        withAnimation(VeloMotion.crisp) { useWorktree.toggle() }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.system(size: 10.5, weight: .semibold))
                            Text("Worktree")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(useWorktree ? tokens.accentForeground : .secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(useWorktree ? tokens.accent : tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle())

                    PhotosPicker(
                        selection: $pickerItems,
                        maxSelectionCount: max(1, 4 - pendingImages.count),
                        matching: .images
                    ) {
                        Image(systemName: "photo")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 31, height: 31)
                            .background(tokens.elevated, in: Circle())
                    }
                    .disabled(pendingImages.count >= 4)
                }
            }

            if useWorktree {
                TextField("分支名（留空自动生成）", text: $branch)
                    .font(.system(size: 13, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(10)
                    .background(tokens.canvas, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            }

            Button {
                VeloHaptics.medium()
                promptFocused = false
                isCreating = true
                Task {
                    await store.addWorkspace(repoPath)
                    let createdId = await store.createNewSession(
                        title: nil,
                        prompt: prompt,
                        repoPath: repoPath,
                        branch: (useWorktree && !branch.isEmpty) ? branch : nil,
                        modelOption: selectedModelOption,
                        effort: effort,
                        images: uploadedPaths,
                        useWorktree: useWorktree
                    )
                    isCreating = false
                    onCreated(createdId)
                }
            } label: {
                HStack(spacing: 6) {
                    if isCreating {
                        ProgressView().tint(tokens.accentForeground).scaleEffect(0.8)
                    }
                    Text(isCreating ? "正在启动…" : (hasPrompt ? "立即开始" : "进入空白对话"))
                        .font(.system(size: 14.5, weight: .semibold))
                }
                .foregroundStyle(tokens.accentForeground)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12.5)
                .background(tokens.accent, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            }
            .buttonStyle(VeloPressableButtonStyle(scale: 0.975))
            .disabled(isCreating || isUploadingAny || repoPath.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var modelStepView: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Engine Switcher Pills with Official SVGs
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(VeloEngineCategory.primaryCategories) { cat in
                        let sel = selectedCategory == cat
                        Button {
                            VeloHaptics.selection()
                            withAnimation(VeloMotion.snappy) {
                                selectedCategory = cat
                                let defModel = store.models.first(where: { $0.category == cat && $0.isDefault })
                                    ?? store.models.first(where: { $0.category == cat })
                                    ?? VeloModelOption.defaults.first(where: { $0.category == cat })
                                if let defModel { selectedModelId = defModel.id }
                                if !cat.supportedEfforts.contains(effort) {
                                    effort = cat.supportedEfforts.contains("high") ? "high" : "medium"
                                }
                            }
                        } label: {
                            HStack(spacing: 5.5) {
                                VeloBrandIcon(category: cat, size: 13, colored: true)
                                Text(cat.shortBadge)
                                    .font(.system(size: 12.5, weight: sel ? .semibold : .medium))
                            }
                            .foregroundStyle(sel ? tokens.accentForeground : .primary)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7)
                            .background(sel ? tokens.accent : tokens.elevated, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            // Models List inside Selected Engine
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(categoryModels) { m in
                        let isSel = m.id == selectedModelOption.id
                        Button {
                            VeloHaptics.selection()
                            selectedModelId = m.id
                            withAnimation(VeloMotion.crisp) { step = .prompt }
                        } label: {
                            HStack(spacing: 10) {
                                VeloBrandIcon(category: selectedCategory, size: 16, colored: true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.cleanTitle)
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(.primary)
                                    Text(m.cleanSubtitle)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if isSel {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(tokens.accentText)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(
                                isSel ? tokens.accentSoft : tokens.canvas,
                                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .stroke(isSel ? tokens.border : tokens.divider, lineWidth: 0.8)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 240)

            // Compact Effort Selector
            HStack(spacing: 6) {
                Text("推理")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
                ForEach(selectedCategory.supportedEfforts, id: \.self) { lv in
                    let active = effort == lv
                    Button {
                        VeloHaptics.selection()
                        effort = lv
                    } label: {
                        Text(lv.uppercased())
                            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                            .foregroundStyle(active ? tokens.accentForeground : .secondary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(active ? tokens.accent : tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
        }
    }

    private var projectStepView: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                VStack(spacing: 6) {
                    let quickPath = "~/.velo/workspace"
                    projectRow(
                        icon: "bolt",
                        title: "快速对话",
                        subtitle: "不绑定代码仓库，随时开聊",
                        selected: repoPath == quickPath
                    ) {
                        repoPath = quickPath
                        withAnimation(VeloMotion.crisp) { step = .prompt }
                    }

                    ForEach(recentRepos, id: \.self) { rp in
                        let name = URL(fileURLWithPath: rp).lastPathComponent
                        projectRow(
                            icon: "folder",
                            title: name.isEmpty ? rp : name,
                            subtitle: VeloFormatting.shortenHomePath(rp),
                            selected: repoPath == rp
                        ) {
                            repoPath = rp
                            withAnimation(VeloMotion.crisp) { step = .prompt }
                        }
                    }
                }
            }
            .frame(maxHeight: 220)

            TextField("或手动输入 Mac 目录路径…", text: $repoPath)
                .font(.system(size: 12.5, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(10)
                .background(tokens.canvas, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
    }

    private func projectRow(
        icon: String,
        title: String,
        subtitle: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            VeloHaptics.selection()
            action()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1.5) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(tokens.accentText)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                selected ? tokens.accentSoft : tokens.canvas,
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(selected ? tokens.border : tokens.divider, lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
    }

    private func initializeDefaults() {
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
                let entry = PendingComposerImage(preview: compressed.preview, jpegData: compressed.jpegData, filename: fname)
                let eid = entry.id
                pendingImages.append(entry)
                Task {
                    let savedPath = await store.uploadAttachment(jpegData: compressed.jpegData, preview: compressed.preview, filename: fname)
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
}
