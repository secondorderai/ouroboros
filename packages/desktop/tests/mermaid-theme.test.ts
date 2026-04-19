import { describe, expect, test } from 'bun:test'
import {
  buildMermaidThemeVariables,
  DARK_FALLBACK_TOKENS,
  DARK_PALETTE,
  getMermaidPaletteEntry,
  LIGHT_FALLBACK_TOKENS,
  LIGHT_PALETTE,
} from '../src/renderer/components/mermaid-theme'
import {
  detectMermaidDiagramType,
  enhanceMermaidSvg,
  hasAuthorMermaidStyling,
} from '../src/renderer/components/mermaid-enhancer'

describe('buildMermaidThemeVariables', () => {
  test('emits a restrained full palette as cScale entries for light theme', () => {
    const vars = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    const fills = new Set<string>()
    LIGHT_PALETTE.forEach((entry, index) => {
      expect(vars[`cScale${index}`]).toBe(entry.fill)
      expect(vars[`cScalePeer${index}`]).toBe(entry.border)
      expect(vars[`cScaleLabel${index}`]).toBe(entry.label)
      fills.add(entry.fill)
      expect(isRestrainedLightColor(entry.fill)).toBe(true)
      expect(isRestrainedLightColor(entry.border)).toBe(true)
    })
    expect(fills.size).toBe(LIGHT_PALETTE.length)
  })

  test('emits a restrained full palette as cScale entries for dark theme', () => {
    const vars = buildMermaidThemeVariables('dark', DARK_FALLBACK_TOKENS)
    const fills = new Set<string>()
    DARK_PALETTE.forEach((entry, index) => {
      expect(vars[`cScale${index}`]).toBe(entry.fill)
      expect(vars[`cScalePeer${index}`]).toBe(entry.border)
      fills.add(entry.fill)
      expect(isRestrainedDarkColor(entry.fill)).toBe(true)
      expect(isRestrainedDarkColor(entry.border)).toBe(true)
    })
    expect(fills.size).toBe(DARK_PALETTE.length)
  })

  test('light and dark themes produce different palettes', () => {
    const light = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    const dark = buildMermaidThemeVariables('dark', DARK_FALLBACK_TOKENS)
    expect(light.primaryColor).not.toBe(dark.primaryColor)
    expect(light.textColor).not.toBe(dark.textColor)
    expect(light.cScale3).not.toBe(dark.cScale3)
  })

  test('wires design-system chrome tokens into diagram chrome', () => {
    const vars = buildMermaidThemeVariables('light', {
      ...LIGHT_FALLBACK_TOKENS,
      textPrimary: '#111111',
      borderMedium: '#222222',
      bgChat: '#FAFAFA',
    })
    expect(vars.textColor).toBe('#111111')
    expect(vars.titleColor).toBe('#111111')
    expect(vars.lineColor).toBe('#222222')
    expect(vars.clusterBorder).toBe('#222222')
    expect(vars.edgeLabelBackground).toBe('#FAFAFA')
    expect(vars.clusterBkg).toBe('#FAFAFA')
  })

  test('uses stable text tokens instead of per-node saturated label colors', () => {
    const vars = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    expect(vars.textColor).toBe(LIGHT_FALLBACK_TOKENS.textPrimary)
    expect(vars.titleColor).toBe(LIGHT_FALLBACK_TOKENS.textPrimary)
    expect(vars.actorTextColor).toBe(LIGHT_FALLBACK_TOKENS.textPrimary)
    expect(vars.signalTextColor).toBe(LIGHT_FALLBACK_TOKENS.textPrimary)
    expect(vars.pieLegendTextColor).toBe(LIGHT_FALLBACK_TOKENS.textSecondary)
  })

  test('uses Inter-first font stack at 14px for readability', () => {
    const vars = buildMermaidThemeVariables('light')
    expect(vars.fontFamily.startsWith("'Inter'")).toBe(true)
    expect(vars.fontSize).toBe('14px')
  })

  test('populates sequence diagram tokens', () => {
    const vars = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    expect(vars.actorBkg).toBeDefined()
    expect(vars.actorBorder).toBeDefined()
    expect(vars.signalColor).toBeDefined()
    expect(vars.noteBkgColor).toBeDefined()
    expect(vars.activationBkgColor).toBeDefined()
  })

  test('populates common non-flowchart diagram tokens', () => {
    const vars = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    expect(vars.pie1).toBe(LIGHT_PALETTE[0].border)
    expect(vars.pie8).toBe(LIGHT_PALETTE[7].border)
    expect(vars.pieTitleTextSize).toBe('15px')
    expect(vars.pieSectionTextSize).toBe('12px')
    expect(vars.pieLegendTextSize).toBe('12px')
    expect(vars.pieStrokeWidth).toBe('1px')
    expect(vars.sectionBkgColor).toBe(LIGHT_PALETTE[0].fill)
    expect(vars.stateBkg).toBe(LIGHT_PALETTE[0].fill)
    expect(vars.classText).toBe(LIGHT_FALLBACK_TOKENS.textPrimary)
    expect(vars.git0).toBe(LIGHT_PALETTE[0].border)
    expect(vars.gitBranchLabel7).toBe(LIGHT_PALETTE[7].label)
    expect(vars.tagLabelFontSize).toBe('12px')
    expect(vars.commitLabelFontSize).toBe('12px')
  })

  test('palette accessor wraps indexes and follows theme', () => {
    expect(getMermaidPaletteEntry('light', 0)).toEqual(LIGHT_PALETTE[0])
    expect(getMermaidPaletteEntry('light', LIGHT_PALETTE.length)).toEqual(LIGHT_PALETTE[0])
    expect(getMermaidPaletteEntry('dark', 1)).toEqual(DARK_PALETTE[1])
  })
})

function isRestrainedLightColor(color: string): boolean {
  return /^#(?:[0-9A-F]{6})$/i.test(color) && !/(?:EA580C|F59E0B|EF4444|D946EF|7C3AED|10B981|0EA5A4|0891B2)/i.test(color)
}

function isRestrainedDarkColor(color: string): boolean {
  return /^#(?:[0-9A-F]{6})$/i.test(color) && !/(?:FCD34D|FCA5A5|F0ABFC|C4B5FD|6EE7B7|5EEAD4|67E8F9)/i.test(color)
}

describe('mermaid svg enhancement helpers', () => {
  test('detects common mermaid diagram families from source', () => {
    expect(detectMermaidDiagramType('graph TD\nA --> B')).toBe('flowchart')
    expect(detectMermaidDiagramType('sequenceDiagram\nA->>B: hello')).toBe('sequence')
    expect(detectMermaidDiagramType('stateDiagram-v2\n[*] --> Ready')).toBe('state')
    expect(detectMermaidDiagramType('classDiagram\nclass User')).toBe('class')
    expect(detectMermaidDiagramType('erDiagram\nUSER ||--o{ ORDER : places')).toBe('er')
    expect(detectMermaidDiagramType('gantt\ndateFormat YYYY-MM-DD')).toBe('gantt')
    expect(detectMermaidDiagramType('mindmap\n  root')).toBe('mindmap')
    expect(detectMermaidDiagramType('pie title Share')).toBe('chart')
    expect(detectMermaidDiagramType('not mermaid')).toBe('unknown')
  })

  test('detects author-provided mermaid styling that should not be overwritten', () => {
    expect(hasAuthorMermaidStyling('graph TD\nclassDef hot fill:#f00\nA:::hot')).toBe(true)
    expect(hasAuthorMermaidStyling('graph TD\nstyle A fill:#f00')).toBe(true)
    expect(hasAuthorMermaidStyling('graph TD\nA --> B')).toBe(false)
  })

  test('fails open without browser svg parser globals', () => {
    const svg = '<svg><g class="node"><rect x="0" y="0" width="10" height="10"/></g></svg>'
    expect(enhanceMermaidSvg(svg, 'graph TD\nA --> B', 'light')).toBe(svg)
  })
})
