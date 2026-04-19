import { describe, expect, test } from 'bun:test'
import {
  buildMermaidThemeVariables,
  DARK_FALLBACK_TOKENS,
  DARK_PALETTE,
  LIGHT_FALLBACK_TOKENS,
  LIGHT_PALETTE,
} from '../src/renderer/components/mermaid-theme'

describe('buildMermaidThemeVariables', () => {
  test('emits the full palette as distinct cScale entries for light theme', () => {
    const vars = buildMermaidThemeVariables('light', LIGHT_FALLBACK_TOKENS)
    const fills = new Set<string>()
    LIGHT_PALETTE.forEach((entry, index) => {
      expect(vars[`cScale${index}`]).toBe(entry.fill)
      expect(vars[`cScalePeer${index}`]).toBe(entry.border)
      expect(vars[`cScaleLabel${index}`]).toBe(entry.label)
      fills.add(entry.fill)
    })
    // Regression guard for the "all subgraphs the same muted gray" bug.
    expect(fills.size).toBe(LIGHT_PALETTE.length)
  })

  test('emits the full palette as distinct cScale entries for dark theme', () => {
    const vars = buildMermaidThemeVariables('dark', DARK_FALLBACK_TOKENS)
    const fills = new Set<string>()
    DARK_PALETTE.forEach((entry, index) => {
      expect(vars[`cScale${index}`]).toBe(entry.fill)
      fills.add(entry.fill)
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
})
