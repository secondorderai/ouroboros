import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { LaunchedApp } from './helpers'
import {
  clearClientState,
  clearRpcOverrides,
  emitNotification,
  emitUpdateDownloaded,
  getInstallUpdateCount,
  launchTestApp,
  resetInstallUpdateCount,
  setRpcOverride,
} from './helpers'

let launched: LaunchedApp | null = null
const modKey = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function openMainApp(): Promise<void> {
  if (!launched) throw new Error('App not launched')
  await launched.page.evaluate(() => {
    localStorage.setItem('ouroboros:onboarding-done', 'true')
  })
  await launched.page.reload()
  await expect(launched.page.getByLabel('Message input')).toBeVisible()
}

test('onboarding renders and preload bridges are available', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await expect(launched.page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible()

  const bridgeInfo = await launched.page.evaluate(() => ({
    hasRpc: typeof window.ouroboros?.rpc === 'function',
    hasNotificationBridge: typeof window.ouroboros?.onNotification === 'function',
    hasExternalOpen: typeof window.electronAPI?.openExternal === 'function',
  }))

  expect(bridgeInfo).toEqual({
    hasRpc: true,
    hasNotificationBridge: true,
    hasExternalOpen: true,
  })
})

test('approval notifications populate the UI and failed responses keep the approval visible', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'approval/respond', {
    ok: false,
    error: { name: 'Error', message: 'CLI restarting' },
  })

  await emitNotification(launched.page, 'approval/request', {
    id: 'approval-1',
    type: 'self-modification',
    description: 'Approve this desktop patch',
    createdAt: new Date().toISOString(),
    risk: 'high',
  })

  await expect(launched.page.getByText('Approval Required')).toBeVisible()
  await expect(launched.page.getByText('Approve this desktop patch')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Approve' }).click()

  await expect(launched.page.getByText('CLI restarting')).toBeVisible()
  await expect(launched.page.getByText('Approve this desktop patch')).toBeVisible()
})

test('onboarding stays open when required setup fails', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/testConnection', {
    ok: true,
    result: { success: true, models: ['claude-opus-4-20250514'] },
  })
  await setRpcOverride(launched.page, 'config/setApiKey', {
    ok: false,
    error: { name: 'Error', message: 'Invalid API key' },
  })

  await launched.page.getByPlaceholder('sk-...').fill('sk-test-key')
  await launched.page.getByRole('button', { name: 'Test Connection' }).click()
  await expect(launched.page.getByText('Connected')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Next' }).click()
  await expect(launched.page.getByText('Choose your workspace')).toBeVisible()

  await launched.page.getByRole('button', { name: "I'll set this up later" }).click()
  await expect(launched.page.getByText('What would you like to do?')).toBeVisible()

  await launched.page.getByText('Help me with a project').click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()

  await expect(launched.page.getByText('Invalid API key')).toBeVisible()
  await expect(launched.page.getByText('What would you like to do?')).toBeVisible()
})

test('agent notifications finalize chat output and completed tool calls', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Final answer',
      iterations: 1,
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Summarize the repo')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-1',
    toolName: 'web-search',
    input: { q: 'ouroboros repo' },
  })
  await emitNotification(launched.page, 'agent/text', { text: 'Working through the repository...' })
  await emitNotification(launched.page, 'agent/toolCallEnd', {
    toolCallId: 'tool-1',
    toolName: 'web-search',
    result: { ok: true },
    isError: false,
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Final answer',
    iterations: 1,
  })

  await expect(launched.page.getByText('Final answer')).toBeVisible()
  await expect(launched.page.getByText('Searched web')).toBeVisible()
})

test('completed tool chip stays expanded and does not flash the jump button', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Done',
      iterations: 1,
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Check the latest report')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-expand-1',
    toolName: 'web-search',
    input: { query: 'latest report' },
  })
  await emitNotification(launched.page, 'agent/toolCallEnd', {
    toolCallId: 'tool-expand-1',
    toolName: 'web-search',
    result: { results: ['report-a', 'report-b'] },
    isError: false,
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Done',
    iterations: 1,
  })

  await launched.page.getByRole('button', { name: /Searched web/ }).click()

  const expandedChipHeader = launched.page.getByRole('button', {
    name: 'Searched web — click to collapse',
  })
  await expect(expandedChipHeader).toBeVisible()
  await expect(launched.page.getByText('Input')).toBeVisible()
  await expect(launched.page.getByText('Output')).toBeVisible()

  await launched.page.waitForTimeout(300)
  await expect(expandedChipHeader).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Jump to bottom' })).toHaveCount(0)
})

test('desktop chat uses readable assistant layout and desktop-specific response hints', async ({}, testInfo) => {
  const markdownResponse = [
    '## Short answer',
    '',
    'For desktop chat, prose should read more like a document than a raw terminal dump.',
    '',
    '- Start with a framing paragraph.',
    '- Keep the bullet count short.',
    '- Leave enough space between sections.',
    '',
    '```ts',
    "console.log('readable desktop output')",
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: markdownResponse,
          iterations: 1,
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'agent/text', params: { text: markdownResponse } },
          {
            delayMs: 20,
            method: 'agent/turnComplete',
            params: { text: markdownResponse, iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  await launched.page.getByLabel('Message input').fill('Explain desktop readability')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(
    launched.page.getByText(
      'For desktop chat, prose should read more like a document than a raw terminal dump.',
    ),
  ).toBeVisible()
  await expect(launched.page.getByText('Keep the bullet count short.')).toBeVisible()
  await expect(
    launched.page.locator('[data-testid="agent-message"] .code-block-wrapper'),
  ).toBeVisible()

  await expect
    .poll(async () => {
      const log = await readFile(launched!.paths.mockLogPath, 'utf8').catch(() => '')
      return log
    })
    .toContain('"responseStyle":"desktop-readable"')

  await expect
    .poll(async () => {
      const log = await readFile(launched!.paths.mockLogPath, 'utf8').catch(() => '')
      return log
    })
    .toContain('"client":"desktop"')

  const assistantMessage = launched.page.locator('[data-testid="agent-message"]').last()

  const layoutMetrics = await assistantMessage.evaluate((node) => {
    const markdownBody = node.querySelector('.markdown-body') as HTMLElement | null
    const content = node.querySelector('[data-testid="agent-message-content"]') as HTMLElement | null
    const codeBlock = node.querySelector('.code-block-wrapper') as HTMLElement | null

    if (!markdownBody || !content || !codeBlock) {
      throw new Error('Assistant message layout nodes not found')
    }

    return {
      firstBlockTag: markdownBody.firstElementChild?.tagName ?? null,
      contentWidth: content.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
      codeBlockCount: markdownBody.querySelectorAll('.code-block-wrapper').length,
    }
  })

  const paragraphSpacing = await launched.page
    .getByText('For desktop chat, prose should read more like a document than a raw terminal dump.')
    .evaluate((node) => {
      const el = node as HTMLElement
      return {
        tagName: el.tagName,
        marginBottom: Number.parseFloat(getComputedStyle(el).marginBottom),
      }
    })

  const listSpacing = await launched.page.getByText('Keep the bullet count short.').evaluate((node) => {
    const el = (node.closest('li') as HTMLElement | null) ?? (node as HTMLElement)
    return {
      tagName: el.tagName,
      marginBottom: Number.parseFloat(getComputedStyle(el).marginBottom),
    }
  })

  expect(layoutMetrics.firstBlockTag).toBe('H2')
  expect(layoutMetrics.contentWidth).toBeLessThan(layoutMetrics.viewportWidth * 0.72)
  expect(paragraphSpacing.tagName).toBe('P')
  expect(paragraphSpacing.marginBottom).toBeGreaterThanOrEqual(14)
  expect(listSpacing.tagName).toBe('LI')
  expect(listSpacing.marginBottom).toBeGreaterThanOrEqual(8)
  expect(layoutMetrics.codeBlockCount).toBeGreaterThanOrEqual(1)
})

test('streaming assistant text renders markdown before turn completion', async ({}, testInfo) => {
  const markdownResponse = [
    '## Short answer',
    '',
    'The streaming row should render markdown as formatted content.',
    '',
    '- First point',
    '- Second point',
    '',
    '```ts',
    "console.log('streaming markdown')",
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: markdownResponse,
      iterations: 1,
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Show me a formatted streamed answer')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/text', { text: markdownResponse })

  const streamingMessage = launched.page.locator('[data-testid="agent-message"]').last()

  await expect(streamingMessage.getByText('Writing the response...')).toBeVisible()
  await expect(streamingMessage.getByRole('heading', { name: 'Short answer' })).toBeVisible()
  await expect(streamingMessage.getByText('First point')).toBeVisible()
  await expect(streamingMessage.locator('.code-block-wrapper')).toBeVisible()
  await expect(streamingMessage.locator('.markdown-body')).toBeVisible()
  await expect(streamingMessage.getByText('## Short answer')).toHaveCount(0)

  await emitNotification(launched.page, 'agent/turnComplete', {
    text: markdownResponse,
    iterations: 1,
  })

  await expect(launched.page.getByRole('heading', { name: 'Short answer' }).last()).toBeVisible()
})

test('streaming cursor stays attached to the last rendered line', async ({}, testInfo) => {
  const markdownResponse = [
    '## Cursor check',
    '',
    'The cursor should sit on this final rendered line.',
  ].join('\n')

  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: markdownResponse,
      iterations: 1,
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Show a cursor-aligned streamed answer')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/text', { text: markdownResponse })

  const streamingMessage = launched.page.locator('[data-testid="agent-message"]').last()
  const finalParagraph = streamingMessage.getByText(
    'The cursor should sit on this final rendered line.',
  )
  const cursor = streamingMessage.locator('.streaming-cursor')

  await expect(finalParagraph).toBeVisible()
  await expect(cursor).toBeVisible()

  const metrics = await streamingMessage.evaluate((node) => {
    const paragraph = Array.from(node.querySelectorAll('p')).find((el) =>
      el.textContent?.includes('The cursor should sit on this final rendered line.'),
    ) as HTMLElement | undefined
    const cursorEl = node.querySelector('.streaming-cursor') as HTMLElement | null

    if (!paragraph || !cursorEl) {
      throw new Error('Streaming paragraph or cursor not found')
    }

    const paragraphRect = paragraph.getBoundingClientRect()
    const cursorRect = cursorEl.getBoundingClientRect()

    return {
      paragraphTop: paragraphRect.top,
      paragraphBottom: paragraphRect.bottom,
      cursorTop: cursorRect.top,
      cursorBottom: cursorRect.bottom,
    }
  })

  expect(metrics.cursorTop).toBeGreaterThan(metrics.paragraphTop)
  expect(metrics.cursorTop).toBeLessThan(metrics.paragraphBottom + 2)
  expect(metrics.cursorBottom).toBeLessThan(metrics.paragraphBottom + 6)
})

test('settings overlay surfaces load failures and closes with Escape', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/get', {
    ok: false,
    error: { name: 'Error', message: 'Settings unavailable' },
  })

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await expect(launched.page.getByText('Settings unavailable')).toBeVisible()
  await launched.page.keyboard.press('Escape')
  await expect(launched.page.getByText('Settings', { exact: true })).not.toBeVisible()
})

test('update banner can be exercised without leaving the renderer contract suite', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await resetInstallUpdateCount(launched.page)

  await emitUpdateDownloaded(launched.page, '1.2.3')

  await expect(launched.page.getByRole('alert')).toContainText(
    'Update available (v1.2.3). Restart to apply.',
  )
  await launched.page.getByRole('button', { name: 'Restart now' }).click()

  await expect.poll(async () => getInstallUpdateCount(launched!.page)).toBe(1)
})
