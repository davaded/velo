import SwiftUI
import UIKit

// MARK: - 1. Global Theme & Curated Palette Preferences (Default: A · Monochrome Editorial)

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

public enum VeloColorPalette: String, CaseIterable, Identifiable {
    case monochrome  // A · 极简黑白 (Default)
    case warm        // B · 暖沙陶土
    case titanium    // C · 深空钛蓝
    case sage        // D · 墨绿森林

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .monochrome: return "极简黑白"
        case .warm: return "暖沙陶土"
        case .titanium: return "深空钛蓝"
        case .sage: return "墨绿森林"
        }
    }

    public var subtitle: String {
        switch self {
        case .monochrome: return "炭黑底 + 象牙白主按钮，最克制耐看"
        case .warm: return "暖黑咖啡 + 陶土橙，长读护眼"
        case .titanium: return "深蓝灰钛金属 + 低饱和冰川靛"
        case .sage: return "深松炭黑 + 柔和鼠尾草绿"
        }
    }

    public var swatchColors: [Color] {
        switch self {
        case .monochrome: return [Color(hex: 0x09090B), Color(hex: 0x27272A), Color(hex: 0xF4F4F5)]
        case .warm: return [Color(hex: 0x131210), Color(hex: 0xD97757), Color(hex: 0xF5F2EB)]
        case .titanium: return [Color(hex: 0x080A0F), Color(hex: 0x8294FF), Color(hex: 0x64C2D4)]
        case .sage: return [Color(hex: 0x090C0B), Color(hex: 0x47C98F), Color(hex: 0xF2F5F3)]
        }
    }
}

@MainActor
public final class VeloAppearanceSettings: ObservableObject {
    public static let shared = VeloAppearanceSettings()

    private enum Keys {
        static let theme = "velo.ios.appearance.theme.v2"
        static let palette = "velo.ios.appearance.palette.v2"
        static let reduceMotion = "velo.ios.appearance.reduceMotion.v2"
    }

    @Published public var themeMode: VeloThemePreference {
        didSet { UserDefaults.standard.set(themeMode.rawValue, forKey: Keys.theme) }
    }

    @Published public var palette: VeloColorPalette {
        didSet { UserDefaults.standard.set(palette.rawValue, forKey: Keys.palette) }
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

        let rawPal = UserDefaults.standard.string(forKey: Keys.palette) ?? "monochrome"
        self.palette = VeloColorPalette(rawValue: rawPal) ?? .monochrome

        self.reduceMotion = UserDefaults.standard.bool(forKey: Keys.reduceMotion)
    }
}

public extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, opacity: alpha)
    }
}

// MARK: - 2. Palette-Aware Token Resolver (Pure Solid 120fps Surfaces!)

public struct VeloPaletteTokens {
    public let canvas: Color
    public let surface: Color
    public let elevated: Color
    public let divider: Color
    public let border: Color
    public let accent: Color
    public let accentForeground: Color
    public let accentSoft: Color
    public let accentText: Color
    public let ringPrimary: Color
    public let ringSecondary: Color
    public let heroTint: Color
    public let codeBg: Color
    public let codeHeader: Color
    public let userBubble: Color

    public static func resolve(_ palette: VeloColorPalette, scheme: ColorScheme) -> VeloPaletteTokens {
        let dark = (scheme == .dark)
        switch palette {
        case .monochrome:
            if dark {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0x09090B),
                    surface: Color(hex: 0x131316),
                    elevated: Color(hex: 0x1D1D22),
                    divider: Color.white.opacity(0.08),
                    border: Color.white.opacity(0.11),
                    accent: Color(hex: 0xF4F4F5),
                    accentForeground: Color(hex: 0x09090B),
                    accentSoft: Color.white.opacity(0.09),
                    accentText: Color(hex: 0xE4E4E7),
                    ringPrimary: Color(hex: 0xF4F4F5),
                    ringSecondary: Color(hex: 0x8E8E98),
                    heroTint: Color.white.opacity(0.06),
                    codeBg: Color(hex: 0x0C0C0F),
                    codeHeader: Color(hex: 0x15151A),
                    userBubble: Color(hex: 0x202026)
                )
            } else {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0xF6F6F4),
                    surface: Color.white,
                    elevated: Color(hex: 0xECECE9),
                    divider: Color.black.opacity(0.07),
                    border: Color.black.opacity(0.09),
                    accent: Color(hex: 0x18181B),
                    accentForeground: Color.white,
                    accentSoft: Color.black.opacity(0.065),
                    accentText: Color(hex: 0x18181B),
                    ringPrimary: Color(hex: 0x18181B),
                    ringSecondary: Color(hex: 0x71717A),
                    heroTint: Color.black.opacity(0.035),
                    codeBg: Color(hex: 0xF5F5F3),
                    codeHeader: Color(hex: 0xEBEBE7),
                    userBubble: Color(hex: 0xEAEAE6)
                )
            }

        case .warm:
            if dark {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0x131210),
                    surface: Color(hex: 0x1C1A17),
                    elevated: Color(hex: 0x27241F),
                    divider: Color(hex: 0xF5ECE0, alpha: 0.08),
                    border: Color(hex: 0xF5ECE0, alpha: 0.12),
                    accent: Color(hex: 0xD97757),
                    accentForeground: Color(hex: 0x14110F),
                    accentSoft: Color(hex: 0xD97757, alpha: 0.14),
                    accentText: Color(hex: 0xE48C6E),
                    ringPrimary: Color(hex: 0xD97757),
                    ringSecondary: Color(hex: 0xC4A47C),
                    heroTint: Color(hex: 0xD97757, alpha: 0.14),
                    codeBg: Color(hex: 0x151311),
                    codeHeader: Color(hex: 0x201D19),
                    userBubble: Color(hex: 0x292520)
                )
            } else {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0xF5F2EB),
                    surface: Color(hex: 0xFFFDF9),
                    elevated: Color(hex: 0xEBE6DC),
                    divider: Color(hex: 0x2D2418, alpha: 0.08),
                    border: Color(hex: 0x2D2418, alpha: 0.11),
                    accent: Color(hex: 0xC96442),
                    accentForeground: Color(hex: 0xFFFDF9),
                    accentSoft: Color(hex: 0xC96442, alpha: 0.11),
                    accentText: Color(hex: 0xB85636),
                    ringPrimary: Color(hex: 0xC96442),
                    ringSecondary: Color(hex: 0x8C7A64),
                    heroTint: Color(hex: 0xC96442, alpha: 0.08),
                    codeBg: Color(hex: 0xF6F2EA),
                    codeHeader: Color(hex: 0xECE6DB),
                    userBubble: Color(hex: 0xEDE7DC)
                )
            }

        case .titanium:
            if dark {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0x080A0F),
                    surface: Color(hex: 0x11141C),
                    elevated: Color(hex: 0x1A1F2B),
                    divider: Color(hex: 0xD2DEFF, alpha: 0.08),
                    border: Color(hex: 0xD2DEFF, alpha: 0.12),
                    accent: Color(hex: 0x8294FF),
                    accentForeground: Color(hex: 0x090C14),
                    accentSoft: Color(hex: 0x8294FF, alpha: 0.14),
                    accentText: Color(hex: 0x9AA9FF),
                    ringPrimary: Color(hex: 0x8294FF),
                    ringSecondary: Color(hex: 0x64C2D4),
                    heroTint: Color(hex: 0x8294FF, alpha: 0.14),
                    codeBg: Color(hex: 0x0B0E14),
                    codeHeader: Color(hex: 0x141824),
                    userBubble: Color(hex: 0x1D2332)
                )
            } else {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0xF3F5F9),
                    surface: Color.white,
                    elevated: Color(hex: 0xE8ECF4),
                    divider: Color(hex: 0x141E3C, alpha: 0.075),
                    border: Color(hex: 0x141E3C, alpha: 0.10),
                    accent: Color(hex: 0x4C5FD5),
                    accentForeground: Color.white,
                    accentSoft: Color(hex: 0x4C5FD5, alpha: 0.10),
                    accentText: Color(hex: 0x4456C4),
                    ringPrimary: Color(hex: 0x4C5FD5),
                    ringSecondary: Color(hex: 0x2B8CA3),
                    heroTint: Color(hex: 0x4C5FD5, alpha: 0.08),
                    codeBg: Color(hex: 0xF4F6FB),
                    codeHeader: Color(hex: 0xE9EDF6),
                    userBubble: Color(hex: 0xE7ECF7)
                )
            }

        case .sage:
            if dark {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0x090C0B),
                    surface: Color(hex: 0x111614),
                    elevated: Color(hex: 0x1A221F),
                    divider: Color(hex: 0xD7F0E4, alpha: 0.08),
                    border: Color(hex: 0xD7F0E4, alpha: 0.11),
                    accent: Color(hex: 0x47C98F),
                    accentForeground: Color(hex: 0x07120D),
                    accentSoft: Color(hex: 0x47C98F, alpha: 0.13),
                    accentText: Color(hex: 0x62D6A2),
                    ringPrimary: Color(hex: 0x47C98F),
                    ringSecondary: Color(hex: 0x8AB8A4),
                    heroTint: Color(hex: 0x47C98F, alpha: 0.13),
                    codeBg: Color(hex: 0x0B0F0D),
                    codeHeader: Color(hex: 0x141B18),
                    userBubble: Color(hex: 0x1B2420)
                )
            } else {
                return VeloPaletteTokens(
                    canvas: Color(hex: 0xF2F5F3),
                    surface: Color.white,
                    elevated: Color(hex: 0xE5ECE8),
                    divider: Color(hex: 0x0F2D20, alpha: 0.075),
                    border: Color(hex: 0x0F2D20, alpha: 0.10),
                    accent: Color(hex: 0x1D8A5E),
                    accentForeground: Color.white,
                    accentSoft: Color(hex: 0x1D8A5E, alpha: 0.10),
                    accentText: Color(hex: 0x18754F),
                    ringPrimary: Color(hex: 0x1D8A5E),
                    ringSecondary: Color(hex: 0x5B8C79),
                    heroTint: Color(hex: 0x1D8A5E, alpha: 0.08),
                    codeBg: Color(hex: 0xF3F7F5),
                    codeHeader: Color(hex: 0xE6EEE9),
                    userBubble: Color(hex: 0xE6EFE9)
                )
            }
        }
    }
}

// MARK: - 3. Unified Single-Damping Motion Physics & Semantic Haptics

public enum VeloMotion {
    /// Unified Linear/Family crisp spring used across the entire app
    public static let crisp: Animation = .spring(response: 0.28, dampingFraction: 0.82)
    /// Slightly quicker snap for direct tap & pill toggles
    public static let snappy: Animation = .spring(response: 0.22, dampingFraction: 0.84)
    /// Slightly gentler morph for Family tray height & ring fill
    public static let smooth: Animation = .spring(response: 0.36, dampingFraction: 0.86)
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

// MARK: - 4. Official Manufacturer Vector SVG Brand Icon (Native Assets.xcassets)

public struct VeloBrandIcon: View {
    public let provider: String
    public var size: CGFloat = 15
    public var colored: Bool = true

    public init(provider: String, size: CGFloat = 15, colored: Bool = true) {
        self.provider = provider
        self.size = size
        self.colored = colored
    }

    public init(category: VeloEngineCategory, size: CGFloat = 15, colored: Bool = true) {
        self.provider = category.rawValue
        self.size = size
        self.colored = colored
    }

    private var lower: String { provider.lowercased() }

    public var body: some View {
        Group {
            if lower.contains("claude") {
                if colored {
                    Image("BrandClaude")
                        .resizable()
                        .renderingMode(.original)
                } else {
                    Image("BrandClaudeMono")
                        .resizable()
                        .renderingMode(.template)
                }
            } else if lower.contains("codex") || lower.contains("openai") || lower.contains("gpt") {
                Image("BrandOpenAI")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("antigravity") || lower.contains("agy") {
                Image("BrandAntigravity")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("gemini") {
                if colored {
                    Image("BrandGemini")
                        .resizable()
                        .renderingMode(.original)
                } else {
                    Image("BrandGeminiMono")
                        .resizable()
                        .renderingMode(.template)
                }
            } else if lower.contains("cursor") {
                Image("BrandCursor")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("grok") || lower.contains("xai") {
                Image("BrandGrok")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("opencode") {
                Image("BrandOpenCode")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("copilot") {
                Image("BrandCopilot")
                    .resizable()
                    .renderingMode(.template)
            } else if lower.contains("qwen") {
                Image("BrandQwen")
                    .resizable()
                    .renderingMode(.original)
            } else {
                Image(systemName: "terminal")
                    .resizable()
            }
        }
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
        .opacity(colored ? 1.0 : 0.65)
    }
}

// MARK: - 5. Pure Solid 120fps Surface Modifier (ZERO Live Blur / Dynamic Shadow Inside Scroll!)

public struct VeloSolidCardModifier: ViewModifier {
    let cornerRadius: CGFloat
    let elevated: Bool

    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject private var appearance = VeloAppearanceSettings.shared

    public func body(content: Content) -> some View {
        let tokens = VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(elevated ? tokens.elevated : tokens.surface, in: shape)
            .overlay(shape.stroke(tokens.divider, lineWidth: 0.75))
    }
}

public extension View {
    /// 120fps pure-solid card surface — safe inside ScrollView & LazyVStack.
    func veloSurface(
        cornerRadius: CGFloat = 16,
        aura: Color? = nil,
        elevated: Bool = false
    ) -> some View {
        modifier(VeloSolidCardModifier(cornerRadius: cornerRadius, elevated: elevated))
    }
}

// MARK: - 6. Copilot-Style Quota Ring Gauge (One-Shot Smooth Draw on Appear, Zero Idle Polling)

public struct VeloQuotaRingView: View {
    public let remainingPercent: Double
    public let ringColor: Color
    public let centerCaption: String
    public var size: CGFloat = 82

    @Environment(\.colorScheme) private var colorScheme
    @State private var animatedFraction: CGFloat = 0

    public init(
        remainingPercent: Double,
        ringColor: Color,
        centerCaption: String,
        size: CGFloat = 82
    ) {
        self.remainingPercent = remainingPercent
        self.ringColor = ringColor
        self.centerCaption = centerCaption
        self.size = size
    }

    public var body: some View {
        let clamped = max(0, min(100, remainingPercent))
        let target = CGFloat(clamped / 100.0)

        ZStack {
            Circle()
                .stroke(
                    colorScheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.075),
                    lineWidth: 6
                )

            Circle()
                .trim(from: 0, to: max(0.03, animatedFraction))
                .stroke(
                    ringColor,
                    style: StrokeStyle(lineWidth: 6, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            VStack(spacing: 1) {
                Text("\(Int(clamped.rounded()))%")
                    .font(.system(size: 17.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(.primary)
                    .contentTransition(.numericText())
                Text(centerCaption)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .onAppear {
            withAnimation(VeloMotion.smooth) {
                animatedFraction = target
            }
        }
        .onChange(of: remainingPercent) { _, newVal in
            withAnimation(VeloMotion.smooth) {
                animatedFraction = CGFloat(max(0, min(100, newVal)) / 100.0)
            }
        }
    }
}

// MARK: - 7. Quota Brand Palette Helpers

public enum VeloQuotaPalette {
    public static func ringColor(for provider: String, status: String, tokens: VeloPaletteTokens, isFirst: Bool) -> Color {
        if status == "exhausted" { return VeloTheme.coral }
        if status == "warning" { return VeloTheme.amber }
        return isFirst ? tokens.ringPrimary : tokens.ringSecondary
    }

    @MainActor
    public static func gradient(for provider: String, status: String) -> LinearGradient {
        if status == "exhausted" {
            return LinearGradient(colors: [Color(hex: 0xDC2626), VeloTheme.coral], startPoint: .leading, endPoint: .trailing)
        }
        if status == "warning" {
            return LinearGradient(colors: [Color(hex: 0xD97706), VeloTheme.amber], startPoint: .leading, endPoint: .trailing)
        }
        let accent = VeloPaletteTokens.resolve(VeloAppearanceSettings.shared.palette, scheme: .dark).ringPrimary
        return LinearGradient(colors: [accent.opacity(0.8), accent], startPoint: .leading, endPoint: .trailing)
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

    public static func pctColor(for status: String) -> Color {
        if status == "exhausted" { return VeloTheme.coral }
        if status == "warning" { return VeloTheme.amber }
        return .primary
    }
}

// MARK: - 8. Async-Cached Syntax Highlighter (Zero Regex Execution During Scroll/Typing!)

public final class VeloCodeHighlightCache {
    public static let shared = VeloCodeHighlightCache()
    private let cache = NSCache<NSString, NSAttributedString>()

    private init() {
        cache.countLimit = 180
    }

    public func cached(key: String) -> AttributedString? {
        guard let ns = cache.object(forKey: key as NSString) else { return nil }
        return try? AttributedString(ns, including: \.uiKit)
    }

    public func store(_ attr: AttributedString, key: String) {
        if let ns = try? NSAttributedString(attr, including: \.uiKit) {
            cache.setObject(ns, forKey: key as NSString)
        }
    }
}

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

    public static func highlightAsync(_ code: String, language: String, isDark: Bool) async -> AttributedString {
        let key = "\(isDark ? "d" : "l")|\(language)|\(code.hashValue)|\(code.count)"
        if let hit = VeloCodeHighlightCache.shared.cached(key: key) {
            return hit
        }
        let computed = await Task.detached(priority: .userInitiated) {
            compute(code, language: language, isDark: isDark)
        }.value
        VeloCodeHighlightCache.shared.store(computed, key: key)
        return computed
    }

    private static func compute(_ code: String, language: String, isDark: Bool) -> AttributedString {
        var result = AttributedString(code)
        guard code.count <= 14_000 else { return result }

        let kwColor = isDark ? UIColor(red: 0.78, green: 0.62, blue: 0.98, alpha: 1) : UIColor(red: 0.45, green: 0.22, blue: 0.82, alpha: 1)
        let strColor = isDark ? UIColor(red: 0.48, green: 0.86, blue: 0.68, alpha: 1) : UIColor(red: 0.07, green: 0.48, blue: 0.32, alpha: 1)
        let numColor = isDark ? UIColor(red: 0.94, green: 0.74, blue: 0.34, alpha: 1) : UIColor(red: 0.68, green: 0.35, blue: 0.06, alpha: 1)
        let comColor = UIColor.secondaryLabel.withAlphaComponent(0.72)
        let typeColor = isDark ? UIColor(red: 0.56, green: 0.80, blue: 0.96, alpha: 1) : UIColor(red: 0.07, green: 0.40, blue: 0.62, alpha: 1)

        let nsCode = code as NSString
        let fullRange = NSRange(location: 0, length: nsCode.length)

        func applyRegex(_ pattern: String, color: UIColor) {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
            for match in regex.matches(in: code, options: [], range: fullRange) {
                guard let swiftRange = Range(match.range, in: code),
                      let attrRange = Range(swiftRange, in: result)
                else { continue }
                result[attrRange].foregroundColor = Color(color)
            }
        }

        applyRegex(#"\b[A-Z][A-Za-z0-9_]{1,32}\b"#, color: typeColor)
        applyRegex(#"\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b"#, color: numColor)
        if let wordRegex = try? NSRegularExpression(pattern: #"\b[A-Za-z_][A-Za-z0-9_]*\b"#) {
            for match in wordRegex.matches(in: code, options: [], range: fullRange) {
                let word = nsCode.substring(with: match.range)
                guard keywords.contains(word),
                      let swiftRange = Range(match.range, in: code),
                      let attrRange = Range(swiftRange, in: result)
                else { continue }
                result[attrRange].foregroundColor = Color(kwColor)
            }
        }
        applyRegex(#""(?:\\.|[^"\\])*""#, color: strColor)
        applyRegex(#"'(?:\\.|[^'\\])*'"#, color: strColor)
        applyRegex(#"//[^\n]*"#, color: comColor)
        let lang = language.lowercased()
        if lang == "python" || lang == "py" || lang == "bash" || lang == "sh" || lang == "zsh" || lang == "yaml" {
            applyRegex(#"#[^\n]*"#, color: comColor)
        }
        applyRegex(#"/\*[\s\S]*?\*/"#, color: comColor)

        return result
    }
}

// MARK: - 9. Appearance & Palette Settings Sheet (Monochrome Default + B / C / D)

public struct VeloAppearanceSettingsSheet: View {
    @ObservedObject private var appearance = VeloAppearanceSettings.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Namespace private var themeNS

    public init() {}

    public var body: some View {
        let tokens = VeloPaletteTokens.resolve(appearance.palette, scheme: colorScheme)
        NavigationStack {
            ZStack {
                tokens.canvas.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // 1. Dark / Light / System
                        VStack(alignment: .leading, spacing: 8) {
                            Text("深浅模式")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)

                            HStack(spacing: 4) {
                                ForEach(VeloThemePreference.allCases) { mode in
                                    let selected = appearance.themeMode == mode
                                    Button {
                                        VeloHaptics.selection()
                                        withAnimation(VeloMotion.snappy) {
                                            appearance.themeMode = mode
                                        }
                                    } label: {
                                        HStack(spacing: 5) {
                                            Image(systemName: mode.iconName)
                                                .font(.system(size: 12, weight: .semibold))
                                            Text(mode.title)
                                                .font(.system(size: 13, weight: .semibold))
                                        }
                                        .foregroundStyle(selected ? .primary : .secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 9.5)
                                        .background {
                                            if selected {
                                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                    .fill(tokens.elevated)
                                                    .matchedGeometryEffect(id: "modePill", in: themeNS)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(4)
                            .veloSurface(cornerRadius: 14)
                        }

                        // 2. Curated Color Palettes (A / B / C / D)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("主题色板")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)

                            VStack(spacing: 0) {
                                ForEach(Array(VeloColorPalette.allCases.enumerated()), id: \.element.id) { idx, pal in
                                    let active = appearance.palette == pal
                                    if idx > 0 {
                                        Rectangle()
                                            .fill(tokens.divider)
                                            .frame(height: 0.7)
                                            .padding(.leading, 56)
                                    }
                                    Button {
                                        VeloHaptics.selection()
                                        withAnimation(VeloMotion.crisp) {
                                            appearance.palette = pal
                                        }
                                    } label: {
                                        HStack(spacing: 12) {
                                            HStack(spacing: -5) {
                                                ForEach(Array(pal.swatchColors.enumerated()), id: \.offset) { _, c in
                                                    Circle()
                                                        .fill(c)
                                                        .frame(width: 16, height: 16)
                                                        .overlay(Circle().stroke(tokens.surface, lineWidth: 1.5))
                                                }
                                            }
                                            .frame(width: 36)

                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(pal.title)
                                                    .font(.system(size: 14.5, weight: .semibold))
                                                    .foregroundStyle(.primary)
                                                Text(pal.subtitle)
                                                    .font(.system(size: 11.5))
                                                    .foregroundStyle(.secondary)
                                            }

                                            Spacer()

                                            if active {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 13.5, weight: .bold))
                                                    .foregroundStyle(tokens.accentText)
                                            }
                                        }
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 12.5)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .veloSurface(cornerRadius: 16)
                        }

                        // 3. Motion Toggle
                        VStack(alignment: .leading, spacing: 8) {
                            Text("动效")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 4)

                            Toggle(isOn: $appearance.reduceMotion) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("减弱动态效果")
                                        .font(.system(size: 14, weight: .medium))
                                    Text("关闭过渡缩放与环形描边动画")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .tint(tokens.accent)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                            .veloSurface(cornerRadius: 16)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("外观与配色")
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
