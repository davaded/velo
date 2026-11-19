import SwiftUI

public struct VeloRemoteHostsSheet: View {
    @ObservedObject public var store: VeloStore
    public let onOpenPairingScanner: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var showAddSshForm = false
    @State private var newLabel = ""
    @State private var newTarget = ""
    @State private var newCwd = "~/code"

    @State private var dispatchHostId: String? = nil
    @State private var dispatchProvider: String = "codex"
    @State private var dispatchPrompt: String = ""

    public init(store: VeloStore, onOpenPairingScanner: @escaping () -> Void) {
        self.store = store
        self.onOpenPairingScanner = onOpenPairingScanner
    }

    public var body: some View {
        NavigationStack {
            List {
                // Section 1: Saved Paired Daemons (Mac / Cloud E2EE Nodes)
                Section {
                    ForEach(store.savedHostProfiles) { prof in
                        let isCurrent = (store.connectionConfig == prof.config)
                        Button {
                            store.switchToSavedHost(prof)
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(isCurrent ? VeloTheme.emerald : Color.secondary.opacity(0.4))
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(prof.name)
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(.primary)
                                    Text(prof.config.displayTitle)
                                        .font(.system(size: 11.5, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if isCurrent {
                                    Text(store.isConnected ? "当前在线" : "重连中")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(store.isConnected ? VeloTheme.emerald : VeloTheme.amber)
                                }
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if !isCurrent {
                                Button(role: .destructive) {
                                    store.removeSavedHost(prof.id)
                                } label: {
                                    Label("移除", systemImage: "trash")
                                }
                            }
                        }
                    }

                    Button {
                        dismiss()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                            onOpenPairingScanner()
                        }
                    } label: {
                        Label("扫码添加另一台 Mac 或云端守护节点", systemImage: "qrcode.viewfinder")
                            .font(.system(size: 13.5, weight: .medium))
                            .foregroundStyle(VeloTheme.accentViolet)
                    }
                } header: {
                    Text("已配对控制面节点 (多机秒切)")
                }

                // Section 2: Remote SSH Compute Hosts (`hush ssh` / `ssh`)
                Section {
                    if store.remoteHosts.isEmpty {
                        Text("正在读取守护进程配置的 SSH 远端主机…")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }

                    ForEach(store.remoteHosts) { host in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(host.status == "online" ? VeloTheme.emerald : VeloTheme.amber)
                                    .frame(width: 8, height: 8)
                                Text(host.label)
                                    .font(.system(size: 14, weight: .semibold))
                                Text(host.sshTarget)
                                    .font(.system(size: 11.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                if !host.isLocal {
                                    Button {
                                        withAnimation(.easeInOut(duration: 0.18)) {
                                            dispatchHostId = (dispatchHostId == host.id) ? nil : host.id
                                        }
                                    } label: {
                                        Text(dispatchHostId == host.id ? "收起" : "远端执行")
                                            .font(.system(size: 11.5, weight: .semibold))
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 4)
                                            .background(Capsule().fill(VeloTheme.accentViolet.opacity(0.16)))
                                            .foregroundStyle(VeloTheme.accentVioletSoft)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            HStack(spacing: 8) {
                                Text("目录: \(host.defaultCwd)")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                if !host.detectedAgents.isEmpty {
                                    Text("CLI: \(host.detectedAgents.joined(separator: ", "))")
                                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                                        .foregroundStyle(VeloTheme.emerald)
                                }
                            }

                            if dispatchHostId == host.id {
                                VStack(alignment: .leading, spacing: 8) {
                                    Picker("引擎", selection: $dispatchProvider) {
                                        Text("Codex").tag("codex")
                                        Text("Claude").tag("claude")
                                        Text("AGY").tag("antigravity")
                                        Text("Cursor").tag("cursor")
                                    }
                                    .pickerStyle(.segmented)

                                    HStack(spacing: 8) {
                                        TextField("输入要在 \(host.label) 执行的编码指令…", text: $dispatchPrompt)
                                            .textFieldStyle(.roundedBorder)
                                            .font(.system(size: 13))

                                        Button {
                                            let p = dispatchPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                            guard !p.isEmpty else { return }
                                            Task {
                                                await store.dispatchRemoteSshSession(
                                                    hostId: host.id,
                                                    provider: dispatchProvider,
                                                    prompt: p
                                                )
                                                dispatchPrompt = ""
                                                dismiss()
                                            }
                                        } label: {
                                            Image(systemName: "paperplane.fill")
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundStyle(.white)
                                                .frame(width: 32, height: 32)
                                                .background(Circle().fill(VeloTheme.accentViolet))
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(dispatchPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                        .padding(.vertical, 3)
                        .swipeActions(edge: .trailing) {
                            if !host.isLocal {
                                Button(role: .destructive) {
                                    Task { await store.removeRemoteHost(host.id) }
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                        }
                    }

                    if showAddSshForm {
                        VStack(spacing: 8) {
                            TextField("别名 (如 Ubuntu GPU Server)", text: $newLabel)
                            TextField("SSH 目标 (如 root@10.0.0.8)", text: $newTarget)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            TextField("默认目录 (如 ~/code)", text: $newCwd)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            HStack {
                                Button("取消") {
                                    showAddSshForm = false
                                }
                                .foregroundStyle(.secondary)
                                Spacer()
                                Button("保存并探测") {
                                    let tgt = newTarget.trimmingCharacters(in: .whitespacesAndNewlines)
                                    guard !tgt.isEmpty else { return }
                                    let lbl = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                                    Task {
                                        await store.addRemoteHost(
                                            label: lbl.isEmpty ? tgt : lbl,
                                            sshTarget: tgt,
                                            defaultCwd: newCwd.isEmpty ? "~" : newCwd
                                        )
                                        newLabel = ""
                                        newTarget = ""
                                        showAddSshForm = false
                                    }
                                }
                                .fontWeight(.semibold)
                                .disabled(newTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                            .padding(.top, 4)
                        }
                    } else {
                        Button {
                            showAddSshForm = true
                        } label: {
                            Label("添加远端 SSH 主机 (自动支持 hush ssh)", systemImage: "plus.circle.fill")
                                .font(.system(size: 13.5, weight: .medium))
                        }
                    }
                } header: {
                    Text("远端 SSH 服务器集群")
                }
            }
            .navigationTitle("多机与远端 SSH")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.fetchRemoteHosts() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task {
                await store.fetchRemoteHosts()
            }
        }
    }
}
