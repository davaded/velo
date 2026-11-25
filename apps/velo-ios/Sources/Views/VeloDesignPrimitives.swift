import SwiftUI
import UIKit

// MARK: - 1. Global Appearance & Material Preferences (Synced with Desktop Philosophy)

public enum VeloThemePreference: String, CaseIterable, Identifiable {
    case system
    case dark
    case light

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: return "跟随系统"
        case .dark: return "深色"
        case .light: return "浅色"
        }
    }

    public var iconName: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .dark: return "moon.fill"
        case .light: return "sun.max.fill"
        }
    }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .dark: return .dark
        case .light: return .light
        }
    }
}

public enum VeloMaterialStyle: String, CaseIterable, Identifiable {
    case matte
    case frosted
    case specular

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .matte: return "纯平哑光"
        case .frosted: return "磨砂玻璃"
        case .specular: return "高光浮层"
        }
    }

    public var subtitle: String {
        switch self {
        case .matte: return "克制无反光，专注高对比阅读"
        case .frosted: return "原生毛玻璃质感与细腻折光边"
        case .specular: return "深邃微光晕与柔和流体高光"
        }
    }
}

@MainActor
public final class VeloAppearanceSettings: ObservableObject {
    public static let shared = VeloAppearanceSettings()

    private enum Keys {
        static let theme = "velo.ios.appearance.theme.v1"
        static let material = "velo.ios.appearance.material.v1"
        static let reduceMotion = "velo.ios.appearance.reduceMotion.v1"
    }

    @Published public var themeMode: VeloThemePreference {
        didSet { UserDefaults.standard.set(themeMode.rawValue, forKey: Keys.theme) }
    }

    @Published public var materialStyle: VeloMaterialStyle {
        didSet { UserDefaults.standard.set(materialStyle.rawValue, forKey: Keys.material) }
    }

    @Published public var reduceMotion: Bool {
        didSet { UserDefaults.standard.set(reduceMotion, forKey: Keys.reduceMotion) }
    }

    public var preferredColorScheme: ColorScheme? {
        themeMode.colorScheme
    }

    private init() {
        let rawTheme = UserDefaults.standard.string(forKey: Keys.theme) ?? "system"
        self.themeMode = VeloThemePreference(rawValue: rawTheme) ?? .system

        let rawMat = UserDefaults.standard.string(forKey: Keys.material) ?? "frosted"
        self.materialStyle = VeloMaterialStyle(rawValue: rawMat) ?? .frosted

        self.reduceMotion = UserDefaults.standard.bool(forKey: Keys.reduceMotion)
    }
}

// MARK: - 2. 60fps.design / Linear / Family Spring Motion Dictionary & Haptics

public enum VeloMotion {
    /// Linear-style zero-slop crisp snap for direct controls & toggles
    public static let snappy: Animation = .spring(response: 0.24, dampingFraction: 0.78)
    /// Family-style playful tactile pop for approvals, copy confirmation, and primary FAB
    public static let bouncy: Animation = .spring(response: 0.34, dampingFraction: 0.64)
    /// Arc-style fluid spatial morph for folders, drawers, and sliding pills
    public static let smooth: Animation = .spring(response: 0.36, dampingFraction: 0.85)
    /// Gentle staggered entrance for cards
    public static let gentle: Animation = .spring(response: 0.44, dampingFraction: 0.88)
}

public enum VeloHaptics {
    public static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    public static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    public static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    public static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    public static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}

// MARK: - 3. Aceternity / Magic UI Micro Dot-Grid Canvas Background (Hero / Empty States Only)

public struct VeloDotGridBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    public var accent: Color = VeloTheme.accentViolet

    public init(accent: Color = VeloTheme.accentViolet) {
        self.accent = accent
    }

    public var body: some View {
        ZStack {
            // Subtle top radial ambient glow
            RadialGradient(
                colors: [
                    accent.opacity(colorScheme == .dark ? 0.14 : 0.08),
                    accent.opacity(colorScheme == .dark ? 0.04 : 0.02),
                    Color.clear,
                ],
                center: UnitPoint(x: 0.5, y: 0.24),
                startRadius: 12,
                endRadius: 260
            )
            .ignoresSafeArea()

            // Crisp 1px micro-dot pattern masked with radial fade so edges melt seamlessly
            Canvas { context, size in
                let spacing: CGFloat = 22
                let dotColor = colorScheme == .dark
                    ? Color.white.opacity(0.11)
                    : Color.black.opacity(0.085)
                let cols = Int(ceil(size.width / spacing))
                let rows = Int(ceil(size.height / spacing))
                for r in 0...rows {
                    for c in 0...cols {
                        let rect = CGRect(
                            x: CGFloat(c) * spacing + 6,
                            y: CGFloat(r) * spacing + 6,
                            width: 1.4,
                            height: 1.4
                        )
                        context.fill(Path(ellipseIn: rect), with: .color(dotColor))
                    }
                }
            }
            .mask(
                RadialGradient(
                    colors: [
                        Color.white,
                        Color.white.opacity(0.55),
                        Color.clear,
                    ],
                    center: UnitPoint(x: 0.5, y: 0.32),
                    startRadius: 20,
                    endRadius: 290
                )
            )
            .allowsHitTesting(false)
        }
    }
}

// MARK: - 4. Magic UI 1pt Rotating Border Beam (GPU 30fps TimelineView, Respects Reduce Motion)

public struct VeloBorderBeamModifier: ViewModifier {
    let active: Bool
    let accent: Color
    let cornerRadius: CGFloat
    let lineWidth: CGFloat
    let duration: Double

    @Environment(\.accessibilityReduceMotion) private var sysReduceMotion
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public func body(content: Content) -> some View {
        let shouldAnimate = active && !sysReduceMotion && !appearance.reduceMotion
        content.overlay {
            if shouldAnimate {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { ctx in
                    let angle = Angle.degrees(
                        ctx.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: duration) / duration * 360.0
                    )
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(
                            AngularGradient(
                                gradient: Gradient(stops: [
                                    .init(color: .clear, location: 0.0),
                                    .init(color: .clear, location: 0.72),
                                    .init(color: accent.opacity(0.25), location: 0.83),
                                    .init(color: accent.opacity(0.85), location: 0.93),
                                    .init(color: .clear, location: 1.0),
                                ]),
                                center: .center,
                                angle: angle
                            ),
                            lineWidth: lineWidth
                        )
                }
                .allowsHitTesting(false)
            } else if active {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(accent.opacity(0.45), lineWidth: lineWidth)
                    .allowsHitTesting(false)
            }
        }
    }
}

public extension View {
    func veloBorderBeam(
        active: Bool,
        accent: Color,
        cornerRadius: CGFloat = 16,
        lineWidth: CGFloat = 1.25,
        duration: Double = 3.6
    ) -> some View {
        modifier(
            VeloBorderBeamModifier(
                active: active,
                accent: accent,
                cornerRadius: cornerRadius,
                lineWidth: lineWidth,
                duration: duration
            )
        )
    }
}

// MARK: - 5. Magic UI Shimmer Sweep Overlay (For Primary CTAs)

public struct VeloShimmerSweepOverlay: View {
    public var cornerRadius: CGFloat = 999
    public var period: Double = 3.2
    @Environment(\.accessibilityReduceMotion) private var sysReduceMotion
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public init(cornerRadius: CGFloat = 999, period: Double = 3.2) {
        self.cornerRadius = cornerRadius
        self.period = period
    }

    public var body: some View {
        if !sysReduceMotion && !appearance.reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { ctx in
                let cycle = ctx.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: period) / period
                // Sweep briskly across first 42% of cycle, rest calmly for remaining 58%
                let progress = min(1.0, cycle / 0.42)
                let visible = cycle < 0.42

                GeometryReader { geo in
                    if visible {
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0.0),
                                .init(color: Color.white.opacity(0.26), location: 0.48),
                                .init(color: Color.white.opacity(0.40), location: 0.52),
                                .init(color: .clear, location: 1.0),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .frame(width: max(54, geo.size.width * 0.42))
                        .rotationEffect(.degrees(14))
                        .offset(x: -geo.size.width * 0.45 + CGFloat(progress) * (geo.size.width * 1.9))
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            }
            .allowsHitTesting(false)
        }
    }
}

// MARK: - 6. 60fps.design Stateless Radar Pulse Beacon

public struct VeloPulseBeacon: View {
    public let color: Color
    public var active: Bool = true
    public var size: CGFloat = 8

    @Environment(\.accessibilityReduceMotion) private var sysReduceMotion
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public init(color: Color, active: Bool = true, size: CGFloat = 8) {
        self.color = color
        self.active = active
        self.size = size
    }

    public var body: some View {
        let animate = active && !sysReduceMotion && !appearance.reduceMotion
        ZStack {
            if animate {
                TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { ctx in
                    let p = ctx.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: 2.1) / 2.1
                    Circle()
                        .stroke(color.opacity(max(0, (1.0 - p) * 0.65)), lineWidth: 1.3)
                        .frame(width: size, height: size)
                        .scaleEffect(1.0 + CGFloat(p) * 1.65)
                }
            } else {
                Circle()
                    .fill(color.opacity(0.22))
                    .frame(width: size * 2.1, height: size * 2.1)
            }

            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .shadow(color: color.opacity(0.55), radius: 3)
        }
        .frame(width: size * 2.6, height: size * 2.6)
    }
}

// MARK: - 7. HeroUI + Aceternity Surface & Ambient Aura Card Modifier

public struct VeloSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat
    let auraAccent: Color?
    let elevated: Bool

    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let baseFill = elevated ? VeloTheme.elevatedSurface(colorScheme) : VeloTheme.cardSurface(colorScheme)

        content
            .background {
                ZStack {
                    switch appearance.materialStyle {
                    case .matte:
                        shape.fill(baseFill)
                    case .frosted:
                        shape
                            .fill(.ultraThinMaterial)
                            .overlay(shape.fill(baseFill.opacity(colorScheme == .dark ? 0.78 : 0.86)))
                    case .specular:
                        shape
                            .fill(.ultraThinMaterial)
                            .overlay(shape.fill(baseFill.opacity(colorScheme == .dark ? 0.68 : 0.80)))
                    }

                    // Aceternity subtle top-leading brand aura
                    if let auraAccent, appearance.materialStyle != .matte {
                        let auraStrength: Double = appearance.materialStyle == .specular
                            ? (colorScheme == .dark ? 0.14 : 0.08)
                            : (colorScheme == .dark ? 0.08 : 0.045)
                        shape.fill(
                            RadialGradient(
                                colors: [auraAccent.opacity(auraStrength), Color.clear],
                                center: .topLeading,
                                startRadius: 4,
                                endRadius: 150
                            )
                        )
                    }
                }
            }
            .overlay(
                shape.stroke(
                    appearance.materialStyle == .matte
                        ? AnyShapeStyle(VeloTheme.hairline(colorScheme))
                        : AnyShapeStyle(VeloTheme.specularRim(colorScheme)),
                    lineWidth: appearance.materialStyle == .specular ? 1.05 : 0.85
                )
            )
            .shadow(
                color: colorScheme == .dark
                    ? Color.black.opacity(appearance.materialStyle == .matte ? 0.0 : 0.24)
                    : Color.black.opacity(appearance.materialStyle == .matte ? 0.03 : 0.06),
                radius: appearance.materialStyle == .specular ? 12 : 6,
                x: 0,
                y: appearance.materialStyle == .specular ? 5 : 2
            )
    }
}

public extension View {
    func veloSurface(
        cornerRadius: CGFloat = 16,
        aura: Color? = nil,
        elevated: Bool = false
    ) -> some View {
        modifier(VeloSurfaceModifier(cornerRadius: cornerRadius, auraAccent: aura, elevated: elevated))
    }
}

// MARK: - 8. Family-Style Staggered Card Entrance

public struct VeloStaggerAppearModifier: ViewModifier {
    let index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var sysReduceMotion
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public func body(content: Content) -> some View {
        let skip = sysReduceMotion || appearance.reduceMotion
        content
            .opacity(skip || shown ? 1 : 0)
            .offset(y: skip || shown ? 0 : 9)
            .scaleEffect(skip || shown ? 1 : 0.985)
            .onAppear {
                guard !shown else { return }
                if skip {
                    shown = true
                } else {
                    let delay = Double(min(index, 6)) * 0.032
                    withAnimation(VeloMotion.smooth.delay(delay)) {
                        shown = true
                    }
                }
            }
    }
}

public extension View {
    func veloStaggerAppear(index: Int) -> some View {
        modifier(VeloStaggerAppearModifier(index: index))
    }
}

// MARK: - 9. Quota Brand Gradients (1:1 Parity with Desktop SidebarQuotaBar)

public enum VeloQuotaPalette {
    public static func gradient(for provider: String, status: String) -> LinearGradient {
        if status == "exhausted" {
            return LinearGradient(
                colors: [Color(red: 0.86, green: 0.15, blue: 0.15), VeloTheme.coral],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
        if status == "warning" {
            return LinearGradient(
                colors: [Color(red: 0.85, green: 0.47, blue: 0.02), VeloTheme.amber],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
        switch provider {
        case "antigravity":
            return LinearGradient(
                colors: [Color(red: 0.23, green: 0.51, blue: 0.96), Color(red: 0.38, green: 0.65, blue: 0.98)],
                startPoint: .leading,
                endPoint: .trailing
            )
        case "cursor":
            return LinearGradient(
                colors: [Color(red: 0.55, green: 0.36, blue: 0.96), Color(red: 0.75, green: 0.52, blue: 0.99)],
                startPoint: .leading,
                endPoint: .trailing
            )
        case "claude":
            return LinearGradient(
                colors: [Color(red: 0.85, green: 0.47, blue: 0.34), Color(red: 0.96, green: 0.62, blue: 0.04)],
                startPoint: .leading,
                endPoint: .trailing
            )
        default:
            return LinearGradient(
                colors: [Color(red: 0.06, green: 0.73, blue: 0.51), VeloTheme.emerald],
                startPoint: .leading,
                endPoint: .trailing
            )
        }
    }

    public static func accent(for provider: String) -> Color {
        switch provider {
        case "antigravity": return Color(red: 0.36, green: 0.58, blue: 0.98)
        case "cursor": return Color(red: 0.65, green: 0.55, blue: 0.98)
        case "claude": return Color(red: 0.85, green: 0.47, blue: 0.34)
        case "codex": return Color(red: 0.06, green: 0.64, blue: 0.50)
        default: return VeloTheme.emerald
        }
    }

    public static func icon(for provider: String) -> String {
        switch provider {
        case "antigravity": return "atom"
        case "cursor": return "cursorarrow.rays"
        case "claude": return "sparkles"
        case "codex": return "terminal.fill"
        default: return "cpu"
        }
    }

    public static func shortName(for provider: String, fallback: String) -> String {
        switch provider {
        case "antigravity": return "Antigravity"
        case "cursor": return "Cursor"
        case "claude": return "Claude"
        case "codex": return "Codex"
        default: return fallback
        }
    }

    public static func compactTag(for provider: String, fallback: String) -> String {
        switch provider {
        case "antigravity": return "AGY"
        case "cursor": return "Cursor"
        case "claude": return "Claude"
        case "codex": return "Codex"
        default: return fallback
        }
    }

    public static func pctColor(for status: String) -> Color {
        if status == "exhausted" { return VeloTheme.coral }
        if status == "warning" { return VeloTheme.amber }
        return .primary
    }
}

// MARK: - 10. Fast Lightweight Syntax Highlighter (Aligned with Desktop --tok-* Palette)

public enum VeloCodeSyntaxHighlighter {
    private static let keywords: Set<String> = [
        "import", "export", "from", "return", "if", "else", "for", "while", "switch", "case", "default",
        "break", "continue", "guard", "let", "var", "const", "func", "function", "fn", "def", "class",
        "struct", "enum", "protocol", "interface", "type", "impl", "trait", "pub", "public", "private",
        "internal", "static", "async", "await", "try", "catch", "throw", "throws", "mut", "match",
        "use", "mod", "crate", "self", "Self", "super", "true", "false", "nil", "null", "None", "Some",
        "Ok", "Err", "in", "as", "is", "new", "extends", "implements", "override", "final", "where",
        "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "TABLE", "JOIN", "ORDER", "BY",
    ]

    public static func highlight(_ code: String, language: String, colorScheme: ColorScheme) -> AttributedString {
        var result = AttributedString(code)
        let isDark = colorScheme == .dark
        let kwColor = isDark ? Color(red: 0.75, green: 0.52, blue: 0.99) : Color(red: 0.49, green: 0.23, blue: 0.93)
        let strColor = isDark ? Color(red: 0.43, green: 0.91, blue: 0.72) : Color(red: 0.02, green: 0.47, blue: 0.34)
        let numColor = isDark ? Color(red: 0.98, green: 0.75, blue: 0.14) : Color(red: 0.71, green: 0.33, blue: 0.04)
        let comColor = Color.secondary.opacity(0.75)
        let typeColor = isDark ? Color(red: 0.49, green: 0.83, blue: 0.99) : Color(red: 0.01, green: 0.41, blue: 0.63)

        // Cap syntax regex work on giant pastes to guarantee instant 120fps scrolling
        guard code.count <= 14_000 else { return result }

        let nsCode = code as NSString
        let fullRange = NSRange(location: 0, length: nsCode.length)

        func applyRegex(_ pattern: String, color: Color, options: NSRegularExpression.Options = []) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for match in regex.matches(in: code, options: [], range: fullRange) {
                guard let swiftRange = Range(match.range, in: code),
                      let attrRange = Range(swiftRange, in: result)
                else { continue }
                result[attrRange].foregroundColor = color
            }
        }

        // 1. Types (Capitalized identifiers)
        applyRegex(#"\b[A-Z][A-Za-z0-9_]{1,32}\b"#, color: typeColor)
        // 2. Numbers
        applyRegex(#"\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b"#, color: numColor)
        // 3. Keywords
        if let wordRegex = try? NSRegularExpression(pattern: #"\b[A-Za-z_][A-Za-z0-9_]*\b"#) {
            for match in wordRegex.matches(in: code, options: [], range: fullRange) {
                let word = nsCode.substring(with: match.range)
                guard keywords.contains(word),
                      let swiftRange = Range(match.range, in: code),
                      let attrRange = Range(swiftRange, in: result)
                else { continue }
                result[attrRange].foregroundColor = kwColor
            }
        }
        // 4. Strings (double / single / backtick)
        applyRegex(#""(?:\\.|[^"\\])*""#, color: strColor)
        applyRegex(#"'(?:\\.|[^'\\])*'"#, color: strColor)
        // 5. Comments (applied last so comments override embedded keywords/strings)
        applyRegex(#"//[^\n]*"#, color: comColor)
        if language.lowercased() == "python" || language.lowercased() == "py"
            || language.lowercased() == "bash" || language.lowercased() == "sh"
            || language.lowercased() == "zsh" || language.lowercased() == "yaml"
        {
            applyRegex(#"#[^\n]*"#, color: comColor)
        }
        applyRegex(#"/\*[\s\S]*?\*/"#, color: comColor)

        return result
    }
}

// MARK: - 11. Appearance & Material Settings Sheet (Mirrors Desktop SettingsModal)

public struct VeloAppearanceSettingsSheet: View {
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Namespace private var themeNamespace

    public init() {}

    public var body: some View {
        NavigationStack {
            ZStack {
                VeloTheme.canvas(colorScheme)
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // 1. Theme Mode Sliding Control
                        VStack(alignment: .leading, spacing: 10) {
                            Text("外观主题")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.secondary)

                            HStack(spacing: 6) {
                                ForEach(VeloThemePreference.allCases) { mode in
                                    let selected = appearance.themeMode == mode
                                    Button {
                                        VeloHaptics.selection()
                                        withAnimation(VeloMotion.snappy) {
                                            appearance.themeMode = mode
                                        }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(systemName: mode.iconName)
                                                .font(.system(size: 12.5, weight: .semibold))
                                            Text(mode.title)
                                                .font(.system(size: 13, weight: .semibold))
                                        }
                                        .foregroundStyle(selected ? .primary : .secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .background {
                                            if selected {
                                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                                    .fill(VeloTheme.elevatedSurface(colorScheme))
                                                    .overlay(
                                                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                                                            .stroke(VeloTheme.specularRim(colorScheme), lineWidth: 0.9)
                                                    )
                                                    .matchedGeometryEffect(id: "themePill", in: themeNamespace)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(4)
                            .veloSurface(cornerRadius: 15)
                        }

                        // 2. Surface Material Picker
                        VStack(alignment: .leading, spacing: 10) {
                            Text("表面材质")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.secondary)

                            VStack(spacing: 9) {
                                ForEach(VeloMaterialStyle.allCases) { style in
                                    let active = appearance.materialStyle == style
                                    Button {
                                        VeloHaptics.selection()
                                        withAnimation(VeloMotion.snappy) {
                                            appearance.materialStyle = style
                                        }
                                    } label: {
                                        HStack(spacing: 12) {
                                            materialSwatch(style)
                                            VStack(alignment: .leading, spacing: 2.5) {
                                                Text(style.title)
                                                    .font(.system(size: 14, weight: .semibold))
                                                    .foregroundStyle(.primary)
                                                Text(style.subtitle)
                                                    .font(.system(size: 12))
                                                    .foregroundStyle(.secondary)
                                            }
                                            Spacer()
                                            Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                                .font(.system(size: 18, weight: .medium))
                                                .foregroundStyle(active ? VeloTheme.accentVioletSoft : Color.secondary.opacity(0.35))
                                                .contentTransition(.symbolEffect(.replace))
                                        }
                                        .padding(13)
                                        .veloSurface(
                                            cornerRadius: 15,
                                            aura: active ? VeloTheme.accentViolet : nil
                                        )
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                                .stroke(
                                                    active ? VeloTheme.accentVioletSoft.opacity(0.55) : Color.clear,
                                                    lineWidth: 1.2
                                                )
                                        )
                                    }
                                    .buttonStyle(VeloPressableButtonStyle(scale: 0.985))
                                }
                            }
                        }

                        // 3. Motion Accessibility
                        VStack(alignment: .leading, spacing: 10) {
                            Text("动效与省电")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.secondary)

                            Toggle(isOn: $appearance.reduceMotion) {
                                VStack(alignment: .leading, spacing: 2.5) {
                                    Text("减弱动态效果")
                                        .font(.system(size: 14, weight: .medium))
                                    Text("暂停流光描边、扫光和入场弹性动画")
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .tint(VeloTheme.accentViolet)
                            .padding(14)
                            .veloSurface(cornerRadius: 15)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("外观与材质")
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

    private func materialSwatch(_ style: VeloMaterialStyle) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return ZStack {
            switch style {
            case .matte:
                shape.fill(VeloTheme.cardSurface(colorScheme))
                    .overlay(shape.stroke(VeloTheme.hairline(colorScheme), lineWidth: 1))
            case .frosted:
                shape.fill(.ultraThinMaterial)
                    .overlay(shape.fill(VeloTheme.accentViolet.opacity(0.08)))
                    .overlay(shape.stroke(VeloTheme.specularRim(colorScheme), lineWidth: 1))
            case .specular:
                shape.fill(
                    RadialGradient(
                        colors: [VeloTheme.accentViolet.opacity(0.32), VeloTheme.cardSurface(colorScheme)],
                        center: .topLeading,
                        startRadius: 2,
                        endRadius: 34
                    )
                )
                .overlay(shape.stroke(VeloTheme.accentVioletSoft.opacity(0.55), lineWidth: 1.1))
            }
            Image(systemName: style == .matte ? "square.fill" : (style == .frosted ? "square.on.square" : "sparkles"))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(style == .matte ? Color.secondary : VeloTheme.accentVioletSoft)
        }
        .frame(width: 38, height: 38)
    }
}
