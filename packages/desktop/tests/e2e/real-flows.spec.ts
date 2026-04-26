import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { LaunchedApp, LaunchScenario } from './helpers'
import { completeOnboarding, launchTestApp } from './helpers'

let launched: LaunchedApp | null = null
const modKey = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

const baseScenario: LaunchScenario = {
  skills: [
    { name: 'core/fs', description: 'Filesystem navigation', version: '1.0.0', enabled: true },
    {
      name: 'generated/review',
      description: 'Generated review helper',
      version: '0.1.0',
      enabled: false,
    },
  ],
  evolutionEntries: [
    {
      id: 'evo-1',
      timestamp: new Date().toISOString(),
      type: 'reflection',
      description: 'Summarized a repository structure',
      sessionId: 'session-reflection',
      details: {
        summary: 'Summarized a repository structure',
        filesInPlay: ['packages/desktop/src/renderer/components/RSIDrawer.tsx'],
      },
    },
  ],
  evolutionStats: {
    sessionsAnalyzed: 12,
    successRate: 0.84,
  },
  rsiHistoryEntries: [
    {
      sessionId: 'session-reflection',
      updatedAt: new Date().toISOString(),
      goal: 'Improve the Self-Improvement drawer',
      nextBestStep: 'Add checkpoint detail browsing',
      openLoopCount: 2,
      durableCandidateCount: 1,
      skillCandidateCount: 1,
    },
  ],
  rsiCheckpoints: {
    'session-reflection': {
      sessionId: 'session-reflection',
      updatedAt: new Date().toISOString(),
      goal: 'Improve the Self-Improvement drawer',
      currentPlan: ['Add tabs', 'Support history drill-down'],
      constraints: ['Match the design system'],
      decisionsMade: ['Keep the browser in the drawer'],
      filesInPlay: ['packages/desktop/src/renderer/components/RSIDrawer.tsx'],
      completedWork: ['Defined the browser layout'],
      openLoops: ['Wire checkpoint detail', 'Add tests'],
      nextBestStep: 'Add checkpoint detail browsing',
      durableMemoryCandidates: [
        {
          title: 'Keep reflection UI in the drawer',
          summary: 'Users prefer the existing drawer entry point.',
          content: 'Keep reflection UI in the drawer.',
          kind: 'preference',
          confidence: 0.81,
          observedAt: new Date().toISOString(),
          tags: ['preference'],
          evidence: ['User requested drawer browser'],
        },
      ],
      skillCandidates: [
        {
          name: 'rsi-drawer-browser',
          summary: 'Build RSI history browsers in existing app shells.',
          trigger: 'When RSI history needs a richer UI.',
          workflow: ['Add protocol', 'Render timeline', 'Render detail pane'],
          confidence: 0.72,
          sourceObservationIds: ['obs-1'],
          sourceSessionIds: ['session-reflection'],
        },
      ],
    },
  },
}

test('happy-path onboarding, chat streaming, dialogs, and updater use the production path', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      ...baseScenario,
      agentRuns: [
        {
          response: {
            text: 'Repository summary ready.',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            {
              delayMs: 50,
              method: 'agent/toolCallStart',
              params: {
                toolCallId: 'tool-1',
                toolName: 'web-search',
                input: { query: 'ouroboros' },
              },
            },
            { delayMs: 90, method: 'agent/text', params: { text: 'Inspecting the repository…' } },
            {
              delayMs: 130,
              method: 'agent/toolCallEnd',
              params: {
                toolCallId: 'tool-1',
                toolName: 'web-search',
                result: { ok: true },
                isError: false,
              },
            },
            // Wide gap before turnComplete so the intermediate streaming
            // text stays on screen long enough for Playwright's poll
            // interval to observe it on slower Linux CI runners.
            {
              delayMs: 1500,
              method: 'agent/turnComplete',
              params: { text: 'Repository summary ready.', iterations: 1 },
            },
          ],
        },
      ],
    },
    dialogResponses: [
      '/tmp/ouroboros-workspace',
      ['/tmp/spec.md', '/tmp/spec.md', '/tmp/notes.txt'],
      '/tmp/next-workspace',
    ],
    updateDownloadedVersion: '9.9.9',
    updateDownloadedDelayMs: 2_500,
  })

  await completeOnboarding(launched.page, {
    workspace: '/tmp/ouroboros-workspace',
    templateName: 'Help me with a project',
  })

  await expect(launched.page.getByLabel('Message input')).toBeVisible()
  await expect(launched.page.getByText('/tmp/ouroboros-workspace')).toBeVisible()

  await launched.page.getByLabel('Message input').fill('Summarize the repo')
  // Wait for React to enable Send so the Enter keydown hits the handler
  // bound to the latest text — slow CI runners drop the send otherwise.
  await expect(launched.page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Inspecting the repository…')).toBeVisible()
  await expect(launched.page.getByText('Repository summary ready.')).toBeVisible()
  await expect(launched.page.getByText('Searched web')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Attach files' }).click()
  await expect(launched.page.getByRole('button', { name: 'Remove spec.md' })).toHaveCount(1)
  await expect(launched.page.getByRole('button', { name: 'Remove notes.txt' })).toHaveCount(1)

  await launched.page.getByRole('button', { name: 'Change workspace' }).click()
  await expect(launched.page.getByText('/tmp/next-workspace')).toBeVisible()

  await expect(launched.page.getByRole('alert')).toContainText(
    'Update available (v9.9.9). Restart to apply.',
  )
  await launched.page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(launched.page.getByRole('alert')).not.toBeVisible()
})

test('cancel flow preserves partial text and lets the user recover', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      ...baseScenario,
      agentRuns: [
        {
          response: {
            text: 'Cancelled run',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 60, method: 'agent/text', params: { text: 'Gathering context' } },
            // Wide enough that the test reliably observes "Gathering context"
            // and clicks "Stop agent" before this would have fired.
            {
              delayMs: 5000,
              method: 'agent/turnComplete',
              params: { text: 'Should not reach completion', iterations: 1 },
            },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)
  await launched.page.getByLabel('Message input').fill('Run a long task')
  await expect(launched.page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Gathering context')).toBeVisible()
  await launched.page.getByRole('button', { name: 'Stop agent' }).click()

  await expect(launched.page.getByText('Gathering context')).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(launched.page.getByText('Should not reach completion')).not.toBeVisible()
})

test('sessions, command palette, approvals queue, and RSI drawer all work through the mock CLI transport', async ({}, testInfo) => {
  const historicalTimestamp = new Date(Date.now() - 60_000).toISOString()
  launched = await launchTestApp(testInfo, {
    scenario: {
      ...baseScenario,
      approvals: [
        {
          id: 'approval-42',
          type: 'self-modification',
          description: 'Approve a generated patch',
          createdAt: new Date().toISOString(),
          risk: 'medium',
        },
      ],
      sessions: [
        {
          id: 'session-existing',
          createdAt: historicalTimestamp,
          lastActive: historicalTimestamp,
          title: 'Existing conversation',
          messages: [
            { role: 'user', content: 'Earlier prompt', timestamp: historicalTimestamp },
            { role: 'assistant', content: 'Earlier response', timestamp: historicalTimestamp },
          ],
        },
      ],
      agentRuns: [
        {
          response: {
            text: 'Fresh session complete',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 50, method: 'agent/text', params: { text: 'Fresh session complete' } },
            {
              delayMs: 90,
              method: 'agent/turnComplete',
              params: { text: 'Fresh session complete', iterations: 1 },
            },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)

  await expect(launched.page.getByText('Existing conversation')).toBeVisible()

  await launched.page.getByRole('button', { name: 'New conversation' }).click()
  await launched.page.getByLabel('Message input').fill('Create a titled session')
  await launched.page.getByLabel('Message input').press('Enter')
  await expect(launched.page.getByText('Fresh session complete')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Create a titled session')).toBeVisible()
  await expect(launched.page.getByText('Existing conversation')).toBeVisible()

  await launched.page.getByLabel('Session: Existing conversation').click()
  await expect(launched.page.getByText('Earlier response')).toBeVisible()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)
  await expect(launched.page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await launched.page.getByPlaceholder('Search actions...').fill('approval')
  await launched.page.keyboard.press('Enter')
  await expect(launched.page.getByText('Pending Approvals')).toBeVisible()
  await expect(launched.page.getByText('Approve a generated patch').first()).toBeVisible()
  await launched.page.getByRole('button', { name: 'Approve' }).last().click()
  await expect(launched.page.getByText('No pending approvals')).toBeVisible()

  await launched.page.getByLabel('Close approval queue').click()
  await launched.page.getByLabel(/^RSI status:/).click()
  await expect(launched.page.getByRole('dialog', { name: 'Self-Improvement drawer' })).toBeVisible()
  await expect(launched.page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(launched.page.getByText('Recent Activity')).toBeVisible()
  await expect(launched.page.getByRole('tab', { name: 'History' })).toBeVisible()
  await launched.page.getByRole('tab', { name: 'Skills' }).click()
  await expect(launched.page.getByText('core/fs')).toBeVisible()
  await launched.page.getByRole('tab', { name: 'Overview' }).click()
  await launched.page.getByRole('button', { name: 'Run dream cycle' }).click()
  await expect(launched.page.getByText(/Dream cycle completed/i)).toBeVisible()
  await launched.page.getByLabel('Close drawer').click()
})

test('settings, RSI, and external-link safety remain observable without renderer-only shortcuts', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: baseScenario,
  })

  await completeOnboarding(launched.page)

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)
  await expect(launched.page.getByRole('button', { name: 'Close settings' })).toBeVisible()
  await launched.page.getByRole('button', { name: 'Appearance' }).click()
  await launched.page.getByRole('button', { name: 'Dark' }).click()
  await expect
    .poll(async () => {
      return launched!.page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    })
    .toBe('dark')
  await launched.page.getByLabel('Close settings').click()

  await launched.page.evaluate(() => {
    window.electronAPI.openExternal('https://example.com/docs')
    window.electronAPI.openExternal('javascript:alert(1)')
  })

  await expect
    .poll(async () => {
      const contents = await readFile(launched!.paths.externalUrlLogPath, 'utf8')
      const records = contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { allowed: boolean })
      return {
        total: records.length,
        allowed: records.filter((record) => record.allowed).length,
        blocked: records.filter((record) => !record.allowed).length,
      }
    })
    .toEqual({ total: 2, allowed: 1, blocked: 1 })
})

test('desktop surfaces RSI compaction activity and preserves long-session continuity', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      ...baseScenario,
      evolutionEntries: [
        ...baseScenario.evolutionEntries,
        {
          id: 'evo-compact',
          timestamp: new Date().toISOString(),
          type: 'history-compacted',
          description: 'Rebuilt the prompt from checkpoint memory and a short live tail.',
        },
      ],
      agentRuns: [
        {
          response: {
            text: 'Recovered context and continued the task.',
            iterations: 2,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            {
              delayMs: 40,
              method: 'agent/text',
              params: { text: 'Working through a long session…' },
            },
            {
              delayMs: 80,
              method: 'rsi/runtime',
              params: {
                eventType: 'rsi-observation-recorded',
                payload: { count: 3, summary: 'Captured recent tool results before compaction.' },
              },
            },
            {
              delayMs: 120,
              method: 'rsi/runtime',
              params: {
                eventType: 'rsi-checkpoint-written',
                payload: { checkpointUpdatedAt: '2026-04-17T10:15:00.000Z' },
              },
            },
            {
              delayMs: 160,
              method: 'rsi/runtime',
              params: {
                eventType: 'rsi-history-compacted',
                payload: {
                  summary: 'Replaced older history with checkpoint memory and a short tail.',
                },
              },
            },
            {
              delayMs: 200,
              method: 'rsi/runtime',
              params: {
                eventType: 'rsi-length-recovery-succeeded',
                payload: { summary: 'Retried with compacted context and resumed the task.' },
              },
            },
            // Wide gaps so Playwright observes the intermediate streaming
            // text on slow Linux CI before it's replaced by turnComplete.
            {
              delayMs: 1500,
              method: 'agent/text',
              params: { text: 'Recovered context and continued the task.' },
            },
            {
              delayMs: 2500,
              method: 'agent/turnComplete',
              params: { text: 'Recovered context and continued the task.', iterations: 2 },
            },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)

  await launched.page
    .getByLabel('Message input')
    .fill('Keep going even if the context gets compacted')
  await expect(launched.page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Working through a long session…')).toBeVisible()
  await expect(launched.page.getByText('Recovered context and continued the task.')).toBeVisible()

  await launched.page.getByLabel(/^RSI status:/).click()
  await expect(launched.page.getByRole('dialog', { name: 'Self-Improvement drawer' })).toBeVisible()
  await launched.page.getByRole('tab', { name: 'History' }).click()
  const historyBrowser = launched.page.getByRole('dialog', { name: 'Self-Improvement drawer' })
  await expect(historyBrowser).toContainText(
    'Observed session activity -- Captured recent tool results before compaction.',
  )
  await expect(historyBrowser).toContainText('Checkpoint saved -- 2026-04-17T10:15:00.000Z')
  await expect(historyBrowser).toContainText(
    'Compacted long session -- Replaced older history with checkpoint memory and a short tail.',
  )
  await expect(historyBrowser).toContainText(
    'Recovered after context limit -- Retried with compacted context and resumed the task.',
  )
})

test('history tab filters entries and shows checkpoint drill-down', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: baseScenario,
  })

  await completeOnboarding(launched.page)
  await launched.page.getByLabel(/^RSI status:/).click()
  await expect(launched.page.getByRole('dialog', { name: 'Self-Improvement drawer' })).toBeVisible()

  await launched.page.getByRole('tab', { name: 'History' }).click()
  await expect(
    launched.page.getByRole('button', { name: /Checkpoint.*Improve the Self-Improvement drawer/i }),
  ).toBeVisible()
  await launched.page.getByRole('button', { name: 'Reflections', exact: true }).click()
  await launched.page
    .getByRole('button', { name: /Checkpoint.*Improve the Self-Improvement drawer/i })
    .click()
  await expect(launched.page.locator('li').filter({ hasText: 'Add tabs' })).toBeVisible()
  await expect(
    launched.page.locator('li').filter({ hasText: 'Support history drill-down' }),
  ).toBeVisible()
  await expect(
    launched.page.locator('p').filter({ hasText: 'Add checkpoint detail browsing' }).first(),
  ).toBeVisible()

  await launched.page.getByRole('button', { name: 'All', exact: true }).click()
  await launched.page
    .getByRole('button', {
      name: /Reflection.*Reflected on task -- Summarized a repository structure/i,
    })
    .click()
  await expect(launched.page.getByText('filesInPlay')).toBeVisible()
})
