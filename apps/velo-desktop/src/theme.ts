export type VeloThemeId = "obsidian" | "titanium" | "cyber" | "nordic" | "solar";

export interface VeloColors {
  canvasBg: string;
  meshGlowA: string;
  meshGlowB: string;
  surfaceGlass: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  foreground: string;
  foregroundMuted: string;
  foregroundSubtle: string;
  border: string;
  borderBright: string;
  primary: string;
  primaryBright: string;
  primaryGlow: string;
  secondary: string;
  success: string;
  danger: string;
  warning: string;
}

export interface VeloThemeSpec {
  id: VeloThemeId;
  label: string;
  badge: string;
  isDark: boolean;
  colors: VeloColors;
}

export const VELO_THEMES: Record<VeloThemeId, VeloThemeSpec> = {
  obsidian: {
    id: "obsidian",
    label: "Prismatic Obsidian",
    badge: "Velo Signature",
    isDark: true,
    colors: {
      canvasBg: "#050609",
      meshGlowA: "rgba(99, 102, 241, 0.14)",
      meshGlowB: "rgba(6, 182, 212, 0.11)",
      surfaceGlass: "rgba(14, 16, 24, 0.78)",
      surface0: "#0B0D13",
      surface1: "#11141D",
      surface2: "#181C28",
      surface3: "#252B3D",
      foreground: "#F8FAFC",
      foregroundMuted: "#94A3B8",
      foregroundSubtle: "#64748B",
      border: "rgba(255, 255, 255, 0.07)",
      borderBright: "rgba(255, 255, 255, 0.15)",
      primary: "#6366F1",
      primaryBright: "#818CF8",
      primaryGlow: "rgba(99, 102, 241, 0.28)",
      secondary: "#06B6D4",
      success: "#10B981",
      danger: "#F43F5E",
      warning: "#F59E0B",
    },
  },
  cyber: {
    id: "cyber",
    label: "Neon Hyperdrive",
    badge: "Electric",
    isDark: true,
    colors: {
      canvasBg: "#06040B",
      meshGlowA: "rgba(217, 70, 239, 0.15)",
      meshGlowB: "rgba(14, 165, 233, 0.13)",
      surfaceGlass: "rgba(16, 12, 26, 0.80)",
      surface0: "#0C0914",
      surface1: "#141022",
      surface2: "#1D1730",
      surface3: "#2E244B",
      foreground: "#FAF5FF",
      foregroundMuted: "#A89EC4",
      foregroundSubtle: "#70658E",
      border: "rgba(217, 70, 239, 0.12)",
      borderBright: "rgba(217, 70, 239, 0.25)",
      primary: "#D946EF",
      primaryBright: "#F0ABFC",
      primaryGlow: "rgba(217, 70, 239, 0.30)",
      secondary: "#38BDF8",
      success: "#2DD4BF",
      danger: "#FB7185",
      warning: "#FBBF24",
    },
  },
  solar: {
    id: "solar",
    label: "Solar Carbon",
    badge: "Warm Gold",
    isDark: true,
    colors: {
      canvasBg: "#080706",
      meshGlowA: "rgba(249, 115, 22, 0.14)",
      meshGlowB: "rgba(234, 179, 8, 0.09)",
      surfaceGlass: "rgba(19, 16, 14, 0.82)",
      surface0: "#100E0C",
      surface1: "#181512",
      surface2: "#221D19",
      surface3: "#352E27",
      foreground: "#FEFCE8",
      foregroundMuted: "#A8A29E",
      foregroundSubtle: "#78716C",
      border: "rgba(255, 255, 255, 0.07)",
      borderBright: "rgba(249, 115, 22, 0.24)",
      primary: "#F97316",
      primaryBright: "#FDBA74",
      primaryGlow: "rgba(249, 115, 22, 0.26)",
      secondary: "#EAB308",
      success: "#22C55E",
      danger: "#EF4444",
      warning: "#F59E0B",
    },
  },
  nordic: {
    id: "nordic",
    label: "Arctic Cobalt",
    badge: "Minimal",
    isDark: true,
    colors: {
      canvasBg: "#04080E",
      meshGlowA: "rgba(56, 189, 248, 0.14)",
      meshGlowB: "rgba(59, 130, 246, 0.11)",
      surfaceGlass: "rgba(11, 18, 29, 0.80)",
      surface0: "#09101A",
      surface1: "#101927",
      surface2: "#172336",
      surface3: "#243550",
      foreground: "#F0F9FF",
      foregroundMuted: "#93AFC8",
      foregroundSubtle: "#5B7894",
      border: "rgba(148, 163, 184, 0.10)",
      borderBright: "rgba(56, 189, 248, 0.25)",
      primary: "#0EA5E9",
      primaryBright: "#7DD3FC",
      primaryGlow: "rgba(14, 165, 233, 0.28)",
      secondary: "#6366F1",
      success: "#10B981",
      danger: "#F43F5E",
      warning: "#F59E0B",
    },
  },
  titanium: {
    id: "titanium",
    label: "Titanium Alabaster",
    badge: "Light Studio",
    isDark: false,
    colors: {
      canvasBg: "#EEF2F6",
      meshGlowA: "rgba(99, 102, 241, 0.10)",
      meshGlowB: "rgba(6, 182, 212, 0.08)",
      surfaceGlass: "rgba(255, 255, 255, 0.85)",
      surface0: "#FFFFFF",
      surface1: "#F8FAFC",
      surface2: "#F1F5F9",
      surface3: "#E2E8F0",
      foreground: "#0F172A",
      foregroundMuted: "#475569",
      foregroundSubtle: "#94A3B8",
      border: "rgba(15, 23, 42, 0.08)",
      borderBright: "rgba(99, 102, 241, 0.25)",
      primary: "#4F46E5",
      primaryBright: "#4338CA",
      primaryGlow: "rgba(79, 70, 229, 0.18)",
      secondary: "#0891B2",
      success: "#059669",
      danger: "#E11D48",
      warning: "#D97706",
    },
  },
};

export function applyVeloTheme(themeId: VeloThemeId) {
  const spec = VELO_THEMES[themeId] ?? VELO_THEMES.obsidian;
  const root = document.documentElement;
  const c = spec.colors;
  root.style.setProperty("--canvas-bg", c.canvasBg);
  root.style.setProperty("--mesh-a", c.meshGlowA);
  root.style.setProperty("--mesh-b", c.meshGlowB);
  root.style.setProperty("--surface-glass", c.surfaceGlass);
  root.style.setProperty("--surface-0", c.surface0);
  root.style.setProperty("--surface-1", c.surface1);
  root.style.setProperty("--surface-2", c.surface2);
  root.style.setProperty("--surface-3", c.surface3);
  root.style.setProperty("--fg", c.foreground);
  root.style.setProperty("--fg-muted", c.foregroundMuted);
  root.style.setProperty("--fg-extra-muted", c.foregroundSubtle);
  root.style.setProperty("--border-subtle", c.border);
  root.style.setProperty("--border-accent", c.borderBright);
  root.style.setProperty("--accent", c.primary);
  root.style.setProperty("--accent-bright", c.primaryBright);
  root.style.setProperty("--accent-glow", c.primaryGlow);
  root.style.setProperty("--secondary", c.secondary);
  root.style.setProperty("--status-success", c.success);
  root.style.setProperty("--status-danger", c.danger);
  root.style.setProperty("--status-warning", c.warning);
  root.style.setProperty("--destructive", c.danger);
  root.style.setProperty("--dot-success", c.success);
  root.style.setProperty("--dot-danger", c.danger);
  root.style.setProperty("--dot-warning", c.warning);
  root.style.setProperty("--dot-running", c.secondary);
}

// Keep aliases for backward compatibility with existing imports
export type PaseoThemeId = VeloThemeId;
export const PASEO_THEMES = VELO_THEMES;
export const applyPaseoTheme = applyVeloTheme;
