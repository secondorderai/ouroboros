import { expect, test } from '@playwright/test'
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

test('settings overlay surfaces load failures and closes with Escape', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/get', {
    ok: false,
    error: { name: 'Error', message: 'Settings unavailable' },
  })

  await launched.page.evaluate((currentModKey) => {
    const init = currentModKey === 'metaKey'
      ? { key: ',', metaKey: true }
      : { key: ',', ctrlKey: true }
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

  await expect(launched.page.getByRole('alert')).toContainText('Update available (v1.2.3). Restart to apply.')
  await launched.page.getByRole('button', { name: 'Restart now' }).click()

  await expect.poll(async () => getInstallUpdateCount(launched!.page)).toBe(1)
})
