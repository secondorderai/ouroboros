import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { launchTestApp, setRpcOverride, type LaunchedApp } from './helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})
const details = [
  {
    id: 'gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    family: 'openai',
    reasoningKind: 'openai-reasoning',
    lifecycle: 'current',
    sourceUrl: 'https://example.invalid/models',
    verifiedAt: '2026-10-19',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindowTokens: 500_000,
  },
]

test('subscription settings and composer use discovered names, supported efforts, refresh and repair notice', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      config: {
        model: { provider: 'openai-chatgpt', name: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      },
      authStatus: {
        connected: true,
        models: ['gpt-6.1-sol'],
        modelDetails: details,
        catalogSource: 'live',
        catalogFetchedAt: '2026-10-19T00:00:00Z',
        modelMigration: {
          from: 'gpt-5.5',
          to: 'gpt-6.1-sol',
          message: 'Replaced retired subscription model gpt-5.5 with gpt-6.1-sol.',
        },
      },
    },
  })
  const { page } = launched
  await page.evaluate(() => localStorage.setItem('ouroboros:onboarding-done', 'true'))
  await page.reload()
  await expect(
    page.getByRole('status').filter({ hasText: 'Replaced retired subscription model' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Reasoning effort: medium' }).click()
  await expect(page.getByRole('menuitem', { name: 'xhigh', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'none', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'ultra', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'xhigh', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page.locator('#settings-model')).toHaveValue('gpt-6.1-sol')
  await expect(page.locator('#settings-model option')).toHaveText(['GPT-6.1 Sol'])
  await expect(page.locator('#settings-reasoning-effort option')).toHaveText(
    details[0].reasoningEfforts,
  )
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8'))
    .toContain('"refresh":true')
  await setRpcOverride(page, 'auth/getStatus', {
    ok: true,
    result: {
      provider: 'openai-chatgpt',
      connected: true,
      authType: 'oauth',
      pending: false,
      availableMethods: ['browser', 'headless'],
      models: ['gpt-6.1-sol'],
      modelDetails: [{ ...details[0], reasoningEfforts: ['medium', 'xhigh'] }],
      catalogSource: 'cache',
      catalogError: 'Unable to refresh; saved models are unverified.',
    },
  })
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect(page.getByText('Unable to refresh; saved models are unverified.')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Reasoning effort: xhigh' }).click()
  await expect(page.getByRole('menuitem', { name: 'medium', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'max', exact: true })).toHaveCount(0)
})

test('onboarding displays a future account model without a hardcoded UI list', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      authStatus: {
        connected: true,
        models: ['gpt-future'],
        modelDetails: [
          {
            ...details[0],
            id: 'gpt-future',
            displayName: 'Future Account Model',
            reasoningEfforts: ['medium', 'max'],
          },
        ],
        catalogSource: 'live',
      },
    },
  })
  await launched.page.getByRole('radio', { name: 'ChatGPT Subscription' }).click()
  await expect(launched.page.locator('#onboarding-model')).toHaveValue('gpt-future')
  await expect(launched.page.locator('#onboarding-model option')).toHaveText([
    'Future Account Model',
  ])
  await expect(launched.page.getByRole('button', { name: 'Next' })).toBeEnabled()
  await launched.page.getByRole('button', { name: 'Refresh models' }).click()
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8'))
    .toContain('"refresh":true')
  await launched.page.getByRole('button', { name: 'Next' }).click()
  await launched.page.getByRole('button', { name: 'Simple', exact: true }).click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()
  await launched.page.getByRole('button', { name: 'Reasoning effort: medium' }).click()
  await expect(launched.page.getByRole('menuitem', { name: 'max', exact: true })).toBeVisible()
  await expect(launched.page.getByRole('menuitem', { name: 'high', exact: true })).toHaveCount(0)
})
