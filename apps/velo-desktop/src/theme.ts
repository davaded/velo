export type PaseoThemeId = "paseo" | "claude" | "zinc" | "midnight" | "ghostty" | "light";

export interface PaseoColors {
  canvasBg: string;
  surfaceSidebar: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentGlow: string;
  destructive: string;
  statusSuccess: string;
  statusDanger: string;
  statusWarning: string;
  statusMerged: string;
  statusDotSuccess: string;
  statusDotDanger: string;
  statusDotWarning: string;
  statusDotRunning: string;
}

export interface PaseoThemeSpec {
  id: PaseoThemeId;
  label: string;
  description: string;
  isDark: boolean;
  colors: PaseoColors;
}

export const PASEO_THEMES: Record<PaseoThemeId, PaseoThemeSpec> = {
  paseo: {
    id: "paseo",
    label: "Velo Emerald",
    description: "Obsidian carbon with emerald-sage aurora",
    isDark: true,
    colors: {
      canvasBg: "#090B0A",
      surfaceSidebar: "#101312",
      surface0: "#131716",
      surface1: "#191E1C",
      surface2: "#212725",
      surface3: "#323A37",
      surface4: "#525C58",
      foreground: "#F8FAFA",
      foregroundMuted: "#9CA8A3",
      foregroundExtraMuted: "#68736F",
      border: "#202725",
      borderAccent: "#2E3835",
      accent: "#10B981",
      accentBright: "#6EE7B7",
      accentGlow: "rgba(16, 185, 129, 0.16)",
      destructive: "#EF4444",
      statusSuccess: "#34D399",
      statusDanger: "#F87171",
      statusWarning: "#FBBF24",
      statusMerged: "#A78BFA",
      statusDotSuccess: "#10B981",
      statusDotDanger: "#EF4444",
      statusDotWarning: "#F59E0B",
      statusDotRunning: "#38BDF8",
    },
  },
  midnight: {
    id: "midnight",
    label: "Cyber Indigo",
    description: "Deep space obsidian with electric indigo glow",
    isDark: true,
    colors: {
      canvasBg: "#07090E",
      surfaceSidebar: "#0D1017",
      surface0: "#11151F",
      surface1: "#171C29",
      surface2: "#1E2536",
      surface3: "#2E3852",
      surface4: "#4F5B7A",
      foreground: "#F5F7FF",
      foregroundMuted: "#94A3B8",
      foregroundExtraMuted: "#64748B",
      border: "#1E2638",
      borderAccent: "#2D3A54",
      accent: "#6366F1",
      accentBright: "#A5B4FC",
      accentGlow: "rgba(99, 102, 241, 0.18)",
      destructive: "#F43F5E",
      statusSuccess: "#34D399",
      statusDanger: "#FB7185",
      statusWarning: "#FBBF24",
      statusMerged: "#C084FC",
      statusDotSuccess: "#10B981",
      statusDotDanger: "#F43F5E",
      statusDotWarning: "#F59E0B",
      statusDotRunning: "#38BDF8",
    },
  },
  claude: {
    id: "claude",
    label: "Claude Warm",
    description: "Warm carbon stone with terracotta amber",
    isDark: true,
    colors: {
      canvasBg: "#0C0B0A",
      surfaceSidebar: "#141312",
      surface0: "#191816",
      surface1: "#22201E",
      surface2: "#2B2926",
      surface3: "#3E3B37",
      surface4: "#635F59",
      foreground: "#F7F5F0",
      foregroundMuted: "#A8A29E",
      foregroundExtraMuted: "#78716C",
      border: "#292724",
      borderAccent: "#3B3733",
      accent: "#D97757",
      accentBright: "#FDBA74",
      accentGlow: "rgba(217, 119, 87, 0.16)",
      destructive: "#EF4444",
      statusSuccess: "#4ADE80",
      statusDanger: "#F87171",
      statusWarning: "#FBBF24",
      statusMerged: "#C084FC",
      statusDotSuccess: "#22C55E",
      statusDotDanger: "#EF4444",
      statusDotWarning: "#F59E0B",
      statusDotRunning: "#FB923C",
    },
  },
  zinc: {
    id: "zinc",
    label: "Shadcn Zinc",
    description: "Pure monochrome studio contrast",
    isDark: true,
    colors: {
      canvasBg: "#09090B",
      surfaceSidebar: "#0F0F12",
      surface0: "#121216",
      surface1: "#18181C",
      surface2: "#222227",
      surface3: "#34343C",
      surface4: "#52525B",
      foreground: "#FAFAFA",
      foregroundMuted: "#A1A1AA",
      foregroundExtraMuted: "#71717A",
      border: "#222226",
      borderAccent: "#323238",
      accent: "#3B82F6",
      accentBright: "#93C5FD",
      accentGlow: "rgba(59, 130, 246, 0.15)",
      destructive: "#EF4444",
      statusSuccess: "#34D399",
      statusDanger: "#F87171",
      statusWarning: "#FBBF24",
      statusMerged: "#A78BFA",
      statusDotSuccess: "#10B981",
      statusDotDanger: "#EF4444",
      statusDotWarning: "#F59E0B",
      statusDotRunning: "#38BDF8",
    },
  },
  ghostty: {
    id: "ghostty",
    label: "Ghostty Violet",
    description: "Terminal synth slate with neon violet",
    isDark: true,
    colors: {
      canvasBg: "#0B0A10",
      surfaceSidebar: "#12101B",
      surface0: "#161421",
      surface1: "#1E1B2E",
      surface2: "#27233A",
      surface3: "#383252",
      surface4: "#58507A",
      foreground: "#F3F0FF",
      foregroundMuted: "#A39BBF",
      foregroundExtraMuted: "#6E668A",
      border: "#242038",
      borderAccent: "#352F52",
      accent: "#8B5CF6",
      accentBright: "#C4B5FD",
      accentGlow: "rgba(139, 92, 246, 0.18)",
      destructive: "#F43F5E",
      statusSuccess: "#34D399",
      statusDanger: "#FB7185",
      statusWarning: "#FBBF24",
      statusMerged: "#E879F9",
      statusDotSuccess: "#10B981",
      statusDotDanger: "#F43F5E",
      statusDotWarning: "#F59E0B",
      statusDotRunning: "#A78BFA",
    },
  },
  light: {
    id: "light",
    label: "Daylight Studio",
    description: "Crisp alabaster glass with emerald accents",
    isDark: false,
    colors: {
      canvasBg: "#EAECEB",
      surfaceSidebar: "#F5F7F6",
      surface0: "#FFFFFF",
      surface1: "#F3F5F4",
      surface2: "#E8ECEA",
      surface3: "#D1D8D5",
      surface4: "#94A09B",
      foreground: "#090D0B",
      foregroundMuted: "#4B5551",
      foregroundExtraMuted: "#7A8681",
      border: "#E1E6E3",
      borderAccent: "#C8D1CC",
      accent: "#059669",
      accentBright: "#047857",
      accentGlow: "rgba(5, 150, 105, 0.12)",
      destructive: "#DC2626",
      statusSuccess: "#16A34A",
      statusDanger: "#DC2626",
      statusWarning: "#D97706",
      statusMerged: "#7C3AED",
      statusDotSuccess: "#16A34A",
      statusDotDanger: "#DC2626",
      statusDotWarning: "#D97706",
      statusDotRunning: "#2563EB",
    },
  },
};

export function applyPaseoTheme(themeId: PaseoThemeId) {
  const spec = PASEO_THEMES[themeId] ?? PASEO_THEMES.paseo;
  const root = document.documentElement;
  const c = spec.colors;
  root.style.setProperty("--canvas-bg", c.canvasBg);
  root.style.setProperty("--surface-sidebar", c.surfaceSidebar);
  root.style.setProperty("--surface-0", c.surface0);
  root.style.setProperty("--surface-1", c.surface1);
  root.style.setProperty("--surface-2", c.surface2);
  root.style.setProperty("--surface-3", c.surface3);
  root.style.setProperty("--surface-4", c.surface4);
  root.style.setProperty("--fg", c.foreground);
  root.style.setProperty("--fg-muted", c.foregroundMuted);
  root.style.setProperty("--fg-extra-muted", c.foregroundExtraMuted);
  root.style.setProperty("--border-subtle", c.border);
  root.style.setProperty("--border-accent", c.borderAccent);
  root.style.setProperty("--accent", c.accent);
  root.style.setProperty("--accent-bright", c.accentBright);
  root.style.setProperty("--accent-glow", c.accentGlow);
  root.style.setProperty("--destructive", c.destructive);
  root.style.setProperty("--status-success", c.statusSuccess);
  root.style.setProperty("--status-danger", c.statusDanger);
  root.style.setProperty("--status-warning", c.statusWarning);
  root.style.setProperty("--status-merged", c.statusMerged);
  root.style.setProperty("--dot-success", c.statusDotSuccess);
  root.style.setProperty("--dot-danger", c.statusDotDanger);
  root.style.setProperty("--dot-warning", c.statusDotWarning);
  root.style.setProperty("--dot-running", c.statusDotRunning);
}
