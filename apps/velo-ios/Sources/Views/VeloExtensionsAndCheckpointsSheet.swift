import SwiftUI

public struct VeloExtensionsAndCheckpointsSheet: View {
    @ObservedObject var store: VeloStore
    let sessionId: String?
    let workspacePath: String?
    let initialTab: Int
    var onInjectSkillPrompt: (VeloSkillItem) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var selectedTab: Int
    @State private var searchText: String = ""
    @State private var engineFilter: String = "all"
    @State private var isRefreshing: Bool = false
    @State private var rewindingId: String? = nil
    @State private var pendingRewindTarget: VeloTurnCheckpointItem? = nil

    // SKILL.md preview & custom Skill editor
    @State private var previewSkill: VeloSkillItem? = nil
    @State private var previewContent: String = ""
    @State private var previewLoading: Bool = false
    @State private var previewError: String? = nil

    @State private var showSkillEditor: Bool = false
    @State private var editingPath: String? = nil
    @State private var formName: String = ""
    @State private var formDescription: String = ""
    @State private var formScope: String = "global"
    @State private var formContent: String = ""
    @State private var savingSkill: Bool = false
    @State private var pendingDeleteSkill: VeloSkillItem? = nil

    public init(
        store: VeloStore,
        sessionId: String?,
        workspacePath: String? = nil,
        initialTab: Int = 0,
        onInjectSkillPrompt: @escaping (VeloSkillItem) -> Void
    ) {
        self.store = store
        self.sessionId = sessionId
        self.workspacePath = workspacePath
        self.initialTab = initialTab
        self.onInjectSkillPrompt = onInjectSkillPrompt
        _selectedTab = State(initialValue: initialTab)
    }

    private var checkpoints: [VeloTurnCheckpointItem] {
        guard let sid = sessionId else { return [] }
        return (store.checkpointsBySession[sid] ?? []).reversed()
    }

    private var hasWorkspace: Bool {
        !(workspacePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    private var filteredMcpServers: [VeloMcpServerItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.mcpServers.filter { srv in
            if engineFilter != "all" && engineFilter != "project" && engineFilter != "velo" {
                if srv.engine.lowercased() != engineFilter { return false }
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
            switch engineFilter {
            case "all": break
            case "project":
                if sk.scope != "project" { return false }
            case "velo":
                if sk.engine.lowercased() != "velo" && !sk.editable { return false }
            default:
                if sk.engine.lowercased() != engineFilter { return false }
            }
            guard !q.isEmpty else { return true }
            return sk.name.lowercased().contains(q)
                || sk.engine.lowercased().contains(q)
                || sk.description.lowercased().contains(q)
                || sk.path.lowercased().contains(q)
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
                        Text("Skills & MCP").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)

                    if let banner = store.lastActionBanner, !banner.isEmpty {
                        bannerBar(banner)
                    }

                    if selectedTab == 0 {
                        checkpointsTabView
                    } else {
                        extensionsTabView
                    }
                }
            }
            .navigationTitle(selectedTab == 0 ? "每轮检查点回滚" : "跨引擎 Skills 与 MCP")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if selectedTab == 1 {
                        Button {
                            openCreateSkillEditor()
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 14, weight: .semibold))
                        }
                    }
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
            .confirmationDialog(
                "删除自定义 Skill？",
                isPresented: Binding(
                    get: { pendingDeleteSkill != nil },
                    set: { if !$0 { pendingDeleteSkill = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let sk = pendingDeleteSkill {
                    Button("永久删除「\(sk.name)」", role: .destructive) {
                        pendingDeleteSkill = nil
                        Task {
                            _ = await store.deleteCustomSkill(path: sk.path, workspace: workspacePath)
                            if previewSkill?.id == sk.id {
                                previewSkill = nil
                            }
                        }
                    }
                }
                Button("取消", role: .cancel) {
                    pendingDeleteSkill = nil
                }
            } message: {
                if let sk = pendingDeleteSkill {
                    Text("仅会删除 Velo 托管路径中的文件：\n\(sk.path)")
                }
            }
            .sheet(item: $previewSkill) { sk in
                skillPreviewSheet(sk)
            }
            .sheet(isPresented: $showSkillEditor) {
                customSkillEditorSheet
            }
        }
    }

    private func bannerBar(_ banner: String) -> some View {
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

    private func refreshCurrentTab() {
        isRefreshing = true
        Task {
            if let sid = sessionId {
                await store.fetchCheckpoints(for: sid)
            }
            await store.fetchExtensions(workspace: workspacePath)
            try? await Task.sleep(nanoseconds: 220_000_000)
            isRefreshing = false
        }
    }

    private func openSkillPreview(_ sk: VeloSkillItem) {
        previewSkill = sk
        previewContent = ""
        previewError = nil
        previewLoading = true
        Task {
            let text = await store.readSkillContent(path: sk.path)
            await MainActor.run {
                previewLoading = false
                if let text {
                    previewContent = text
                } else {
                    previewError = "未能读取 SKILL.md 内容，请检查与 Mac 守护进程的连接状态。"
                }
            }
        }
    }

    private func openCreateSkillEditor() {
        editingPath = nil
        formName = ""
        formDescription = ""
        formScope = hasWorkspace ? "project" : "global"
        formContent = """
        # 任务规范与步骤

        1. 先分析相关代码与上下文，列出影响范围。
        2. 严格按规范修改并运行对应验证命令。
        3. 总结变更与潜在风险。
        """
        showSkillEditor = true
    }

    private func openEditSkillEditor(_ sk: VeloSkillItem, loadedContent: String?) {
        editingPath = sk.path
        formName = sk.name
        formDescription = sk.description
        formScope = sk.scope == "project" ? "project" : "global"
        if let raw = loadedContent, !raw.isEmpty {
            formContent = stripFrontmatter(raw)
        } else {
            formContent = ""
            Task {
                if let raw = await store.readSkillContent(path: sk.path) {
                    await MainActor.run {
                        formContent = stripFrontmatter(raw)
                    }
                }
            }
        }
        previewSkill = nil
        showSkillEditor = true
    }

    private func stripFrontmatter(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("---") else { return raw }
        let lines = raw.components(separatedBy: .newlines)
        var closingIdx: Int? = nil
        for i in 1..<lines.count {
            if lines[i].trimmingCharacters(in: .whitespaces) == "---" {
                closingIdx = i
                break
            }
        }
        guard let idx = closingIdx else { return raw }
        return lines[(idx + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
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

    // MARK: - Tab 1: Cross-Engine Skills & MCP

    private var extensionsTabView: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                TextField("搜索 Skill、路径或 MCP Server…", text: $searchText)
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
                    engineChip(title: "项目级", key: "project")
                    engineChip(title: "Velo 自定义", key: "velo")
                    engineChip(title: "Antigravity", key: "antigravity")
                    engineChip(title: "Claude", key: "claude")
                    engineChip(title: "Codex", key: "codex")
                    engineChip(title: "Cursor", key: "cursor")
                }
                .padding(.horizontal, 16)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    HStack {
                        sectionHeader(
                            title: "跨引擎 Skills",
                            count: filteredSkills.count,
                            icon: "sparkles.rectangle.stack"
                        )
                        Button {
                            openCreateSkillEditor()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "plus")
                                    .font(.system(size: 10.5, weight: .bold))
                                Text("新建 Skill")
                                    .font(.system(size: 11.5, weight: .semibold))
                            }
                            .foregroundStyle(VeloTheme.accentVioletSoft)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    if filteredSkills.isEmpty {
                        emptyHint("未检测到匹配的本地或项目级 Skill，点右上角「+」可新建跨引擎 Skill")
                    } else {
                        ForEach(filteredSkills) { sk in
                            skillRow(sk)
                        }
                    }

                    sectionHeader(
                        title: "MCP Servers",
                        count: filteredMcpServers.count,
                        icon: "server.rack"
                    )
                    .padding(.top, 4)

                    if filteredMcpServers.isEmpty {
                        emptyHint("未检测到匹配的本地 MCP Server")
                    } else {
                        ForEach(filteredMcpServers) { srv in
                            mcpServerRow(srv)
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
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func badgeColor(for engine: String) -> Color {
        switch engine.lowercased() {
        case "velo": return VeloTheme.accentViolet
        case "claude": return Color.orange
        case "codex": return VeloTheme.emerald
        case "cursor": return Color.cyan
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
            Text(sk.name)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                if sk.scope == "project" {
                    Text("项目")
                        .font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(VeloTheme.emerald)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(VeloTheme.emerald.opacity(0.14), in: Capsule())
                }

                Text(sk.engine.uppercased())
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(color.opacity(0.14), in: Capsule())
            }

            if !sk.description.isEmpty {
                Text(sk.description)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 6) {
                Button {
                    openSkillPreview(sk)
                } label: {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 26)
                        .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                }
                .buttonStyle(.plain)

                if sk.editable {
                    Button {
                        pendingDeleteSkill = sk
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(.red.opacity(0.85))
                            .frame(width: 28, height: 26)
                            .background(Color.red.opacity(0.1), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onInjectSkillPrompt(sk)
                    dismiss()
                } label: {
                    HStack(spacing: 3.5) {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text("调用")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(VeloTheme.accentVioletSoft)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4.5)
                    .background(VeloTheme.accentViolet.opacity(0.14), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.75)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            openSkillPreview(sk)
        }
    }

    // MARK: - SKILL.md Preview Sheet

    private func skillPreviewSheet(_ sk: VeloSkillItem) -> some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme).ignoresSafeArea()
                if previewLoading {
                    ProgressView("正在读取 SKILL.md…")
                } else if let err = previewError {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 28))
                            .foregroundStyle(.orange)
                        Text(err)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(sk.path)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                            Text(previewContent)
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(.primary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .padding(16)
                    }
                }
            }
            .navigationTitle(sk.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { previewSkill = nil }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if sk.editable {
                        Button("编辑") {
                            openEditSkillEditor(sk, loadedContent: previewContent)
                        }
                    }
                    Button("跨引擎调用") {
                        previewSkill = nil
                        onInjectSkillPrompt(sk)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }

    // MARK: - Custom Skill Editor Sheet

    private var customSkillEditorSheet: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("Skill 名称（例如：swift-ui-audit）", text: $formName)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("一句话用途说明（供 / 搜索与模型触发）", text: $formDescription)
                    Picker("生效范围", selection: $formScope) {
                        Text("全局（~/.velo/skills）").tag("global")
                        if hasWorkspace {
                            Text("仅当前项目（.velo/skills）").tag("project")
                        }
                    }
                }

                Section("SKILL.md 规范正文（支持 Markdown）") {
                    TextEditor(text: $formContent)
                        .font(.system(size: 13, design: .monospaced))
                        .frame(minHeight: 220)
                }

                Section {
                    Text("保存后将生成标准 SKILL.md 文件，可在 Claude、Codex、Antigravity、Cursor 与 Grok 任意模型中通过 `/` 直接调用。")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(editingPath == nil ? "新建跨引擎 Skill" : "编辑自定义 Skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { showSkillEditor = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        savingSkill = true
                        Task {
                            let ok = await store.saveCustomSkill(
                                name: formName,
                                description: formDescription,
                                content: formContent,
                                scope: formScope,
                                workspace: formScope == "project" ? workspacePath : nil,
                                existingPath: editingPath
                            )
                            await MainActor.run {
                                savingSkill = false
                                if ok {
                                    showSkillEditor = false
                                }
                            }
                        }
                    } label: {
                        if savingSkill {
                            ProgressView().scaleEffect(0.8)
                        } else {
                            Text("保存").fontWeight(.semibold)
                        }
                    }
                    .disabled(savingSkill || formName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || formContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
