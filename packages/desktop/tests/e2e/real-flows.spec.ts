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
    { name: 'generated/review', description: 'Generated review helper', version: '0.1.0', enabled: false },
  ],
  evolutionEntries: [
    {
      id: 'evo-1',
      timestamp: new Date().toISOString(),
      type: 'reflection',
      description: 'Summarized a repository structure',
    },
  ],
  evolutionStats: {
    sessionsAnalyzed: 12,
    successRate: 0.84,
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
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 50, method: 'agent/toolCallStart', params: { toolCallId: 'tool-1', toolName: 'web-search', input: { query: 'ouroboros' } } },
            { delayMs: 90, method: 'agent/text', params: { text: 'Inspecting the repository…' } },
            { delayMs: 130, method: 'agent/toolCallEnd', params: { toolCallId: 'tool-1', toolName: 'web-search', result: { ok: true }, isError: false } },
            { delayMs: 170, method: 'agent/turnComplete', params: { text: 'Repository summary ready.', iterations: 1 } },
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
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Inspecting the repository…')).toBeVisible()
  await expect(launched.page.getByText('Repository summary ready.')).toBeVisible()
  await expect(launched.page.getByText('Searched web')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Attach files' }).click()
  await expect(launched.page.getByRole('button', { name: 'Remove spec.md' })).toHaveCount(1)
  await expect(launched.page.getByRole('button', { name: 'Remove notes.txt' })).toHaveCount(1)

  await launched.page.getByRole('button', { name: 'Change workspace' }).click()
  await expect(launched.page.getByText('/tmp/next-workspace')).toBeVisible()

  await expect(launched.page.getByRole('alert')).toContainText('Update available (v9.9.9). Restart to apply.')
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
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 60, method: 'agent/text', params: { text: 'Gathering context' } },
            { delayMs: 1200, method: 'agent/turnComplete', params: { text: 'Should not reach completion', iterations: 1 } },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)
  await launched.page.getByLabel('Message input').fill('Run a long task')
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
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 50, method: 'agent/text', params: { text: 'Fresh session complete' } },
            { delayMs: 90, method: 'agent/turnComplete', params: { text: 'Fresh session complete', iterations: 1 } },
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
    const init = currentModKey === 'metaKey'
      ? { key: 'k', metaKey: true }
      : { key: 'k', ctrlKey: true }
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
  await expect(launched.page.getByText('Recent Activity')).toBeVisible()
  await expect(launched.page.getByText('core/fs')).toBeVisible()
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
    const init = currentModKey === 'metaKey'
      ? { key: ',', metaKey: true }
      : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)
  await expect(launched.page.getByText('Settings')).toBeVisible()
  await launched.page.getByRole('button', { name: 'Appearance' }).click()
  await launched.page.getByRole('button', { name: 'Dark' }).click()
  await expect.poll(async () => {
    return launched!.page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  }).toBe('dark')
  await launched.page.getByLabel('Close settings').click()

  await launched.page.evaluate(() => {
    window.electronAPI.openExternal('https://example.com/docs')
    window.electronAPI.openExternal('javascript:alert(1)')
  })

  await expect.poll(async () => {
    const contents = await readFile(launched!.paths.externalUrlLogPath, 'utf8')
    const records = contents.trim().split('\n').map((line) => JSON.parse(line) as { allowed: boolean })
    return {
      total: records.length,
      allowed: records.filter((record) => record.allowed).length,
      blocked: records.filter((record) => !record.allowed).length,
    }
  }).toEqual({ total: 2, allowed: 1, blocked: 1 })
})
