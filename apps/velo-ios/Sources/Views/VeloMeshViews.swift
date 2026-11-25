import SwiftUI

// MARK: - Inline Cross-Session Invocation Card (120fps Pure Solid Surface + Official Brand SVG)

public struct VeloMeshInvocationCardView: View {
    public let invocation: VeloMeshInvocation
    public let onJumpToSession: (String) -> Void
    public let onCancel: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    @State private var expanded: Bool = false

    private var tokens: VeloPaletteTokens {
        VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
    }

    private var statusDisplay: (label: String, color: Color) {
        switch invocation.status {
        case "pending_approval": return ("待审批", VeloTheme.amber)
        case "queued": return ("排队中", Color(hex: 0x38BDF8))
        case "running": return ("执行中", VeloTheme.emerald)
        case "completed": return ("已完成", VeloTheme.emerald)
        case "timed_out": return ("后台运行中", VeloTheme.amber)
        case "cancelled": return ("已取消", .secondary)
        default: return ("失败", VeloTheme.coral)
        }
    }

    public var body: some View {
        let st = statusDisplay
        let hasDiff = invocation.insertions > 0 || invocation.deletions > 0

        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    VeloHaptics.selection()
                    withAnimation(VeloMotion.crisp) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .frame(width: 12)

                        ZStack {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(tokens.elevated)
                                .frame(width: 24, height: 24)
                            VeloBrandIcon(provider: invocation.calleeProvider, size: 13.5, colored: true)
                                .foregroundStyle(.primary)
                        }

                        VStack(alignment: .leading, spacing: 1.5) {
                            Text(invocation.calleeSessionName)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            HStack(spacing: 5) {
                                Text(invocation.targetFolderName)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Text("·")
                                    .foregroundStyle(.quaternary)
                                HStack(spacing: 3.5) {
                                    Circle()
                                        .fill(st.color)
                                        .frame(width: 5.5, height: 5.5)
                                    Text(st.label)
                                        .font(.system(size: 10.5, weight: .medium))
                                        .foregroundStyle(st.color)
                                }
                                if hasDiff {
                                    Text("+\(invocation.insertions) −\(invocation.deletions)")
                                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(VeloTheme.emerald)
                                }
                            }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 4)

                if invocation.isActive {
                    Button {
                        onCancel(invocation.id)
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundStyle(VeloTheme.coral)
                            .frame(width: 26, height: 26)
                            .background(VeloTheme.coral.opacity(0.14), in: Circle())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }

                if let targetSid = invocation.calleeSessionId, !targetSid.isEmpty {
                    Button {
                        onJumpToSession(targetSid)
                    } label: {
                        HStack(spacing: 3) {
                            Text("现场")
                                .font(.system(size: 11, weight: .semibold))
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9.5, weight: .bold))
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 8.5)
                        .padding(.vertical, 5)
                        .background(tokens.elevated, in: Capsule())
                    }
                    .buttonStyle(VeloPressableButtonStyle())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            if !expanded && !invocation.prompt.isEmpty {
                Rectangle()
                    .fill(tokens.divider)
                    .frame(height: 0.6)
                Text((invocation.kind == "spawn" ? "跨目录新建 · " : "协作指令 · ") + invocation.prompt)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
            }

            if expanded {
                Rectangle()
                    .fill(tokens.divider)
                    .frame(height: 0.6)

                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("派发指令 · 深度 \(invocation.depth)")
                            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.secondary)
                        Text(invocation.prompt)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.primary)
                            .padding(9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(tokens.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    if let summary = invocation.resultSummary, !summary.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("返回结果摘要")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(VeloTheme.emerald)
                            Text(summary)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.primary)
                                .padding(9)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(tokens.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }

                    if let err = invocation.error, !err.isEmpty {
                        Text(err)
                            .font(.system(size: 11.5))
                            .foregroundStyle(VeloTheme.coral)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(VeloTheme.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    }
                }
                .padding(12)
            }
        }
        .veloSurface(cornerRadius: 14)
    }
}

// MARK: - Velo Mesh Mode A `@` Context Mention Sheet (Cross-Session & Cross-Folder)

public struct VeloMeshMentionSheet: View {
    @ObservedObject var store: VeloStore
    public let currentSessionId: String
    @Binding public var selectedRefs: [VeloMeshContextRef]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    @State private var query: String = ""

    private var tokens: VeloPaletteTokens {
        VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
    }

    private var filteredSessions: [VeloSessionItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.sessions.filter { s in
            guard s.id != currentSessionId, !s.isArchived else { return false }
            if q.isEmpty { return true }
            return s.title.lowercased().contains(q)
                || s.projectName.lowercased().contains(q)
                || s.branchName.lowercased().contains(q)
        }
    }

    private var filteredWorkspaces: [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var seen: Set<String> = []
        var out: [String] = []
        for ws in store.workspaces {
            let c = VeloFormatting.canonicalWorkspacePath(ws)
            guard !c.isEmpty, !c.hasSuffix("/.velo/workspace"), seen.insert(c).inserted else { continue }
            if q.isEmpty || c.lowercased().contains(q) {
                out.append(c)
            }
        }
        return out
    }

    private func toggleRef(_ ref: VeloMeshContextRef) {
        VeloHaptics.selection()
        if let idx = selectedRefs.firstIndex(where: { $0.id == ref.id }) {
            selectedRefs.remove(at: idx)
        } else {
            selectedRefs.append(ref)
        }
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                tokens.canvas.ignoresSafeArea()

                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        TextField("搜索其他会话或项目目录…", text: $query)
                            .font(.system(size: 14))
                            .textInputAutocapitalization(.never)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9.5)
                    .veloSurface(cornerRadius: 12)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !filteredSessions.isEmpty {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text("跨会话只读引用（零唤醒）")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 4)

                                    VStack(spacing: 0) {
                                        ForEach(Array(filteredSessions.prefix(20).enumerated()), id: \.element.id) { idx, s in
                                            let ref = VeloMeshContextRef(
                                                kind: "session",
                                                targetId: s.id,
                                                label: "\(s.projectName) · \(s.title)"
                                            )
                                            let picked = selectedRefs.contains(where: { $0.id == ref.id })
                                            if idx > 0 {
                                                Rectangle()
                                                    .fill(tokens.divider)
                                                    .frame(height: 0.6)
                                                    .padding(.leading, 42)
                                            }
                                            Button {
                                                toggleRef(ref)
                                            } label: {
                                                HStack(spacing: 10) {
                                                    VeloBrandIcon(provider: s.agentKind, size: 16, colored: true)
                                                        .foregroundStyle(.primary)
                                                        .frame(width: 20, height: 20)
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        Text(s.title)
                                                            .font(.system(size: 14, weight: .medium))
                                                            .foregroundStyle(.primary)
                                                            .lineLimit(1)
                                                        Text("\(s.projectName) · \(s.modelShort) · \(s.branchName)")
                                                            .font(.system(size: 11, design: .monospaced))
                                                            .foregroundStyle(.secondary)
                                                            .lineLimit(1)
                                                    }
                                                    Spacer()
                                                    if picked {
                                                        Image(systemName: "checkmark.circle.fill")
                                                            .font(.system(size: 16))
                                                            .foregroundStyle(VeloTheme.emerald)
                                                    }
                                                }
                                                .padding(.horizontal, 14)
                                                .padding(.vertical, 11)
                                                .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)
                                        }
                                    }
                                    .veloSurface(cornerRadius: 16)
                                }
                            }

                            if !filteredWorkspaces.isEmpty {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text("引用整个项目文件夹")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 4)

                                    VStack(spacing: 0) {
                                        ForEach(Array(filteredWorkspaces.prefix(12).enumerated()), id: \.element) { idx, ws in
                                            let name = URL(fileURLWithPath: ws).lastPathComponent
                                            let ref = VeloMeshContextRef(
                                                kind: "workspace",
                                                targetId: ws,
                                                label: "项目 · \(name.isEmpty ? ws : name)"
                                            )
                                            let picked = selectedRefs.contains(where: { $0.id == ref.id })
                                            if idx > 0 {
                                                Rectangle()
                                                    .fill(tokens.divider)
                                                    .frame(height: 0.6)
                                                    .padding(.leading, 42)
                                            }
                                            Button {
                                                toggleRef(ref)
                                            } label: {
                                                HStack(spacing: 10) {
                                                    Image(systemName: "folder")
                                                        .font(.system(size: 14, weight: .medium))
                                                        .foregroundStyle(.secondary)
                                                        .frame(width: 20)
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        Text(name.isEmpty ? ws : name)
                                                            .font(.system(size: 14, weight: .medium))
                                                            .foregroundStyle(.primary)
                                                        Text(VeloFormatting.shortenHomePath(ws))
                                                            .font(.system(size: 11, design: .monospaced))
                                                            .foregroundStyle(.secondary)
                                                            .lineLimit(1)
                                                    }
                                                    Spacer()
                                                    if picked {
                                                        Image(systemName: "checkmark.circle.fill")
                                                            .font(.system(size: 16))
                                                            .foregroundStyle(VeloTheme.emerald)
                                                    }
                                                }
                                                .padding(.horizontal, 14)
                                                .padding(.vertical, 11)
                                                .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)
                                        }
                                    }
                                    .veloSurface(cornerRadius: 16)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 24)
                    }
                }
            }
            .navigationTitle("@ 跨会话引用")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
