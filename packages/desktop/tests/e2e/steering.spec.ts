/**
 * Mid-flight steering — end-to-end tests.
 *
 * Drives the InputBar while an agent run is "in flight" (the mock CLI's
 * agent/run RPC resolves but no agent/turnComplete notification follows, so
 * the renderer stays in `isAgentRunning === true`). Verifies the user can
 * steer mid-stream, sees the message render with steer styling, and that
 * the bubble's lifecycle (pending → injected → orphaned) is reflected in
 * the caption text.
 */
import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { LaunchedApp } from './helpers'
import {
  clearClientState,
  clearRpcOverrides,
  emitNotification,
  launchTestApp,
  setRpcOverride,
} from './helpers'

async function extractSteerRequestId(mockLogPath: string): Promise<string> {
  const log = await readFile(mockLogPath, 'utf8').catch(() => '')
  // mock-cli prefixes log entries with "[request] " or "[response] " — strip
  // that off before parsing.
  const lines = log
    .split('\n')
    .filter((line) => line.includes('"method":"agent/steer"'))
    .map((line) => line.replace(/^\[(request|response)\]\s+/, ''))
  const last = lines[lines.length - 1]
  if (!last) throw new Error('No agent/steer call found in mock log')
  const parsed = JSON.parse(last) as { params?: { requestId?: string } }
  const id = parsed.params?.requestId
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('agent/steer call has no requestId')
  }
  return id
}

let launched: LaunchedApp | null = null

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

async function startAgentRun(message: string): Promise<void> {
  if (!launched) throw new Error('App not launched')
  await clearRpcOverrides(launched.page)
  // agent/run resolves OK but we never emit turnComplete, so the renderer
  // stays in the "agent is running" state — perfect for steering tests.
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: { text: '', iterations: 0, stopReason: 'completed', maxIterationsReached: false },
  })
  // agent/steer is intentionally NOT overridden — we want it to hit the
  // mock CLI so its log captures the requestId. The mock returns
  // { accepted: true } by default.

  await launched.page.getByLabel('Message input').fill(message)
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByLabel('Stop agent')).toBeVisible()
  await expect(launched.page.getByLabel('Steer current turn')).toBeVisible()
}

test('typing while running shows steer affordances and adds a steer bubble', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('analyze the repo')

  // Steer the running turn.
  await launched.page.getByLabel('Message input').fill('actually skip docs/')
  await launched.page.getByLabel('Steer current turn').click()

  // The steer bubble appears with the 'pending' caption.
  await expect(launched.page.getByText('actually skip docs/')).toBeVisible()
  await expect(launched.page.getByText(/↳\s*pending/i).first()).toBeVisible()
})

test('agent/steerInjected flips the steer caption to "steered"', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('analyze the repo')

  await launched.page.getByLabel('Message input').fill('pivot to plan B')
  await launched.page.getByLabel('Steer current turn').click()
  await expect(launched.page.getByText(/↳\s*pending/i).first()).toBeVisible()

  // Capture the requestId from the mock-cli RPC log; the renderer generates
  // it via crypto.randomUUID() so the wire is the only place to read it.
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"agent/steer"')
  const requestId = await extractSteerRequestId(launched.paths.mockLogPath)

  await emitNotification(launched.page, 'agent/steerInjected', {
    sessionId: null,
    steerId: requestId,
    iteration: 2,
    text: 'pivot to plan B',
  })

  await expect(launched.page.getByText(/↳\s*steered/i).first()).toBeVisible()
})

test('agent/steerOrphaned surfaces resend / discard actions on the bubble', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('analyze the repo')

  await launched.page.getByLabel('Message input').fill('too late')
  await launched.page.getByLabel('Steer current turn').click()
  await expect(launched.page.getByText(/↳\s*pending/i).first()).toBeVisible()

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"agent/steer"')
  const requestId = await extractSteerRequestId(launched.paths.mockLogPath)

  await emitNotification(launched.page, 'agent/steerOrphaned', {
    sessionId: null,
    reason: 'cancelled',
    steers: [{ id: requestId, text: 'too late' }],
  })

  await expect(launched.page.getByText(/↳\s*not steered/i).first()).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Send as new message' })).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Discard' })).toBeVisible()
})
