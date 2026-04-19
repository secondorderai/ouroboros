// Vivid editorial palette — 8 hues that cycle across subgraphs & node classes.
// Saturation/luminance calibrated per theme so labels stay readable on top of
// the tinted fills. Extracted from MermaidRenderer so it can be unit-tested
// without pulling in the mermaid package.

export interface PaletteEntry {
  fill: string
  border: string
  label: string
}

export const LIGHT_PALETTE: PaletteEntry[] = [
  { fill: 'rgba(62, 95, 138, 0.14)', border: '#3E5F8A', label: '#1E2E44' },
  { fill: 'rgba(14, 165, 164, 0.14)', border: '#0EA5A4', label: '#0B5E5D' },
  { fill: 'rgba(124, 58, 237, 0.14)', border: '#7C3AED', label: '#3F1D7C' },
  { fill: 'rgba(217, 70, 239, 0.14)', border: '#D946EF', label: '#7A1E87' },
  { fill: 'rgba(245, 158, 11, 0.18)', border: '#F59E0B', label: '#7C4A05' },
  { fill: 'rgba(239, 68, 68, 0.14)', border: '#EF4444', label: '#7F1D1D' },
  { fill: 'rgba(8, 145, 178, 0.14)', border: '#0891B2', label: '#0A4F63' },
  { fill: 'rgba(16, 185, 129, 0.14)', border: '#10B981', label: '#0A5A40' },
]

export const DARK_PALETTE: PaletteEntry[] = [
  { fill: 'rgba(137, 167, 209, 0.22)', border: '#89A7D1', label: '#E6EEF9' },
  { fill: 'rgba(94, 234, 212, 0.22)', border: '#5EEAD4', label: '#E0FBF6' },
  { fill: 'rgba(196, 181, 253, 0.22)', border: '#C4B5FD', label: '#F1EDFE' },
  { fill: 'rgba(240, 171, 252, 0.22)', border: '#F0ABFC', label: '#FBEAFF' },
  { fill: 'rgba(252, 211, 77, 0.24)', border: '#FCD34D', label: '#FEF3C8' },
  { fill: 'rgba(252, 165, 165, 0.24)', border: '#FCA5A5', label: '#FEE4E4' },
  { fill: 'rgba(103, 232, 249, 0.22)', border: '#67E8F9', label: '#E0F8FC' },
  { fill: 'rgba(110, 231, 183, 0.22)', border: '#6EE7B7', label: '#DFF7EB' },
]

export interface MermaidChromeTokens {
  textPrimary: string
  textSecondary: string
  bgChat: string
  bgSecondary: string
  borderLight: string
  borderMedium: string
  accentPrimary: string
}

export const LIGHT_FALLBACK_TOKENS: MermaidChromeTokens = {
  textPrimary: '#0E1116',
  textSecondary: '#5E6673',
  bgChat: '#FFFFFF',
  bgSecondary: '#ECEEF0',
  borderLight: '#DCE1E7',
  borderMedium: '#C9D1DB',
  accentPrimary: '#3E5F8A',
}

export const DARK_FALLBACK_TOKENS: MermaidChromeTokens = {
  textPrimary: '#EEF2F6',
  textSecondary: '#97A1AD',
  bgChat: '#0F1317',
  bgSecondary: '#12161B',
  borderLight: '#232A33',
  borderMedium: '#2F3944',
  accentPrimary: '#89A7D1',
}

export const MERMAID_FONT_FAMILY =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
export const MERMAID_FONT_SIZE_PX = '14px'

export function fallbackTokensFor(theme: 'light' | 'dark'): MermaidChromeTokens {
  return theme === 'dark' ? DARK_FALLBACK_TOKENS : LIGHT_FALLBACK_TOKENS
}

export function readChromeTokens(theme: 'light' | 'dark'): MermaidChromeTokens {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return fallbackTokensFor(theme)
  }
  const fallback = fallbackTokensFor(theme)
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fb: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value || fb
  }
  return {
    textPrimary: read('--text-primary', fallback.textPrimary),
    textSecondary: read('--text-secondary', fallback.textSecondary),
    bgChat: read('--bg-chat', fallback.bgChat),
    bgSecondary: read('--bg-secondary', fallback.bgSecondary),
    borderLight: read('--border-light', fallback.borderLight),
    borderMedium: read('--border-medium', fallback.borderMedium),
    accentPrimary: read('--accent-primary', fallback.accentPrimary),
  }
}

export function buildMermaidThemeVariables(
  theme: 'light' | 'dark',
  tokens: MermaidChromeTokens = fallbackTokensFor(theme),
): Record<string, string> {
  const palette = theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
  const primary = palette[0]
  const secondary = palette[1]
  const tertiary = palette[2]

  const vars: Record<string, string> = {
    background: 'transparent',
    mainBkg: primary.fill,
    primaryColor: primary.fill,
    primaryTextColor: primary.label,
    primaryBorderColor: primary.border,
    secondaryColor: secondary.fill,
    secondaryTextColor: secondary.label,
    secondaryBorderColor: secondary.border,
    tertiaryColor: tertiary.fill,
    tertiaryTextColor: tertiary.label,
    tertiaryBorderColor: tertiary.border,
    lineColor: tokens.borderMedium,
    textColor: tokens.textPrimary,
    titleColor: tokens.textPrimary,
    nodeBorder: primary.border,
    edgeLabelBackground: tokens.bgChat,
    clusterBkg: 'transparent',
    clusterBorder: tokens.borderMedium,
    fontFamily: MERMAID_FONT_FAMILY,
    fontSize: MERMAID_FONT_SIZE_PX,
    actorBkg: primary.fill,
    actorBorder: primary.border,
    actorTextColor: tokens.textPrimary,
    actorLineColor: tokens.borderMedium,
    signalColor: tokens.textPrimary,
    signalTextColor: tokens.textPrimary,
    labelBoxBkgColor: tokens.bgSecondary,
    labelBoxBorderColor: tokens.borderMedium,
    labelTextColor: tokens.textPrimary,
    noteBkgColor: secondary.fill,
    noteTextColor: secondary.label,
    noteBorderColor: secondary.border,
    activationBorderColor: tertiary.border,
    activationBkgColor: tertiary.fill,
  }

  palette.forEach((entry, index) => {
    vars[`cScale${index}`] = entry.fill
    vars[`cScalePeer${index}`] = entry.border
    vars[`cScaleLabel${index}`] = entry.label
  })

  return vars
}
