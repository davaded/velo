import SwiftUI

public struct VeloCliSessionsSheet: View {
    @ObservedObject var store: VeloStore
    var onOpenedSession: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var searchText: String = ""
    @State private var providerFilter: String = "all"
    @State private var isRefreshing: Bool = false
    @State private var importingCliId: String?

    private var filteredItems: [VeloExternalCliSessionItem] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.externalCliSessions.filter { item in
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

                VStack(spacing: 12) {
                    Picker("引擎过滤", selection: $providerFilter) {
                        Text("全部").tag("all")
                        Text("Claude Code").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)

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
                            Text("在 Mac 终端执行过的 claude / codex 对话会自动出现在这里")
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
                ToolbarItem(placement: .topBarTrailing) {
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
        }
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
        let isClaude = item.provider == "claude"
        let badgeColor = isClaude ? Color.orange : VeloTheme.emerald
        let isBusy = importingCliId == item.cliSessionId

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(isClaude ? "CLAUDE" : "CODEX")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(badgeColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2.5)
                    .background(badgeColor.opacity(0.14), in: Capsule())

                Text(item.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()
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
                .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.85)
        )
    }
}
