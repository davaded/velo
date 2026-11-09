export type PaseoThemeId = "paseo" | "claude" | "zinc" | "midnight" | "ghostty" | "light";

export interface PaseoColors {
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

/**
 * Exact color tokens extracted from getpaseo/paseo (packages/app/src/styles/theme.ts)
 */
export const PASEO_THEMES: Record<PaseoThemeId, PaseoThemeSpec> = {
  paseo: {
    id: "paseo",
    label: "Paseo",
    description: "Forest-sage dark surface (Default)",
    isDark: true,
    colors: {
      surfaceSidebar: "#141716",
      surface0: "#181B1A",
      surface1: "#1E2120",
      surface2: "#272A29",
      surface3: "#434645",
      surface4: "#606463",
      foreground: "#fafafa",
      foregroundMuted: "#A1A5A4",
      foregroundExtraMuted: "#717574",
      border: "#252B2A",
      borderAccent: "#2F3534",
      accent: "#20744A",
      accentBright: "#7ccba0",
      destructive: "#c64f43",
      statusSuccess: "#6cb17b",
      statusDanger: "#d8847b",
      statusWarning: "#c09664",
      statusMerged: "#a890d5",
      statusDotSuccess: "#35c264",
      statusDotDanger: "#f7796d",
      statusDotWarning: "#db932e",
      statusDotRunning: "#5caaf6",
    },
  },
  claude: {
    id: "claude",
    label: "Claude",
    description: "Warm neutral dark with terracotta accent",
    isDark: true,
    colors: {
      surfaceSidebar: "#191918",
      surface0: "#1f1f1e",
      surface1: "#262625",
      surface2: "#30302e",
      surface3: "#454441",
      surface4: "#63625e",
      foreground: "#f5f4ef",
      foregroundMuted: "#a8a69e",
      foregroundExtraMuted: "#78766f",
      border: "#2e2e2b",
      borderAccent: "#3d3c38",
      accent: "#c6613f",
      accentBright: "#e58d6e",
      destructive: "#c64f43",
      statusSuccess: "#6cb17b",
      statusDanger: "#d8847b",
      statusWarning: "#c09664",
      statusMerged: "#a890d5",
      statusDotSuccess: "#35c264",
      statusDotDanger: "#f7796d",
      statusDotWarning: "#db932e",
      statusDotRunning: "#d97757",
    },
  },
  zinc: {
    id: "zinc",
    label: "Zinc",
    description: "Pure neutral monochrome",
    isDark: true,
    colors: {
      surfaceSidebar: "#131316",
      surface0: "#18181b",
      surface1: "#1f1f23",
      surface2: "#27272a",
      surface3: "#3f3f46",
      surface4: "#52525b",
      foreground: "#fafafa",
      foregroundMuted: "#a1a1aa",
      foregroundExtraMuted: "#71717a",
      border: "#27272a",
      borderAccent: "#343438",
      accent: "#3f3f46",
      accentBright: "#d4d4d8",
      destructive: "#c64f43",
      statusSuccess: "#6cb17b",
      statusDanger: "#d8847b",
      statusWarning: "#c09664",
      statusMerged: "#a890d5",
      statusDotSuccess: "#35c264",
      statusDotDanger: "#f7796d",
      statusDotWarning: "#db932e",
      statusDotRunning: "#5caaf6",
    },
  },
  midnight: {
    id: "midnight",
    label: "Midnight",
    description: "Deep obsidian blue",
    isDark: true,
    colors: {
      surfaceSidebar: "#11131a",
      surface0: "#161820",
      surface1: "#1c1f29",
      surface2: "#242834",
      surface3: "#393f52",
      surface4: "#545c75",
      foreground: "#f5f7ff",
      foregroundMuted: "#9ba3b8",
      foregroundExtraMuted: "#6b738a",
      border: "#222634",
      borderAccent: "#2e3346",
      accent: "#2d5a9e",
      accentBright: "#7eb0f5",
      destructive: "#c64f43",
      statusSuccess: "#6cb17b",
      statusDanger: "#d8847b",
      statusWarning: "#c09664",
      statusMerged: "#a890d5",
      statusDotSuccess: "#35c264",
      statusDotDanger: "#f7796d",
      statusDotWarning: "#db932e",
      statusDotRunning: "#5caaf6",
    },
  },
  ghostty: {
    id: "ghostty",
    label: "Ghostty",
    description: "Terminal slate dark",
    isDark: true,
    colors: {
      surfaceSidebar: "#1e2127",
      surface0: "#23272e",
      surface1: "#282c34",
      surface2: "#313640",
      surface3: "#434957",
      surface4: "#5c6370",
      foreground: "#abb2bf",
      foregroundMuted: "#848b98",
      foregroundExtraMuted: "#5c6370",
      border: "#2c313a",
      borderAccent: "#3b4048",
      accent: "#3b6ea5",
      accentBright: "#61afef",
      destructive: "#e06c75",
      statusSuccess: "#98c379",
      statusDanger: "#e06c75",
      statusWarning: "#e5c07b",
      statusMerged: "#c678dd",
      statusDotSuccess: "#98c379",
      statusDotDanger: "#e06c75",
      statusDotWarning: "#d19a66",
      statusDotRunning: "#61afef",
    },
  },
  light: {
    id: "light",
    label: "Light",
    description: "High-contrast warm daylight",
    isDark: false,
    colors: {
      surfaceSidebar: "#f3f4f3",
      surface0: "#ffffff",
      surface1: "#f8f9f8",
      surface2: "#eff1ef",
      surface3: "#d4d8d6",
      surface4: "#9ca3a0",
      foreground: "#09090b",
      foregroundMuted: "#525856",
      foregroundExtraMuted: "#878d8b",
      border: "#e4e7e5",
      borderAccent: "#d0d5d2",
      accent: "#1f7a4c",
      accentBright: "#155e39",
      destructive: "#dc2626",
      statusSuccess: "#16a34a",
      statusDanger: "#dc2626",
      statusWarning: "#d97706",
      statusMerged: "#7c3aed",
      statusDotSuccess: "#16a34a",
      statusDotDanger: "#dc2626",
      statusDotWarning: "#d97706",
      statusDotRunning: "#2563eb",
    },
  },
};

export function applyPaseoTheme(themeId: PaseoThemeId) {
  const spec = PASEO_THEMES[themeId] ?? PASEO_THEMES.paseo;
  const root = document.documentElement;
  const c = spec.colors;
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
