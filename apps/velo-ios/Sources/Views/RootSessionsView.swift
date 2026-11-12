import SwiftUI

public struct RootSessionsView: View {
    @ObservedObject var store: VeloStore

    @State private var showPairSheet = false
    @State private var showNewThreadSheet = false
    @State private var navigationPath: [String] = []

    public init(store: VeloStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if store.connectionConfig == nil {
                    VStack(spacing: 18) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .fill(Color.primary.opacity(0.06))
                                .frame(width: 84, height: 84)
                            Image(systemName: "bolt.horizontal.icloud.fill")
                                .font(.system(size: 34))
                                .foregroundStyle(.primary)
                        }

                        Text("Velo Native iOS")
                            .font(.system(size: 22, weight: .bold))

                        Text("扫描 Mac 端 Velo 的二维码，即可通过零信任端到端加密盲中继（5G / 异地直通）或局域网操控本地 Claude Code、Codex 与 Antigravity。")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)

                        Button {
                            showPairSheet = true
                        } label: {
                            Label("扫码配对 Mac", systemImage: "qrcode.viewfinder")
                                .font(.system(size: 15, weight: .semibold))
                                .padding(.horizontal, 20)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("暂无活跃会话", systemImage: "terminal")
                    } description: {
                        Text(store.isConnected ? "点击右上角 + 创建隔离 Git Worktree 会话" : (store.connectionError ?? "正在连接 Mac Velo 守护进程…"))
                    } actions: {
                        HStack(spacing: 12) {
                            Button("新建会话") {
                                showNewThreadSheet = true
                            }
                            .buttonStyle(.borderedProminent)

                            Button("配对设置") {
                                showPairSheet = true
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                } else {
                    List {
                        Section {
                            ForEach(store.sessions) { session in
                                NavigationLink(value: session.id) {
                                    SessionRowCell(session: session)
                                }
                            }
                        } header: {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(store.isConnected ? Color.green : Color.orange)
                                    .frame(width: 7, height: 7)
                                Text(store.connectionConfig?.displayTitle ?? "Disconnected")
                                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                                    .textCase(nil)
                                if store.connectionConfig?.isEncryptedRelay == true {
                                    HStack(spacing: 3) {
                                        Image(systemName: "lock.shield.fill")
                                            .font(.system(size: 9.5))
                                        if store.isForwardSecretRatcheted {
                                            Text("FS")
                                                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                                        }
                                    }
                                    .foregroundStyle(.green)
                                    .textCase(nil)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable {
                        await store.refreshSessionsAndActiveEvents()
                    }
                }
            }
            .navigationTitle("Velo")
            .navigationDestination(for: String.self) { sessionId in
                ChatThreadView(store: store, sessionId: sessionId)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showPairSheet = true
                    } label: {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(store.isConnected ? Color.green : Color.orange)
                                .frame(width: 8, height: 8)
                            Image(systemName: "qrcode.viewfinder")
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewThreadSheet = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(store.connectionConfig == nil)
                }
            }
            .sheet(isPresented: $showPairSheet) {
                PairingSheetView(store: store)
            }
            .sheet(isPresented: $showNewThreadSheet) {
                NewSessionSheetView(store: store) { createdId in
                    if let createdId {
                        navigationPath.append(createdId)
                    }
                }
            }
        }
    }
}

private struct SessionRowCell: View {
    let session: VeloSessionItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if session.status == .running {
                    OrbitalStatusIcon(phase: .working)
                } else if session.status == .waitingApproval {
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.orange)
                } else {
                    Circle()
                        .fill(Color.secondary.opacity(0.35))
                        .frame(width: 7, height: 7)
                }

                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)

                Spacer()

                Text(session.updatedAtLabel)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                Label(session.branchName, systemImage: "arrow.triangle.branch")
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Text("·")
                    .foregroundStyle(.tertiary)

                Text(session.modelShort)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer()

                if session.insertions > 0 || session.deletions > 0 {
                    HStack(spacing: 3) {
                        Text("+\(session.insertions)")
                            .foregroundStyle(.green)
                        Text("−\(session.deletions)")
                            .foregroundStyle(.red)
                    }
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                }
            }
        }
        .padding(.vertical, 3)
    }
}

private struct NewSessionSheetView: View {
    @ObservedObject var store: VeloStore
    var onCreated: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var prompt: String = ""
    @State private var branch: String = ""
    @State private var repoPath: String = "/Users/daiyudai/code/velo"
    @State private var selectedModelId: String = "claude-fable-5-2"
    @State private var effort: String = "medium"
    @State private var isCreating = false

    private var selectedModel: VeloModelOption {
        store.models.first(where: { $0.id == selectedModelId }) ?? VeloModelOption.defaults[0]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("任务指令") {
                    TextField("输入要交给 Agent 执行的开发任务…", text: $prompt, axis: .vertical)
                        .lineLimit(3...7)
                }

                Section("模型与推理强度") {
                    Picker("模型", selection: $selectedModelId) {
                        ForEach(store.models) { m in
                            Text(m.label).tag(m.id)
                        }
                    }
                    Picker("Effort", selection: $effort) {
                        Text("Low").tag("low")
                        Text("Medium").tag("medium")
                        Text("High").tag("high")
                        Text("Max").tag("max")
                    }
                    .pickerStyle(.segmented)
                }

                Section("隔离 Git Worktree") {
                    TextField("仓库路径", text: $repoPath)
                        .font(.system(size: 13, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("分支名称（留空自动生成）", text: $branch)
                        .font(.system(size: 13, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("新建 Worktree 会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreating ? "启动中…" : "启动") {
                        isCreating = true
                        Task {
                            let createdId = await store.createNewSession(
                                title: nil,
                                prompt: prompt,
                                repoPath: repoPath,
                                branch: branch.isEmpty ? nil : branch,
                                modelOption: selectedModel,
                                effort: effort
                            )
                            isCreating = false
                            dismiss()
                            onCreated(createdId)
                        }
                    }
                    .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
                }
            }
            .onAppear {
                if let firstRepo = store.sessions.first?.repoRoot, !firstRepo.isEmpty {
                    repoPath = firstRepo
                }
                if let firstModel = store.models.first?.id {
                    selectedModelId = firstModel
                }
            }
        }
    }
}
