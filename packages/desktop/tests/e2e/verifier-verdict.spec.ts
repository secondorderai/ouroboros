/**
 * Verifier verdict chip — end-to-end tests.
 *
 * Drives the renderer with synthetic `agent/verifierVerdict` notifications
 * (via the test bridge's emitNotification helper) and verifies the inline
 * chip in ChatView: it renders only for final verdicts, carries a
 * `data-verdict` attribute per verdict value, lists unmet criteria for
 * failures, and disappears on dismiss.
 */
import { expect, test } from '@playwright/test'
import type { LaunchedApp } from './helpers'
import {
  clearClientState,
  clearRpcOverrides,
  emitNotification,
  launchTestApp,
  setRpcOverride,
} from './helpers'

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

/**
 * Start an agent run that stays "in flight" (agent/run resolves but no
 * turnComplete follows), so ChatView is mounted and the verdict chip has a
 * place to render.
 */
async function startAgentRun(message: string): Promise<void> {
  if (!launched) throw new Error('App not launched')
  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: { text: '', iterations: 0, stopReason: 'completed', maxIterationsReached: false },
  })

  await launched.page.getByLabel('Message input').fill(message)
  await launched.page.getByLabel('Message input').press('Enter')
  await expect(launched.page.getByLabel('Stop agent')).toBeVisible()
}

function verdictPayload(
  verdict: 'pass' | 'fail' | 'unknown',
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sessionId: null,
    verdict,
    failures:
      verdict === 'fail'
        ? [
            {
              criterion: 'Matching automated tests exist and pass',
              evidence: 'No test execution found in the run evidence.',
              suggestion: 'Run the test suite and confirm it passes.',
            },
          ]
        : [],
    reason: verdict === 'pass' ? 'All criteria are supported by tool evidence.' : 'Unmet criteria.',
    attempt: 1,
    willRetry: false,
    escalated: false,
    ...overrides,
  }
}

test('fail verdict renders the chip with failure list; dismiss hides it', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('implement the feature')

  // An intermediate verdict (willRetry: true) must NOT render a chip.
  await emitNotification(
    launched.page,
    'agent/verifierVerdict',
    verdictPayload('fail', { willRetry: true }),
  )
  await expect(launched.page.getByTestId('verifier-verdict-chip')).toHaveCount(0)

  // The final verdict renders the chip with the failure details.
  await emitNotification(launched.page, 'agent/verifierVerdict', verdictPayload('fail'))
  const chip = launched.page.getByTestId('verifier-verdict-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-verdict', 'fail')
  await expect(chip).toContainText('1 unmet criterion')
  await expect(chip).toContainText('Matching automated tests exist and pass')
  await expect(chip).toContainText('Run the test suite and confirm it passes.')

  // Dismissing removes the chip.
  await launched.page.getByLabel('Dismiss verifier verdict').click()
  await expect(launched.page.getByTestId('verifier-verdict-chip')).toHaveCount(0)
})

test('pass verdict renders a green-accented chip with data-verdict="pass"', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('analyze the repo')

  await emitNotification(launched.page, 'agent/verifierVerdict', verdictPayload('pass'))
  const chip = launched.page.getByTestId('verifier-verdict-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-verdict', 'pass')
  await expect(chip).toContainText('checks passed')
  // Pass verdicts list no failures.
  await expect(chip.locator('ul')).toHaveCount(0)
})

test('verdicts emitted by the CLI flow through the main-process forwarding list', async ({}, testInfo) => {
  // Unlike the other specs (which inject notifications via the test bridge,
  // bypassing the main process), this run lets the mock CLI emit
  // `agent/verifierVerdict` over JSON-RPC stdout. The chip only renders if
  // the method is registered in FORWARDED_NOTIFICATION_METHODS in
  // ipc-handlers.ts — removing it from the forwarding list fails this test.
  // Drop the null sessionId so the mock CLI stamps the real run session.
  const verdictParams = verdictPayload('fail')
  delete verdictParams.sessionId
  launched = await launchTestApp(testInfo, {
    scenario: {
      agentRuns: [
        {
          response: {
            text: '',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [{ delayMs: 50, method: 'agent/verifierVerdict', params: verdictParams }],
        },
      ],
    },
  })
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await launched.page.getByLabel('Message input').fill('run through the real CLI bridge')
  await launched.page.getByLabel('Message input').press('Enter')

  const chip = launched.page.getByTestId('verifier-verdict-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-verdict', 'fail')
  await expect(chip).toContainText('1 unmet criterion')
})

test('unknown verdict renders with data-verdict="unknown"', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await clearClientState(launched.page)
  await openMainApp()

  await startAgentRun('summarize the docs')

  await emitNotification(launched.page, 'agent/verifierVerdict', verdictPayload('unknown'))
  const chip = launched.page.getByTestId('verifier-verdict-chip')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-verdict', 'unknown')
  await expect(chip).toContainText('could not be confirmed')
})
