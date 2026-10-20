import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  clearRpcOverrides,
  completeOnboarding,
  emitNotification,
  launchTestApp,
  setRpcOverride,
} from './helpers'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const htmlPath = path.join(root, 'docs/ouroboros-engineering.html')
const htmlUrl = pathToFileURL(htmlPath).href
const topics = ['prompt', 'context', 'harness', 'evals', 'loop']

// Reuse a browser already on the host when its Playwright revision differs.
// CI can omit this variable and use its standard installed Chromium revision.
test.use({
  colorScheme: 'light',
  launchOptions: process.env.OUROBOROS_TEST_CHROME_PATH
    ? { executablePath: process.env.OUROBOROS_TEST_CHROME_PATH }
    : {},
})

test.describe('standalone engineering explorer', () => {
  test('all five labs respond to real user interactions with no network dependencies', async ({
    page,
  }) => {
    const errors: string[] = []
    const network: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(/^https?:/, (route) => {
      network.push(route.request().url())
      return route.abort()
    })
    await page.goto(htmlUrl)
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByRole('tabpanel')).toHaveCount(1)

    await page.locator('#prompt-skill').check()
    await expect(page.locator('#prompt-preview')).toContainText('Activated skill: testing-workflow')
    await page.locator('#prompt-plan').check()
    await expect(page.locator('#prompt-preview')).toContainText('Active mode: Plan')
    await page.locator('#prompt-memory').uncheck()
    await expect(page.locator('#prompt-preview')).not.toContainText('## Memory Context')
    await page.locator('#panel-prompt summary').click()
    await expect(page.locator('#panel-prompt a').first()).toHaveAttribute(
      'href',
      /f732fd3.*prompt\.ts/,
    )

    await page.locator('#tab-context').click()
    await page.locator('#context-usage').fill('70')
    await expect(page.locator('#context-phase')).toHaveText('Warning')
    await page.locator('#context-usage').fill('80')
    await page.locator('#context-run').click()
    await expect(page.locator('#context-run-result')).toContainText('Raw history remains intact')
    await page.locator('#context-usage').fill('90')
    await expect(page.locator('#context-phase')).toHaveText('Compact')
    await page.locator('#context-checkpoint').uncheck()
    await expect(page.locator('#context-phase')).toHaveText('Compaction blocked')
    await page.locator('#context-run').click()
    await expect(page.locator('#context-run-result')).toContainText('raw history retained')

    await page.locator('#tab-harness').click()
    await page.locator('#harness-action').selectOption('memory')
    await expect(page.locator('#harness-decision')).toHaveText('Wait for human approval')
    await page.locator('#harness-approval').check()
    await expect(page.locator('#harness-decision')).toHaveText('Allowed by this profile')
    await page.locator('#harness-mode').selectOption('plan')
    await expect(page.locator('#harness-decision')).toHaveText('Blocked before execution')
    await page.locator('#harness-mode').selectOption('primary')
    await page.locator('#harness-action').selectOption('protected')
    await expect(page.locator('#harness-decision')).toHaveText('Blocked by OS sandbox')
    await page.locator('#harness-valid').uncheck()
    await expect(page.locator('#harness-decision')).toHaveText('Invalid tool arguments')

    await page.locator('#tab-evals').click()
    await expect(page.locator('#eval-verdict')).toHaveText('Unknown')
    await page.locator('#eval-evidence').selectOption('failing')
    await expect(page.locator('#eval-verdict')).toHaveText('Fail')
    await expect(page.locator('#eval-action')).toContainText('retry')
    await page.locator('#eval-evidence').selectOption('passing')
    await page.locator('#eval-regression').check()
    await expect(page.locator('#eval-verdict')).toHaveText('Pass')
    await page.locator('#panel-evals .lab summary').click()
    await page.locator('#eval-calls').fill('4')
    await expect(page.locator('#eval-verdict')).toHaveText('Not run')
    await page.locator('#eval-calls').fill('6')
    await page.locator('#eval-evidence').selectOption('failing')
    await page.locator('#eval-attempt').fill('3')
    await expect(page.locator('#eval-action')).toContainText('human completion override')
    await page.locator('#eval-approval').uncheck()
    await expect(page.locator('#eval-action')).toContainText('unmet-criteria warning')
    await page.locator('#eval-evidence').selectOption('error')
    await expect(page.locator('#eval-verdict')).toHaveText('Unknown')
    await expect(page.locator('#eval-action')).toContainText('unverified warning')

    await page.locator('#tab-loop').click()
    await expect(page.locator('#loop-title')).toHaveText('Plan')
    await page.locator('#loop-success').uncheck()
    for (let i = 0; i < 5; i++) await page.locator('#loop-next').click()
    await expect(page.locator('#loop-title')).toHaveText('Hand off incomplete')
    await expect(page.locator('#loop-next')).toBeDisabled()
    await page.locator('#loop-mode').selectOption('learning')
    await expect(page.locator('#loop-title')).toHaveText('Observe')
    await page.locator('#loop-success').uncheck()
    for (let i = 0; i < 3; i++) await page.locator('#loop-next').click()
    await expect(page.locator('#loop-title')).toHaveText('Skill tests failed')
    await page.locator('#loop-reset').click()
    await expect(page.locator('#loop-counter')).toHaveText('Stage 1 of 6')
    expect(network).toEqual([])
    expect(errors).toEqual([])
  })

  test('guided task, reset, keyboard navigation, and theme controls work', async ({ page }) => {
    await page.goto(htmlUrl)
    await page.getByRole('button', { name: 'Follow a task through all five' }).click()
    for (let i = 0; i < topics.length; i++) {
      await expect(page.locator(`#tab-${topics[i]}`)).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('#tour-caption')).toContainText(`0${i + 1} / 05`)
      if (i < topics.length - 1) await page.locator('#tour-next').click()
    }
    await expect(page.locator('#tour-next')).toBeDisabled()
    await expect(page.locator('#loop-mode')).toHaveValue('learning')
    await page.locator('#tour-prev').click()
    await expect(page.locator('#eval-verdict')).toHaveText('Pass')
    await page.locator('#tour-reset').click()
    await expect(page.locator('#tour-prev')).toBeDisabled()
    await expect(page.locator('#tab-prompt')).toHaveAttribute('aria-selected', 'true')
    await page.locator('#tab-prompt').focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('#tab-context')).toBeFocused()
    await expect(page.locator('#panel-context')).toBeVisible()
    await page.keyboard.press('End')
    await expect(page.locator('#tab-loop')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.locator('#tab-prompt')).toBeFocused()
    await page.locator('#theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.locator('#theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })

  test('mobile/tablet/desktop layouts contain every panel without page overflow', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(htmlUrl)
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const topic of topics) {
        await page.locator(`#tab-${topic}`).click()
        await expect(page.locator(`#panel-${topic}`)).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
      }
    }
    await page.screenshot({
      path: test.info().outputPath('engineering-explorer-desktop.png'),
      fullPage: true,
    })
  })

  test('all explanations remain readable with JavaScript disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
      const page = await context.newPage()
      await page.goto(htmlUrl)
      await expect(page.getByRole('tabpanel')).toHaveCount(5)
      for (const topic of topics) await expect(page.locator(`#panel-${topic}`)).toBeVisible()
      await expect(page.locator('.nojs')).toBeVisible()
      await expect(page.locator('.nojs')).toContainText('All five explanations remain readable')
      await expect(page.locator('body')).not.toHaveAttribute('data-ready', 'true')
    } finally {
      await context.close()
    }
  })
})

test('real app artifact panel runs all five labs under the actual hardening policy', async ({}, testInfo) => {
  const source = await readFile(htmlPath, 'utf8')
  // Use the real CLI hardener, not a copied CSP string or a mock HTML renderer.
  const hardened = execFileSync(
    'bun',
    [
      '-e',
      [
        "import { readFileSync } from 'node:fs'",
        "import { hardenHtml } from './src/artifacts/csp'",
        "const r = hardenHtml(readFileSync(0, 'utf8'), [])",
        'if (!r.ok) throw r.error',
        'process.stdout.write(r.value.html)',
      ].join(';'),
    ],
    { cwd: path.join(root, 'packages/cli'), input: source, encoding: 'utf8' },
  )
  const temp = await mkdtemp(path.join(tmpdir(), 'ouroboros-engineering-e2e-'))
  const sessionId = 'engineering-explorer-test'
  const artifactId = 'engineering-explorer'
  const dir = path.join(temp, 'memory/sessions', sessionId, 'artifacts')
  await mkdir(dir, { recursive: true })
  const artifactPath = path.join(dir, `${artifactId}.v1.html`)
  await writeFile(artifactPath, hardened)
  const launched = await launchTestApp(testInfo)
  try {
    await completeOnboarding(launched.page)
    const meta = {
      artifactId,
      sessionId,
      version: 1,
      title: 'Engineering the loop',
      path: artifactPath,
      bytes: Buffer.byteLength(hardened),
      createdAt: '2026-10-19T00:00:00Z',
    }
    await setRpcOverride(launched.page, 'artifacts/list', { ok: true, result: { artifacts: [] } })
    await setRpcOverride(launched.page, 'artifacts/read', {
      ok: true,
      result: { html: hardened, artifact: meta },
    })
    await setRpcOverride(launched.page, 'session/new', { ok: true, result: { sessionId } })
    await launched.page.getByRole('button', { name: 'New conversation' }).click()
    await emitNotification(launched.page, 'agent/artifactCreated', meta)
    await expect(launched.page.getByTestId('artifact-panel')).toBeVisible()
    const frame = launched.page.frameLocator('[data-testid="artifact-frame"]')
    await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true')
    for (const topic of topics) {
      // Real mouse interactions are covered above. Match the existing Electron
      // iframe CSP regression guard for reliable cross-platform event dispatch.
      await frame.locator(`#tab-${topic}`).evaluate((el) => (el as HTMLButtonElement).click())
      await expect(frame.locator(`#panel-${topic}`)).toBeVisible()
    }
    await frame.locator('#loop-next').evaluate((el) => (el as HTMLButtonElement).click())
    await expect(frame.locator('#loop-title')).toHaveText('Act')
    await frame.locator('#tab-prompt').evaluate((el) => (el as HTMLButtonElement).click())
    await frame.locator('#prompt-skill').evaluate((el) => (el as HTMLInputElement).click())
    await expect(frame.locator('#prompt-preview')).toContainText(
      'Activated skill: testing-workflow',
    )
    await frame.locator('#tab-context').evaluate((el) => (el as HTMLButtonElement).click())
    await frame.locator('#context-usage').evaluate((el) => {
      const input = el as HTMLInputElement
      input.value = '90'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(frame.locator('#context-phase')).toHaveText('Compact')
    await frame.locator('#tab-harness').evaluate((el) => (el as HTMLButtonElement).click())
    await frame.locator('#harness-valid').evaluate((el) => (el as HTMLInputElement).click())
    await expect(frame.locator('#harness-decision')).toHaveText('Invalid tool arguments')
    await frame.locator('#tab-evals').evaluate((el) => (el as HTMLButtonElement).click())
    await frame.locator('#eval-evidence').evaluate((el) => {
      const select = el as HTMLSelectElement
      select.value = 'failing'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(frame.locator('#eval-verdict')).toHaveText('Fail')
    await launched.page.screenshot({
      path: testInfo.outputPath('engineering-explorer-artifact.png'),
      fullPage: true,
    })
  } finally {
    await clearRpcOverrides(launched.page).catch(() => {})
    await launched.app.close()
    await rm(temp, { recursive: true, force: true })
  }
})
