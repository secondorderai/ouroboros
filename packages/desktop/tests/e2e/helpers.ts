import { expect, _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')
const mainPath = path.resolve(repoRoot, 'packages/desktop/out/main/index.js')

export interface TestRpcOverride {
  ok: boolean
  result?: unknown
  error?: {
    name?: string
    message?: string
  }
}

export interface LaunchScenario {
  config?: Record<string, unknown>
  workspace?: string | null
  approvals?: Array<Record<string, unknown>>
  skills?: Array<Record<string, unknown>>
  evolutionEntries?: Array<Record<string, unknown>>
  evolutionStats?: Record<string, unknown>
  sessions?: Array<Record<string, unknown>>
  methodErrors?: Record<string, { message: string; code?: number }>
  startupNotifications?: Array<{ delayMs?: number; method: string; params?: Record<string, unknown> }>
  agentRuns?: Array<{
    response?: Record<string, unknown>
    notifications?: Array<{ delayMs?: number; method: string; params?: Record<string, unknown> }>
  }>
  defaultAgentRun?: {
    response?: Record<string, unknown>
    notifications?: Array<{ delayMs?: number; method: string; params?: Record<string, unknown> }>
  }
  launchBehavior?: Record<string, {
    exitAfterMs?: number
    stderrLines?: string[]
    startupNotifications?: Array<{ delayMs?: number; method: string; params?: Record<string, unknown> }>
  }>
}

export interface LaunchOptions {
  scenario?: LaunchScenario
  dialogResponses?: Array<string | string[] | null>
  updateDownloadedVersion?: string
  updateDownloadedDelayMs?: number
  env?: Record<string, string | undefined>
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  paths: {
    scenarioPath: string
    statePath: string
    mockLogPath: string
    installUpdateLogPath: string
    externalUrlLogPath: string
    bootLogPath: string
  }
}

export async function launchTestApp(
  testInfo: TestInfo,
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'ouroboros-desktop-tests-'))
  const testScenarioPath = path.join(runtimeDir, 'scenario.json')
  const testDialogResponsesPath = path.join(runtimeDir, 'dialog-responses.json')
  const testStatePath = path.join(runtimeDir, 'mock-state.json')
  const testMockLogPath = path.join(runtimeDir, 'mock-cli.log')
  const testInstallUpdateLogPath = path.join(runtimeDir, 'install-update.log')
  const testExternalUrlLogPath = path.join(runtimeDir, 'external-url.log')
  const testBootLogPath = path.join(runtimeDir, 'boot.log')
  const testUpdateDownloadedPath = path.join(runtimeDir, 'update-downloaded.txt')
  const testUserDataDir = path.join(runtimeDir, 'user-data')

  await mkdir(testUserDataDir, { recursive: true })
  await writeFile(testScenarioPath, JSON.stringify(options.scenario ?? {}, null, 2))
  await writeFile(
    testDialogResponsesPath,
    JSON.stringify(options.dialogResponses ?? [], null, 2),
  )
  await writeFile(
    testUpdateDownloadedPath,
    options.updateDownloadedVersion ?? '',
  )

  const app = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OUROBOROS_TEST_RUNTIME_DIR: runtimeDir,
      OUROBOROS_TEST_SCENARIO_PATH: testScenarioPath,
      OUROBOROS_TEST_DIALOG_RESPONSES_PATH: testDialogResponsesPath,
      OUROBOROS_TEST_STATE_PATH: testStatePath,
      OUROBOROS_TEST_MOCK_LOG_PATH: testMockLogPath,
      OUROBOROS_TEST_INSTALL_UPDATE_LOG_PATH: testInstallUpdateLogPath,
      OUROBOROS_TEST_EXTERNAL_URL_LOG_PATH: testExternalUrlLogPath,
      OUROBOROS_TEST_BOOT_LOG_PATH: testBootLogPath,
      OUROBOROS_TEST_UPDATE_DOWNLOADED_PATH: testUpdateDownloadedPath,
      OUROBOROS_TEST_UPDATE_DOWNLOADED_DELAY_MS:
        options.updateDownloadedDelayMs != null ? String(options.updateDownloadedDelayMs) : undefined,
      OUROBOROS_TEST_USER_DATA_DIR: testUserDataDir,
      ...(options.env ?? {}),
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    paths: {
      scenarioPath: testScenarioPath,
      statePath: testStatePath,
      mockLogPath: testMockLogPath,
      installUpdateLogPath: testInstallUpdateLogPath,
      externalUrlLogPath: testExternalUrlLogPath,
      bootLogPath: testBootLogPath,
    },
  }
}

export async function clearClientState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.reload()
}

export async function completeOnboarding(
  page: Page,
  options: {
    apiKey?: string
    workspace?: string
    templateName?: 'Help me with a project' | 'Explore this codebase' | 'General assistant' | 'Let the agent evolve'
  } = {},
): Promise<void> {
  const apiKey = options.apiKey ?? 'sk-test-key'
  const workspace = options.workspace
  const templateName = options.templateName ?? 'Help me with a project'

  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible()
  await page.getByPlaceholder('sk-...').fill(apiKey)
  await page.getByRole('button', { name: 'Test Connection' }).click()
  await expect(page.getByText('Connected')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()

  if (workspace) {
    await expect(page.getByRole('heading', { name: 'Choose your workspace' })).toBeVisible()
    await page.getByText('Choose folder').click()
    await expect(page.getByText(workspace)).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()
  } else {
    await page.getByRole('button', { name: "I'll set this up later" }).click()
  }

  await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible()
  await page.getByText(templateName).click()
  await page.getByRole('button', { name: 'Get Started' }).click()
}

export async function setRpcOverride(
  page: Page,
  method: string,
  override: TestRpcOverride | null,
): Promise<void> {
  await page.evaluate(
    async ({ currentMethod, currentOverride }) => {
      const bridge = (window as typeof window & {
        __ouroborosTest: {
          setRpcOverride: (method: string, override: TestRpcOverride | null) => Promise<void>
        }
      }).__ouroborosTest
      await bridge.setRpcOverride(currentMethod, currentOverride)
    },
    { currentMethod: method, currentOverride: override },
  )
}

export async function clearRpcOverrides(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = (window as typeof window & {
      __ouroborosTest: { clearRpcOverrides: () => Promise<void> }
    }).__ouroborosTest
    await bridge.clearRpcOverrides()
  })
}

export async function emitNotification(
  page: Page,
  method: string,
  params?: unknown,
): Promise<void> {
  await page.evaluate(
    async ({ currentMethod, currentParams }) => {
      const bridge = (window as typeof window & {
        __ouroborosTest: {
          emitNotification: (method: string, params?: unknown) => Promise<void>
        }
      }).__ouroborosTest
      await bridge.emitNotification(currentMethod, currentParams)
    },
    { currentMethod: method, currentParams: params },
  )
}

export async function emitUpdateDownloaded(page: Page, version: string): Promise<void> {
  await page.evaluate(async (currentVersion) => {
    const bridge = (window as typeof window & {
      __ouroborosTest: { emitUpdateDownloaded: (version: string) => Promise<void> }
    }).__ouroborosTest
    await bridge.emitUpdateDownloaded(currentVersion)
  }, version)
}

export async function resetInstallUpdateCount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = (window as typeof window & {
      __ouroborosTest: { resetInstallUpdateCount: () => Promise<void> }
    }).__ouroborosTest
    await bridge.resetInstallUpdateCount()
  })
}

export async function getInstallUpdateCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const bridge = (window as typeof window & {
      __ouroborosTest: { getInstallUpdateCount: () => Promise<number> }
    }).__ouroborosTest
    return bridge.getInstallUpdateCount()
  })
}
