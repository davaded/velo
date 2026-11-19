import SwiftUI

public struct VeloCliSessionsSheet: View {
    @ObservedObject var store: VeloStore
    var onOpenedSession: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var searchText: String = ""
    @State private var providerFilter: String = "all"
    @State private var showEphemeral: Bool = false
    @State private var isRefreshing: Bool = false
    @State private var importingCliId: String?
    @State private var pendingDeleteTarget: VeloExternalCliSessionItem?
    @State private var showCleanEphemeralConfirm: Bool = false

    private var ephemeralItems: [VeloExternalCliSessionItem] {
        store.externalCliSessions.filter { $0.isEphemeral }
    }

    private var filteredItems: [VeloExternalCliSessionItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.externalCliSessions.filter { item in
            if !showEphemeral && item.isEphemeral {
                return false
            }
            if providerFilter != "all" && item.provider != providerFilter {
                return false
            }
            guard !q.isEmpty else { return true }
            return item.title.lowercased().contains(q)
                || item.projectName.lowercased().contains(q)
                || item.cwd.lowercased().contains(q)
                || item.lastPreview.lowercased().contains(q)
        }
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                VStack(spacing: 10) {
                    Picker("引擎过滤", selection: $providerFilter) {
                        Text("全部").tag("all")
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                        Text("Cursor").tag("cursor")
                        Text("AGY").tag("antigravity")
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)

                    if !ephemeralItems.isEmpty {
                        ephemeralBanner
                            .padding(.horizontal, 16)
                    }

                    if isRefreshing && store.externalCliSessions.isEmpty {
                        Spacer()
                        VStack(spacing: 10) {
                            ProgressView()
                            Text("正在扫描 Mac 上的终端会话…")
                                .font(.system(size: 13))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    } else if filteredItems.isEmpty {
                        Spacer()
                        VStack(spacing: 10) {
                            Image(systemName: "apple.terminal")
                                .font(.system(size: 32))
                                .foregroundStyle(.tertiary)
                            Text("未发现可接管的原生终端会话")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.secondary)
                            Text("在 Mac 终端或 IDE 执行过的 claude / codex / cursor / agy 对话会自动出现在这里")
                                .font(.system(size: 12))
                                .foregroundStyle(.tertiary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                        }
                        Spacer()
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 10) {
                                ForEach(filteredItems) { item in
                                    cliSessionCard(item)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.bottom, 20)
                        }
                    }
                }
            }
            .navigationTitle("接管 Mac 终端会话")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "搜索会话标题、项目或内容")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if store.hiddenCliSessionsCount > 0 {
                        Menu {
                            Button {
                                Task {
                                    await store.manageExternalCliSessions(
                                        action: "unhide_all",
                                        items: []
                                    )
                                }
                            } label: {
                                Label(
                                    "恢复 \(store.hiddenCliSessionsCount) 条已隐藏会话",
                                    systemImage: "arrow.uturn.backward"
                                )
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                    Button {
                        refresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .onAppear {
                refresh()
            }
            .onChange(of: store.latestImportedCliVeloId) { _, newSid in
                guard let newSid, !newSid.isEmpty else { return }
                store.latestImportedCliVeloId = nil
                importingCliId = nil
                dismiss()
                onOpenedSession(newSid)
            }
            .confirmationDialog(
                "删除本机终端会话文件？",
                isPresented: Binding(
                    get: { pendingDeleteTarget != nil },
                    set: { if !$0 { pendingDeleteTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let target = pendingDeleteTarget {
                    if target.provider == "antigravity" {
                        Button("从 Velo 列表永久隐藏（不改 AGY 库）", role: .destructive) {
                            pendingDeleteTarget = nil
                            Task {
                                await store.manageExternalCliSessions(
                                    action: "hide",
                                    items: [(target.provider, target.cliSessionId)]
                                )
                            }
                        }
                    } else {
                        Button("永久删除 Mac 上的本地历史文件", role: .destructive) {
                            pendingDeleteTarget = nil
                            Task {
                                await store.manageExternalCliSessions(
                                    action: "delete",
                                    items: [(target.provider, target.cliSessionId)]
                                )
                            }
                        }
                        Button("仅从 Velo 列表隐藏") {
                            pendingDeleteTarget = nil
                            Task {
                                await store.manageExternalCliSessions(
                                    action: "hide",
                                    items: [(target.provider, target.cliSessionId)]
                                )
                            }
                        }
                    }
                }
                Button("取消", role: .cancel) {
                    pendingDeleteTarget = nil
                }
            } message: {
                if let target = pendingDeleteTarget {
                    Text("「\(target.title)」— 彻底删除会从 Mac 磁盘移除该 CLI 历史文件，仅隐藏则只不在 Velo 显示。")
                }
            }
            .confirmationDialog(
                "清理 \(ephemeralItems.count) 条临时/测试会话",
                isPresented: $showCleanEphemeralConfirm,
                titleVisibility: .visible
            ) {
                Button("永久删除这 \(ephemeralItems.count) 个本地文件", role: .destructive) {
                    let targets = ephemeralItems.map { ($0.provider, $0.cliSessionId) }
                    Task {
                        await store.manageExternalCliSessions(action: "delete", items: targets)
                    }
                }
                Button("仅从接管列表永久隐藏") {
                    let targets = ephemeralItems.map { ($0.provider, $0.cliSessionId) }
                    Task {
                        await store.manageExternalCliSessions(action: "hide", items: targets)
                    }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("包括根目录测试、单轮 ok/hi/PONG 探测及临时目录会话。")
            }
        }
    }

    private var ephemeralBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(VeloTheme.amber)
            Text(
                showEphemeral
                    ? "含 \(ephemeralItems.count) 条临时会话"
                    : "已过滤 \(ephemeralItems.count) 条临时会话"
            )
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            Spacer()
            Button {
                showEphemeral.toggle()
            } label: {
                Text(showEphemeral ? "隐藏" : "查看")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
            }
            .buttonStyle(.plain)

            Button {
                showCleanEphemeralConfirm = true
            } label: {
                Text("一键清理")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(VeloTheme.coral)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(VeloTheme.coral.opacity(0.14), in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            VeloTheme.cardSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(VeloTheme.amber.opacity(0.28), lineWidth: 0.8)
        )
    }

    private func refresh() {
        isRefreshing = true
        Task {
            await store.fetchExternalCliSessions()
            try? await Task.sleep(nanoseconds: 300_000_000)
            isRefreshing = false
        }
    }

    private func cliSessionCard(_ item: VeloExternalCliSessionItem) -> some View {
        let badgeMeta: (label: String, color: Color) = {
            switch item.provider {
            case "claude":
                return ("CLAUDE", Color.orange)
            case "cursor":
                return ("CURSOR", VeloTheme.accentViolet)
            case "antigravity":
                return ("AGY", VeloEngineCategory.agy.accentColor)
            default:
                return ("CODEX", VeloTheme.emerald)
            }
        }()
        let badgeColor = badgeMeta.color
        let isBusy = importingCliId == item.cliSessionId

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(badgeMeta.label)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(badgeColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(badgeColor.opacity(0.14), in: Capsule())

                if item.isEphemeral {
                    Text("临时")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(VeloTheme.amber)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(VeloTheme.amber.opacity(0.15), in: Capsule())
                }

                Text(item.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()

                Menu {
                    Button {
                        Task {
                            await store.manageExternalCliSessions(
                                action: "hide",
                                items: [(item.provider, item.cliSessionId)]
                            )
                        }
                    } label: {
                        Label("仅从列表隐藏", systemImage: "eye.slash")
                    }
                    Button(role: .destructive) {
                        pendingDeleteTarget = item
                    } label: {
                        Label("删除本地会话文件", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 24)
                }
            }

            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 11))
                Text(item.projectName)
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                Text("·")
                Text("\(item.messageCount) 条消息")
                    .font(.system(size: 11.5))
                if !item.updatedAtLabel.isEmpty {
                    Text("·")
                    Text(item.updatedAtLabel)
                        .font(.system(size: 11.5))
                }
                Spacer()
            }
            .foregroundStyle(.secondary)

            if !item.lastPreview.isEmpty {
                Text(item.lastPreview)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack {
                if let reason = item.ephemeralReason, item.isEphemeral {
                    Text(reason)
                        .font(.system(size: 11))
                        .foregroundStyle(VeloTheme.amber)
                }
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    importingCliId = item.cliSessionId
                    Task {
                        if let sid = await store.importExternalCliSession(
                            provider: item.provider,
                            cliSessionId: item.cliSessionId
                        ) {
                            importingCliId = nil
                            dismiss()
                            onOpenedSession(sid)
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        if isBusy {
                            ProgressView()
                                .scaleEffect(0.75)
                        } else {
                            Image(systemName: item.importedSessionId != nil ? "checkmark.circle.fill" : "arrow.down.forward.circle.fill")
                                .font(.system(size: 13))
                        }
                        Text(item.importedSessionId != nil ? "同步并打开" : "一键接管")
                            .font(.system(size: 12.5, weight: .semibold))
                    }
                    .foregroundStyle(item.importedSessionId != nil ? VeloTheme.emerald : .white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(
                        item.importedSessionId != nil
                            ? AnyShapeStyle(VeloTheme.emerald.opacity(0.15))
                            : AnyShapeStyle(VeloTheme.accentViolet),
                        in: Capsule()
                    )
                }
                .buttonStyle(VeloPressableButtonStyle())
                .disabled(isBusy)
            }
        }
        .padding(13)
        .background(
            VeloTheme.cardSurface(colorScheme),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    item.isEphemeral
                        ? AnyShapeStyle(VeloTheme.amber.opacity(0.32))
                        : AnyShapeStyle(VeloTheme.specularRim(colorScheme)),
                    lineWidth: 0.85
                )
        )
        .contextMenu {
            Button {
                Task {
                    await store.manageExternalCliSessions(
                        action: "hide",
                        items: [(item.provider, item.cliSessionId)]
                    )
                }
            } label: {
                Label("仅从列表隐藏", systemImage: "eye.slash")
            }
            Button(role: .destructive) {
                pendingDeleteTarget = item
            } label: {
                Label("删除本地会话文件", systemImage: "trash")
            }
        }
    }
}
