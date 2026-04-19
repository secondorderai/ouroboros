import { expect, test } from '@playwright/test'
import type { LaunchedApp } from './helpers'
import { completeOnboarding, launchTestApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('mermaid diagrams receive theme-aware semantic color enhancements', async ({}, testInfo) => {
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

  const colorSummary = await launched.page.evaluate(() => {
    const meaningfulFill = (value: string) =>
      value &&
      value !== 'none' &&
      value !== 'transparent' &&
      value !== 'rgba(0, 0, 0, 0)' &&
      value !== 'rgb(255, 255, 255)'

    return [...document.querySelectorAll<SVGSVGElement>('.mermaid-diagram__svg-shell svg')].map(
      (svg) => {
        const fills = new Set<string>()
        svg.querySelectorAll<SVGElement>('rect, path, polygon, circle, ellipse').forEach((shape) => {
          const fill = getComputedStyle(shape).fill
          if (meaningfulFill(fill)) fills.add(fill)
        })
        return {
          type: svg.getAttribute('data-ou-diagram-type'),
          fills: [...fills],
        }
      },
    )
  })

  const flowchart = colorSummary.find((item) => item.type === 'flowchart')
  const sequence = colorSummary.find((item) => item.type === 'sequence')
  const er = colorSummary.find((item) => item.type === 'er')
  const gantt = colorSummary.find((item) => item.type === 'gantt')

  expect(flowchart?.fills.length).toBeGreaterThanOrEqual(2)
  expect(sequence?.fills.length).toBeGreaterThanOrEqual(2)
  expect(er?.fills.length).toBeGreaterThanOrEqual(2)
  expect(gantt?.fills.length).toBeGreaterThanOrEqual(2)

  await launched.page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect
    .poll(() => launched!.page.evaluate(() => document.documentElement.getAttribute('data-theme')))
    .toBe('dark')

  const darkDiagram = launched.page.locator(
    '.mermaid-diagram__svg-shell svg[data-ou-enhanced="true"][data-ou-diagram-type="sequence"]',
  )
  await expect(darkDiagram).toBeVisible({ timeout: 20_000 })

  await launched.page.getByRole('button', { name: 'Open full-size diagram' }).first().click()
  await expect(launched.page.getByRole('dialog', { name: 'Expanded Mermaid diagram' })).toBeVisible()
})
