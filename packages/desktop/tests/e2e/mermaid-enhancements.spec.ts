import { expect, test } from '@playwright/test'
import type { LaunchedApp } from './helpers'
import { completeOnboarding, launchTestApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('mermaid diagrams receive professional theme-aware styling', async ({}, testInfo) => {
  const historicalTimestamp = new Date().toISOString()
  const mermaidContent = [
    'Representative diagrams:',
    '',
    '```mermaid',
    'graph TD',
    '  subgraph Shared[Shared Types]',
    '    Protocol[Protocol]',
    '    Contracts[Contracts]',
    '  end',
    '  subgraph Desktop[Desktop App]',
    '    Renderer[React renderer]',
    '    Main[Electron main]',
    '  end',
    '  Protocol --> Renderer',
    '  Renderer --> Main',
    '```',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Desktop',
    '  participant CLI',
    '  User->>Desktop: Send prompt',
    '  Desktop->>CLI: JSON-RPC request',
    '  CLI-->>Desktop: Stream response',
    '```',
    '',
    '```mermaid',
    'erDiagram',
    '  SESSION ||--o{ MESSAGE : contains',
    '  SESSION {',
    '    string id',
    '    string title',
    '  }',
    '  MESSAGE {',
    '    string role',
    '    string content',
    '  }',
    '```',
    '',
    '```mermaid',
    'gantt',
    '  dateFormat YYYY-MM-DD',
    '  section Discovery',
    '  Inspect renderer :a1, 2026-04-19, 1d',
    '  section Build',
    '  Add palette pass :a2, after a1, 1d',
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo, {
    scenario: {
      sessions: [
        {
          id: 'mermaid-enhancements',
          createdAt: historicalTimestamp,
          lastActive: historicalTimestamp,
          title: 'Mermaid enhancements',
          messages: [
            { role: 'user', content: 'Show representative diagrams', timestamp: historicalTimestamp },
            { role: 'assistant', content: mermaidContent, timestamp: historicalTimestamp },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)
  await launched.page.getByLabel('Session: Mermaid enhancements').click()

  const diagrams = launched.page.locator('.mermaid-diagram__svg-shell svg[data-ou-enhanced="true"]')
  await expect(diagrams).toHaveCount(4, { timeout: 20_000 })

  const styleSummary = await launched.page.evaluate(() => {
    const meaningfulColor = (value: string) =>
      value &&
      value !== 'none' &&
      value !== 'transparent' &&
      value !== 'rgba(0, 0, 0, 0)'
    const px = (value: string) => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : 0
    }

    return [...document.querySelectorAll<SVGSVGElement>('.mermaid-diagram__svg-shell svg')].map(
      (svg) => {
        const fills = new Set<string>()
        const strokes = new Set<string>()
        const strokeWidths: number[] = []
        const labelWeights = new Set<string>()
        const labelSizes = new Set<string>()

        svg.querySelectorAll<SVGElement>('rect, path, polygon, circle, ellipse').forEach((shape) => {
          const fill = getComputedStyle(shape).fill
          const stroke = getComputedStyle(shape).stroke
          if (meaningfulColor(fill)) fills.add(fill)
          if (meaningfulColor(stroke)) strokes.add(stroke)
          const width = px(getComputedStyle(shape).strokeWidth)
          if (width > 0) strokeWidths.push(width)
        })
        svg
          .querySelectorAll<SVGElement>('.nodeLabel, .node text, .edgeLabel, .cluster-label')
          .forEach((label) => {
            const styles = getComputedStyle(label)
            labelWeights.add(styles.fontWeight)
            labelSizes.add(styles.fontSize)
          })

        return {
          type: svg.getAttribute('data-ou-diagram-type'),
          fills: [...fills],
          strokes: [...strokes],
          maxStrokeWidth: strokeWidths.length ? Math.max(...strokeWidths) : 0,
          labelWeights: [...labelWeights],
          labelSizes: [...labelSizes],
        }
      },
    )
  })

  const flowchart = styleSummary.find((item) => item.type === 'flowchart')
  const sequence = styleSummary.find((item) => item.type === 'sequence')
  const er = styleSummary.find((item) => item.type === 'er')
  const gantt = styleSummary.find((item) => item.type === 'gantt')

  for (const diagram of [flowchart, sequence, er, gantt]) {
    expect(diagram).toBeDefined()
    expect(diagram!.fills.length).toBeGreaterThanOrEqual(1)
    expect(hasVividLegacyColor([...diagram!.fills, ...diagram!.strokes])).toBe(false)
    expect(diagram!.maxStrokeWidth).toBeLessThanOrEqual(1.5)
  }

  expect(flowchart?.labelWeights).toContain('600')
  expect(flowchart?.labelSizes).toContain('14px')
  expect(flowchart?.labelSizes).toContain('12px')

  await launched.page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect
    .poll(() => launched!.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('dark')

  const darkDiagram = launched.page.locator(
    '.mermaid-diagram__svg-shell svg[data-ou-enhanced="true"][data-ou-diagram-type="sequence"]',
  )
  await expect(darkDiagram).toBeVisible({ timeout: 20_000 })

  const darkSequenceFills = await darkDiagram.evaluate((svg) => {
    const fills = new Set<string>()
    svg.querySelectorAll<SVGElement>('rect, path, polygon, circle, ellipse').forEach((shape) => {
      const fill = getComputedStyle(shape).fill
      if (fill && fill !== 'none' && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)') {
        fills.add(fill)
      }
    })
    return [...fills]
  })
  expect(darkSequenceFills).not.toEqual(sequence?.fills)
  expect(hasVividLegacyColor(darkSequenceFills)).toBe(false)

  await launched.page.getByRole('button', { name: 'Open full-size diagram' }).first().click()
  await expect(launched.page.getByRole('dialog', { name: 'Expanded Mermaid diagram' })).toBeVisible()
})

function hasVividLegacyColor(colors: string[]): boolean {
  const legacyColors = [
    'rgb(14, 165, 164)',
    'rgb(124, 58, 237)',
    'rgb(217, 70, 239)',
    'rgb(245, 158, 11)',
    'rgb(239, 68, 68)',
    'rgb(8, 145, 178)',
    'rgb(16, 185, 129)',
    'rgb(94, 234, 212)',
    'rgb(196, 181, 253)',
    'rgb(240, 171, 252)',
    'rgb(252, 211, 77)',
    'rgb(252, 165, 165)',
    'rgb(103, 232, 249)',
    'rgb(110, 231, 183)',
  ]
  return colors.some((color) => legacyColors.includes(color))
}
