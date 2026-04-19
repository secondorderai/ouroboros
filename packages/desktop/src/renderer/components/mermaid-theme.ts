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

export function getMermaidPalette(theme: 'light' | 'dark'): PaletteEntry[] {
  return theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
}

export function getMermaidPaletteEntry(theme: 'light' | 'dark', index: number): PaletteEntry {
  const palette = getMermaidPalette(theme)
  return palette[((index % palette.length) + palette.length) % palette.length]
}

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
  const palette = getMermaidPalette(theme)
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
    sequenceNumberColor: tokens.textSecondary,
    loopTextColor: tokens.textPrimary,
    sectionBkgColor: primary.fill,
    altSectionBkgColor: secondary.fill,
    sectionBkgColor2: tertiary.fill,
    excludeBkgColor: tokens.bgSecondary,
    taskBorderColor: primary.border,
    taskBkgColor: primary.fill,
    activeTaskBorderColor: secondary.border,
    activeTaskBkgColor: secondary.fill,
    doneTaskBorderColor: palette[7].border,
    doneTaskBkgColor: palette[7].fill,
    critBorderColor: palette[5].border,
    critBkgColor: palette[5].fill,
    gridColor: tokens.borderLight,
    todayLineColor: palette[5].border,
    vertLineColor: tokens.borderLight,
    taskTextColor: tokens.textPrimary,
    taskTextOutsideColor: tokens.textSecondary,
    taskTextLightColor: tokens.textPrimary,
    taskTextDarkColor: tokens.textPrimary,
    taskTextClickableColor: tokens.accentPrimary,
    personBorder: secondary.border,
    personBkg: secondary.fill,
    rowOdd: tokens.bgChat,
    rowEven: tokens.bgSecondary,
    transitionColor: tokens.borderMedium,
    transitionLabelColor: tokens.textPrimary,
    stateLabelColor: tokens.textPrimary,
    stateBkg: primary.fill,
    labelBackgroundColor: tokens.bgChat,
    compositeBackground: secondary.fill,
    compositeTitleBackground: tertiary.fill,
    compositeBorder: secondary.border,
    altBackground: tokens.bgSecondary,
    specialStateColor: palette[4].border,
    classText: tokens.textPrimary,
    archEdgeColor: tokens.borderMedium,
    archEdgeArrowColor: tokens.borderMedium,
    archEdgeWidth: '1.8',
    archGroupBorderColor: tokens.borderMedium,
    archGroupBorderWidth: '1.4',
    quadrant1Fill: palette[0].fill,
    quadrant2Fill: palette[1].fill,
    quadrant3Fill: palette[2].fill,
    quadrant4Fill: palette[4].fill,
    quadrant1TextFill: palette[0].label,
    quadrant2TextFill: palette[1].label,
    quadrant3TextFill: palette[2].label,
    quadrant4TextFill: palette[4].label,
    quadrantPointFill: tokens.accentPrimary,
    quadrantPointTextFill: tokens.textPrimary,
    quadrantXAxisTextFill: tokens.textSecondary,
    quadrantYAxisTextFill: tokens.textSecondary,
    quadrantInternalBorderStrokeFill: tokens.borderLight,
    quadrantExternalBorderStrokeFill: tokens.borderMedium,
    quadrantTitleFill: tokens.textPrimary,
    requirementBackground: primary.fill,
    requirementBorderColor: primary.border,
    requirementBorderSize: '1.4',
    requirementTextColor: primary.label,
    relationColor: tokens.borderMedium,
    relationLabelBackground: tokens.bgChat,
    relationLabelColor: tokens.textPrimary,
    branchLabelColor: tokens.textPrimary,
    tagLabelColor: tokens.textPrimary,
    tagLabelBackground: secondary.fill,
    tagLabelBorder: secondary.border,
    commitLabelColor: tokens.textPrimary,
    commitLabelBackground: tokens.bgChat,
  }

  palette.forEach((entry, index) => {
    vars[`cScale${index}`] = entry.fill
    vars[`cScalePeer${index}`] = entry.border
    vars[`cScaleLabel${index}`] = entry.label
    vars[`fillType${index}`] = entry.fill
    vars[`git${index}`] = entry.border
    vars[`gitInv${index}`] = entry.label
    vars[`gitBranchLabel${index}`] = entry.label
  })

  for (let index = 1; index <= 12; index++) {
    const entry = palette[(index - 1) % palette.length]
    vars[`pie${index}`] = entry.border
  }

  for (let index = 1; index <= 8; index++) {
    vars[`venn${index}`] = palette[(index - 1) % palette.length].fill
  }

  vars.pieTitleTextColor = tokens.textPrimary
  vars.pieSectionTextColor = tokens.textPrimary
  vars.pieLegendTextColor = tokens.textSecondary
  vars.pieStrokeColor = tokens.bgChat
  vars.pieStrokeWidth = '2px'
  vars.pieOuterStrokeWidth = '1px'
  vars.pieOuterStrokeColor = tokens.borderMedium
  vars.vennTitleTextColor = tokens.textPrimary
  vars.vennSetTextColor = tokens.textPrimary

  return vars
}
