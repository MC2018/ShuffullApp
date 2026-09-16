// Design tokens for the "Aurora · Oxblood" theme.
//
// IMPORTANT: this file is intentionally free of React Native imports. It is a plain,
// framework-agnostic data module so the future web client can import the exact same values
// (see design/design-plan.md §4 and §9). Keep it that way — no `react-native` here.

export const palette = {
    charcoal: "#0d0b0c",
    charcoalDeep: "#0a0708",
    wine: "#c25b54",
    wineDeep: "#8f3b46",
    wineTint: "#e6b3ad",
    ink: "#f1eced",
    inkMuted: "#a59a9c",
    inkFaint: "#6b6063",
    sage: "#6f9e7e",
    neutralFill: "#2a2326",
    white: "#ffffff",
    black: "#000000",
} as const;

export const color = {
    bg: palette.charcoal,
    bgDeep: palette.charcoalDeep,
    surface: "rgba(255,245,246,0.05)",
    surfaceAlt: "rgba(255,245,246,0.09)",
    line: "rgba(200,168,170,0.12)",
    lineStrong: "rgba(200,168,170,0.22)",
    textPrimary: palette.ink,
    textMuted: palette.inkMuted,
    textFaint: palette.inkFaint,
    accent: palette.wine,
    accentDeep: palette.wineDeep,
    accentTint: palette.wineTint,
    accentWash: "rgba(194,91,84,0.10)",
    onAccent: palette.white,
    positive: palette.sage,
    neutralFill: palette.neutralFill,
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const radius = { sm: 8, md: 14, lg: 22, pill: 999 } as const;

// System font for now (only SpaceMono is bundled). One knob so a custom face is a one-line swap.
export const font = {
    family: undefined as string | undefined,
} as const;

// Type scale. Values are structurally compatible with RN's TextStyle when consumed, but we
// keep this module RN-free, so consumers (the Text primitive) apply them.
export const typography = {
    display: { fontSize: 30, fontWeight: "800", lineHeight: 34 },
    screenTitle: { fontSize: 26, fontWeight: "800", lineHeight: 30 },
    title: { fontSize: 20, fontWeight: "800", lineHeight: 24 },
    section: { fontSize: 15, fontWeight: "700", lineHeight: 20 },
    body: { fontSize: 14, fontWeight: "500", lineHeight: 20 },
    bodyStrong: { fontSize: 14, fontWeight: "700", lineHeight: 20 },
    label: { fontSize: 13, fontWeight: "600", lineHeight: 17 },
    caption: { fontSize: 11, fontWeight: "500", lineHeight: 15 },
    micro: { fontSize: 10.5, fontWeight: "600", lineHeight: 14, letterSpacing: 1.4, textTransform: "uppercase" },
} as const;

// Elevation. Plain data (RN shadow props + Android elevation); applied by primitives.
export const shadow = {
    card: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
    art: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 18 }, elevation: 12 },
    modal: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 40, shadowOffset: { width: 0, height: 24 }, elevation: 16 },
} as const;

export const theme = { color, space, radius, typography, shadow, font, palette } as const;

export type Theme = typeof theme;
export type TypographyVariant = keyof typeof typography;
export type ColorToken = keyof typeof color;
