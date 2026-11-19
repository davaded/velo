import SwiftUI

public struct VeloExtensionsAndCheckpointsSheet: View {
    @ObservedObject var store: VeloStore
    let sessionId: String?
    let initialTab: Int
    var onInjectSkillPrompt: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var selectedTab: Int
    @State private var searchText: String = ""
    @State private var engineFilter: String = "all"
    @State private var isRefreshing: Bool = false
    @State private var rewindingId: String? = nil
    @State private var pendingRewindTarget: VeloTurnCheckpointItem? = nil

    public init(
        store: VeloStore,
        sessionId: String?,
        initialTab: Int = 0,
        onInjectSkillPrompt: @escaping (String) -> Void
    ) {
        self.store = store
        self.sessionId = sessionId
        self.initialTab = initialTab
        self.onInjectSkillPrompt = onInjectSkillPrompt
        _selectedTab = State(initialValue: initialTab)
    }

    private var checkpoints: [VeloTurnCheckpointItem] {
        guard let sid = sessionId else { return [] }
        return (store.checkpointsBySession[sid] ?? []).reversed()
    }

    private var filteredMcpServers: [VeloMcpServerItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.mcpServers.filter { srv in
            if engineFilter != "all" && srv.engine.lowercased() != engineFilter {
                return false
            }
            guard !q.isEmpty else { return true }
            return srv.name.lowercased().contains(q)
                || srv.engine.lowercased().contains(q)
                || srv.target.lowercased().contains(q)
        }
    }

    private var filteredSkills: [VeloSkillItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.installedSkills.filter { sk in
            if engineFilter != "all" && sk.engine.lowercased() != engineFilter {
                return false
            }
            guard !q.isEmpty else { return true }
            return sk.name.lowercased().contains(q)
                || sk.engine.lowercased().contains(q)
                || sk.description.lowercased().contains(q)
        }
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                VStack(spacing: 10) {
                    Picker("功能标签", selection: $selectedTab) {
                        Text("Git 检查点").tag(0)
                        Text("MCP & Skills").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)

                    if let banner = store.lastActionBanner, !banner.isEmpty {
                        HStack(spacing: 6) {
                            Text(banner)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.primary)
                            Spacer()
                            Button {
                                store.lastActionBanner = nil
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(VeloTheme.emerald.opacity(0.14), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .padding(.horizontal, 16)
                    }

                    if selectedTab == 0 {
                        checkpointsTabView
                    } else {
                        extensionsTabView
                    }
                }
            }
            .navigationTitle(selectedTab == 0 ? "每轮检查点回滚" : "MCP 与 Skills 检查器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        refreshCurrentTab()
                    } label: {
                        if isRefreshing {
                            ProgressView().scaleEffect(0.75)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                }
            }
            .onAppear {
                refreshCurrentTab()
            }
            .onChange(of: selectedTab) { _, _ in
                refreshCurrentTab()
            }
            .confirmationDialog(
                "回滚工作区文件到该轮执行前？",
                isPresented: Binding(
                    get: { pendingRewindTarget != nil },
                    set: { if !$0 { pendingRewindTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let target = pendingRewindTarget, let sid = sessionId {
                    Button("确认回滚（自动留存当前备份）", role: .destructive) {
                        pendingRewindTarget = nil
                        rewindingId = target.id
                        Task {
                            _ = await store.rewindCheckpoint(sessionId: sid, checkpointId: target.id)
                            rewindingId = nil
                        }
                    }
                }
                Button("取消", role: .cancel) {
                    pendingRewindTarget = nil
                }
            } message: {
                if let target = pendingRewindTarget {
                    Text("将恢复受 Git 追踪的文件至第 #\(target.turnIndex) 轮执行前快照（\(target.headShort)）。系统会在回滚前自动创建一个当前状态的备份快照，随时可再次恢复。")
                }
            }
        }
    }

    private func refreshCurrentTab() {
        isRefreshing = true
        Task {
            if let sid = sessionId {
                await store.fetchCheckpoints(for: sid)
            }
            await store.fetchExtensions()
            try? await Task.sleep(nanoseconds: 220_000_000)
            isRefreshing = false
        }
    }

    // MARK: - Tab 0: Turn Checkpoints

    @ViewBuilder
    private var checkpointsTabView: some View {
        if checkpoints.isEmpty {
            Spacer()
            VStack(spacing: 10) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 32))
                    .foregroundStyle(.tertiary)
                Text("暂无每轮 Git 检查点")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("每次在 Git 仓库发送指令前，Velo 都会无侵入地留存一份轻量级快照（不污染 git stash list），随时一键回滚。")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            Spacer()
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(checkpoints) { cp in
                        checkpointCard(cp)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 22)
            }
        }
    }

    private func checkpointCard(_ cp: VeloTurnCheckpointItem) -> some View {
        let isBusy = rewindingId == cp.id
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text("#\(cp.turnIndex)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())

                Text(cp.promptPreview)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()
            }

            HStack(spacing: 6) {
                Label(cp.headShort, systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)

                Text("·")
                    .foregroundStyle(.tertiary)

                Text(cp.hadDirtyChanges ? "含未提交快照" : "干净 HEAD")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(cp.hadDirtyChanges ? VeloTheme.amber : VeloTheme.emerald)

                if !cp.createdAtLabel.isEmpty {
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text(cp.createdAtLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            HStack {
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    pendingRewindTarget = cp
                } label: {
                    HStack(spacing: 5) {
                        if isBusy {
                            ProgressView().scaleEffect(0.75)
                        } else {
                            Image(systemName: "arrow.uturn.backward.circle.fill")
                                .font(.system(size: 13))
                        }
                        Text(isBusy ? "正在回滚…" : "回滚到此轮前")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(VeloTheme.accentViolet, in: Capsule())
                }
                .buttonStyle(VeloPressableButtonStyle())
                .disabled(isBusy)
            }
        }
        .padding(13)
        .background(
            VeloTheme.cardSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.85)
        )
    }

    // MARK: - Tab 1: Local MCP & Skills

    private var extensionsTabView: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                TextField("搜索 MCP Server 或本地 Skill…", text: $searchText)
                    .font(.system(size: 13.5))
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
            )
            .padding(.horizontal, 16)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    engineChip(title: "全部", key: "all")
                    engineChip(title: "Antigravity", key: "antigravity")
                    engineChip(title: "Claude", key: "claude")
                    engineChip(title: "Codex", key: "codex")
                    engineChip(title: "Cursor", key: "cursor")
                }
                .padding(.horizontal, 16)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    sectionHeader(
                        title: "MCP Servers",
                        count: filteredMcpServers.count,
                        icon: "server.rack"
                    )
                    if filteredMcpServers.isEmpty {
                        emptyHint("未检测到匹配的本地 MCP Server")
                    } else {
                        ForEach(filteredMcpServers) { srv in
                            mcpServerRow(srv)
                        }
                    }

                    sectionHeader(
                        title: "已安装 Skills",
                        count: filteredSkills.count,
                        icon: "sparkles.rectangle.stack"
                    )
                    .padding(.top, 4)

                    if filteredSkills.isEmpty {
                        emptyHint("未检测到匹配的本地 Skill")
                    } else {
                        ForEach(filteredSkills) { sk in
                            skillRow(sk)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
    }

    private func engineChip(title: String, key: String) -> some View {
        let active = engineFilter == key
        return Button {
            engineFilter = key
        } label: {
            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(active ? .white : .secondary)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(
                    active ? VeloTheme.accentViolet : VeloTheme.cardSurface(colorScheme),
                    in: Capsule()
                )
                .overlay(
                    Capsule().stroke(VeloTheme.hairline(colorScheme), lineWidth: active ? 0 : 0.75)
                )
        }
        .buttonStyle(.plain)
    }

    private func sectionHeader(title: String, count: Int, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(VeloTheme.accentVioletSoft)
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.primary)
            Text("\(count)")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1.5)
                .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
            Spacer()
        }
    }

    private func emptyHint(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12.5))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 16)
            .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func badgeColor(for engine: String) -> Color {
        switch engine.lowercased() {
        case "claude": return Color.orange
        case "codex": return VeloTheme.emerald
        case "cursor": return VeloTheme.accentViolet
        case "antigravity": return VeloEngineCategory.agy.accentColor
        default: return .secondary
        }
    }

    private func mcpServerRow(_ srv: VeloMcpServerItem) -> some View {
        let color = badgeColor(for: srv.engine)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Circle()
                    .fill(srv.enabled ? VeloTheme.emerald : Color.secondary.opacity(0.45))
                    .frame(width: 7.5, height: 7.5)
                Text(srv.name)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(srv.engine.uppercased())
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(color.opacity(0.14), in: Capsule())
                Spacer()
                Text(srv.transport.uppercased())
                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
            }
            if !srv.target.isEmpty {
                Text(srv.target)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(12)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.75)
        )
    }

    private func skillRow(_ sk: VeloSkillItem) -> some View {
        let color = badgeColor(for: sk.engine)
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Text(sk.name)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(sk.engine.uppercased())
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(color.opacity(0.14), in: Capsule())
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onInjectSkillPrompt("请遵循本地 skill `\(sk.name)`（路径：`\(sk.path)`）的规范和步骤来完成接下来的任务：\n")
                    dismiss()
                } label: {
                    HStack(spacing: 3.5) {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text("注入指令")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            if !sk.description.isEmpty {
                Text(sk.description)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(12)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.75)
        )
    }
}
