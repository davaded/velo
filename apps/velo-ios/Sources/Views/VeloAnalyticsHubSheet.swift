import SwiftUI

public struct VeloAnalyticsHubSheet: View {
    public enum HubTab: String, CaseIterable, Identifiable {
        case analytics = "账单"
        case search = "全局搜索"
        case push = "锁屏推送"
        case automations = "定时任务"

        public var id: String { rawValue }
    }

    @ObservedObject var store: VeloStore
    var initialTab: HubTab
    var onSelectSession: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedTab: HubTab
    @State private var searchQuery: String = ""
    @State private var pushDraft: VeloPushConfig = VeloPushConfig()
    @State private var pushLoaded: Bool = false
    @State private var newAutoNatural: String = ""
    @State private var showCreateAuto: Bool = false

    public init(
        store: VeloStore,
        initialTab: HubTab = .analytics,
        onSelectSession: @escaping (String) -> Void
    ) {
        self.store = store
        self.initialTab = initialTab
        self.onSelectSession = onSelectSession
        _selectedTab = State(initialValue: initialTab)
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    Picker("功能切换", selection: $selectedTab) {
                        ForEach(HubTab.allCases) { t in
                            Text(t.rawValue).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)

                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            switch selectedTab {
                            case .analytics:
                                analyticsSection
                            case .search:
                                searchSection
                            case .push:
                                pushSection
                            case .automations:
                                automationsSection
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .navigationTitle("数据与远程控制中心")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .task(id: selectedTab) {
                switch selectedTab {
                case .analytics:
                    await store.fetchUsageAnalytics()
                    await store.fetchQuotas()
                case .push:
                    await store.fetchPushConfig()
                    pushDraft = store.pushConfig
                    pushLoaded = true
                case .automations:
                    await store.fetchAutomations()
                case .search:
                    break
                }
            }
            .onChange(of: store.pushConfig) { _, updated in
                if !pushLoaded {
                    pushDraft = updated
                    pushLoaded = true
                }
            }
        }
    }

    // MARK: - 1. Usage & Billing Analytics

    @ViewBuilder
    private var analyticsSection: some View {
        if !store.quotaCards.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("配额窗口与接入模式")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)

                ForEach(store.quotaCards) { card in
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text(card.label)
                                .font(.system(size: 14, weight: .bold))
                            Spacer()
                            Text(card.planBadge)
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2.5)
                                .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                        }

                        if card.mode != "subscription" || card.windows.isEmpty {
                            Text(
                                card.summaryText
                                    ?? (card.mode == "api_key"
                                        ? "API Key 按量模式 · 无 5h/7d 速率窗口"
                                        : "当前未登录该 CLI 账号")
                            )
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        } else {
                            ForEach(card.windows) { w in
                                let rem = max(0, min(100, w.remainingPercent))
                                let barColor: Color = {
                                    if w.status == "exhausted" { return VeloTheme.coral }
                                    if w.status == "warning" { return VeloTheme.amber }
                                    switch card.provider {
                                    case "antigravity": return Color(red: 0.38, green: 0.65, blue: 0.98)
                                    case "cursor": return Color(red: 0.65, green: 0.55, blue: 0.98)
                                    case "claude": return Color(red: 0.98, green: 0.57, blue: 0.24)
                                    default: return VeloTheme.emerald
                                    }
                                }()
                                let rightTxt: String = {
                                    var parts: [String] = []
                                    if let dt = w.detailText, !dt.isEmpty { parts.append(dt) }
                                    parts.append("剩余 \(Int(rem.rounded()))%")
                                    if !w.resetCountdownLabel.isEmpty { parts.append(w.resetCountdownLabel) }
                                    return parts.joined(separator: " · ")
                                }()

                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(w.label)
                                            .font(.system(size: 12))
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                        Text(rightTxt)
                                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                    GeometryReader { geo in
                                        ZStack(alignment: .leading) {
                                            Capsule()
                                                .fill(VeloTheme.elevatedSurface(colorScheme))
                                            Capsule()
                                                .fill(barColor)
                                                .frame(width: max(6, geo.size.width * CGFloat(rem / 100.0)))
                                        }
                                    }
                                    .frame(height: 6)
                                }
                            }
                        }
                    }
                    .padding(13)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                    )
                }
            }
        }

        if let a = store.usageAnalytics {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                metricCard(
                    title: "累计折算账单",
                    value: VeloFormatting.formatUsd(a.totalCostUsd),
                    sub: "今日 \(VeloFormatting.formatUsd(a.todayCostUsd))",
                    accent: VeloTheme.emerald
                )
                metricCard(
                    title: "总吞吐 Token",
                    value: VeloFormatting.formatCompactTokens(a.totalTokens),
                    sub: "输出 \(VeloFormatting.formatCompactTokens(a.outputTokens))",
                    accent: .primary
                )
                metricCard(
                    title: "缓存命中率",
                    value: String(format: "%.1f%%", a.cacheHitPct),
                    sub: "命中 \(VeloFormatting.formatCompactTokens(a.cacheReadTokens))",
                    accent: .blue
                )
                metricCard(
                    title: "加权生成速率",
                    value: a.avgTps > 0 ? String(format: "%.1f tok/s", a.avgTps) : "—",
                    sub: "共 \(a.turnsCount) 轮回答",
                    accent: VeloTheme.accentVioletSoft
                )
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("按 AI 引擎账单与速率")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)

                ForEach(a.byProvider) { b in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(b.label)
                                .font(.system(size: 13.5, weight: .bold, design: .monospaced))
                            Text("\(b.sessionsCount) 会话 · \(b.turnsCount) 轮 · 缓存 \(Int(b.cacheHitPct))%")
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(VeloFormatting.formatUsd(b.costUsd))
                                .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                            if b.avgTps > 0 {
                                Text(String(format: "%.1f tok/s", b.avgTps))
                                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(VeloTheme.accentVioletSoft)
                            }
                        }
                    }
                    .padding(12)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
                    )
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("按项目文件夹统计")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)

                ForEach(a.byWorkspace) { w in
                    HStack {
                        VStack(alignment: .leading, spacing: 2.5) {
                            Text(w.label)
                                .font(.system(size: 13.5, weight: .semibold))
                            Text(VeloFormatting.shortenHomePath(w.key))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        Text(VeloFormatting.formatUsd(w.costUsd))
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    }
                    .padding(12)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
            }
        } else {
            HStack {
                Spacer()
                ProgressView("正在同步账单与缓存指标…")
                    .font(.system(size: 13))
                Spacer()
            }
            .padding(.vertical, 40)
        }
    }

    private func metricCard(title: String, value: String, sub: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .monospaced))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(sub)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.8)
        )
    }

    // MARK: - 2. Global Full-Text SQLite Search

    @ViewBuilder
    private var searchSection: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("搜索全部历史会话标题、Prompt、AI 回复…", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .onSubmit {
                    Task { await store.searchGlobalSessions(query: searchQuery) }
                }
            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                    store.globalSearchHits = []
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(11)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(VeloTheme.hairline(colorScheme), lineWidth: 0.85)
        )
        .onChange(of: searchQuery) { _, q in
            Task {
                try? await Task.sleep(nanoseconds: 240_000_000)
                guard q == searchQuery else { return }
                await store.searchGlobalSessions(query: q)
            }
        }

        if store.globalSearchHits.isEmpty && !searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
            Text("未检索到包含「\(searchQuery)」的历史对话")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
        } else {
            ForEach(store.globalSearchHits) { hit in
                Button {
                    dismiss()
                    onSelectSession(hit.sessionId)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(hit.sessionName)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Spacer()
                            Text(hit.provider.uppercased())
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(VeloTheme.accentVioletSoft)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(VeloTheme.accentViolet.opacity(0.12), in: Capsule())
                        }
                        Text(hit.snippet)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(VeloFormatting.shortenHomePath(hit.repoRoot))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    .padding(12)
                    .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
                .buttonStyle(VeloPressableButtonStyle())
            }
        }
    }

    // MARK: - 3. Blind Lock-Screen Push Config

    @ViewBuilder
    private var pushSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("零明文盲推送（Bark / Webhook）", systemImage: "lock.shield.fill")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(VeloTheme.accentVioletSoft)
            Text("App 在后台挂起时，当 Mac 端任务完成或需要审批，自动向 iPhone 锁屏发送无明文唤醒通知，点击直达对应加密会话。")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(12)
        .background(VeloTheme.accentViolet.opacity(0.10), in: RoundedRectangle(cornerRadius: 13, style: .continuous))

        VStack(spacing: 12) {
            Toggle("启用远程锁屏推送", isOn: $pushDraft.enabled)
                .font(.system(size: 14, weight: .medium))

            VStack(alignment: .leading, spacing: 5) {
                Text("Bark 推送 Key 或服务器地址")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField("如 AbCdEf123456 或 https://api.day.app/...", text: $pushDraft.barkTarget)
                    .font(.system(size: 13, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(10)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 5) {
                Text("Webhook 地址（可选：飞书 / Slack / ntfy）")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField("https://...", text: $pushDraft.webhookUrl)
                    .font(.system(size: 13, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(10)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            Toggle("零明文隐私保护（通知隐藏代码与标题）", isOn: $pushDraft.blindMode)
                .font(.system(size: 13.5))
            Toggle("等待权限审批 / 提问时提醒", isOn: $pushDraft.notifyOnPermission)
                .font(.system(size: 13.5))
            Toggle("任务执行完成时提醒", isOn: $pushDraft.notifyOnComplete)
                .font(.system(size: 13.5))
            Toggle("任务异常中断时提醒", isOn: $pushDraft.notifyOnError)
                .font(.system(size: 13.5))
        }
        .padding(14)
        .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

        if let statusMsg = store.lastActionBanner, !statusMsg.isEmpty {
            Text(statusMsg)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(VeloTheme.emerald)
        }

        HStack(spacing: 10) {
            Button {
                Task {
                    await store.savePushConfig(pushDraft)
                    await store.sendTestPush()
                }
            } label: {
                Label("测试推送", systemImage: "bell.badge.fill")
                    .font(.system(size: 13.5, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(VeloPressableButtonStyle())

            Button {
                Task { await store.savePushConfig(pushDraft) }
            } label: {
                Label("保存配置", systemImage: "checkmark")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(VeloTheme.accentViolet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(VeloPressableButtonStyle())
        }
    }

    // MARK: - 4. Automations (Cron)

    @ViewBuilder
    private var automationsSection: some View {
        HStack {
            Text("定时自动化规则 (\(store.automations.count))")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                withAnimation(.snappy) { showCreateAuto.toggle() }
            } label: {
                Label(showCreateAuto ? "收起" : "新建定时任务", systemImage: showCreateAuto ? "chevron.up" : "plus.circle.fill")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(VeloTheme.accentVioletSoft)
            }
        }

        if showCreateAuto {
            VStack(alignment: .leading, spacing: 10) {
                Text("直接用白话定时间和任务（本机时区）")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)

                TextField("例如：每天早上9点跑一遍单测并修复报错", text: $newAutoNatural, axis: .vertical)
                    .lineLimit(2...4)
                    .font(.system(size: 13.5))
                    .padding(10)
                    .background(VeloTheme.elevatedSurface(colorScheme), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(["每天早上9点 ", "每个工作日18:30 ", "每周五下午6点 ", "每2小时 ", "30分钟后 "], id: \.self) { chip in
                            Button {
                                if newAutoNatural.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    newAutoNatural = chip
                                } else {
                                    newAutoNatural = chip + newAutoNatural.trimmingCharacters(in: .whitespacesAndNewlines)
                                }
                            } label: {
                                Text(chip.trimmingCharacters(in: .whitespaces))
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 5)
                                    .background(VeloTheme.elevatedSurface(colorScheme), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Button {
                    let repo = store.workspaces.first ?? store.sessions.first?.repoRoot ?? "~/workspace"
                    let input = newAutoNatural
                    Task {
                        await store.createNaturalAutomation(
                            naturalInput: input,
                            repoPath: repo,
                            provider: "claude"
                        )
                        newAutoNatural = ""
                        showCreateAuto = false
                    }
                } label: {
                    Text("确认启用")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(VeloTheme.accentViolet, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(newAutoNatural.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(12)
            .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        }

        if store.automations.isEmpty && !showCreateAuto {
            Text("暂无定时任务，点击右上角「新建定时任务」，用白话写一句即可按时执行")
                .font(.system(size: 12.5))
                .foregroundStyle(.secondary)
                .padding(.vertical, 24)
        } else {
            ForEach(store.automations) { item in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(item.name)
                            .font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Toggle(
                            "",
                            isOn: Binding(
                                get: { item.enabled },
                                set: { val in
                                    Task { await store.toggleAutomation(id: item.id, enabled: val) }
                                }
                            )
                        )
                        .labelsHidden()
                    }
                    HStack(spacing: 6) {
                        Label(item.scheduleText, systemImage: "clock")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(VeloTheme.emerald)
                        Text("· \(item.provider.uppercased()) · 已运行 \(item.runCount) 次")
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                    }
                    Text(item.promptTemplate)
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)

                    HStack(spacing: 12) {
                        Button {
                            Task { await store.triggerAutomation(id: item.id) }
                        } label: {
                            Label("立即运行一次", systemImage: "play.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(VeloTheme.emerald)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { await store.deleteAutomation(id: item.id) }
                        } label: {
                            Image(systemName: "trash")
                                .font(.system(size: 12.5))
                                .foregroundStyle(VeloTheme.coral)
                        }
                    }
                }
                .padding(12)
                .background(VeloTheme.cardSurface(colorScheme), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
        }
    }
}
