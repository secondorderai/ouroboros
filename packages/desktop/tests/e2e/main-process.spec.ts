import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import type { LaunchedApp } from './helpers'
import { completeOnboarding, launchTestApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('main process exposes the Ouroboros app name in development launches', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)

  await expect.poll(async () => {
    return launched!.app.evaluate(({ app }) => app.getName())
  }).toBe('Ouroboros')
})

test('renderer can observe CLI ready status and round-trip a JSON-RPC request through the main process', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)

  await launched.page.evaluate(() => {
    const target = window as typeof window & { __cliStatuses?: string[] }
    target.__cliStatuses = []
    window.ouroboros.onCLIStatus((status) => {
      target.__cliStatuses?.push(status)
    })
  })

  await expect.poll(async () => {
    return launched!.page.evaluate(() => {
      const target = window as typeof window & { __cliStatuses?: string[] }
      return target.__cliStatuses?.includes('ready') ?? false
    })
  }).toBe(true)

  const config = await launched.page.evaluate(() => window.ouroboros.rpc('config/get', {}))
  expect(config).toMatchObject({
    model: {
      provider: 'anthropic',
    },
  })
})

test('main process does not inject stale stored API keys into CLI environment', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    userDataConfig: {
      apiKeys: {
        'openai-compatible': 'stale-key-from-electron-store',
      },
    },
  })

  await expect.poll(async () => launched!.app.evaluate(({ app }) => app.getName())).toBe('Ouroboros')

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"hasOpenAICompatibleApiKey":false')
})

test('main process launches the CLI from a writable desktop runtime directory', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  const runtimeDir = realpathSync(launched.paths.userDataDir)

  await expect.poll(async () => readFile(launched!.paths.mockLogPath, 'utf8')).toContain(
    `"cwd":"${runtimeDir}"`,
  )

  const bootLog = await readFile(launched.paths.bootLogPath, 'utf8')
  expect(bootLog).toContain(`cwd=${launched.paths.userDataDir}`)
})

test('the main process reports restarting when the CLI crashes and recovers on the next spawn', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      launchBehavior: {
        '1': { exitAfterMs: 900 },
      },
    },
  })

  await launched.page.evaluate(() => {
    const target = window as typeof window & { __cliStatuses?: string[] }
    target.__cliStatuses = []
    window.ouroboros.onCLIStatus((status) => {
      target.__cliStatuses?.push(status)
    })
  })

  await expect.poll(async () => {
    return launched!.page.evaluate(() => {
      const target = window as typeof window & { __cliStatuses?: string[] }
      return {
        hasRestarting: target.__cliStatuses?.includes('restarting') ?? false,
        readyCount: target.__cliStatuses?.filter((status) => status === 'ready').length ?? 0,
      }
    })
  }).toEqual({ hasRestarting: true, readyCount: 2 })

  const config = await launched.page.evaluate(() => window.ouroboros.rpc('config/get', {}))
  expect(config).toMatchObject({
    permissions: {
      tier0: true,
    },
  })
})

test('the main process surfaces an error status after repeated CLI crashes', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      launchBehavior: {
        '1': { exitAfterMs: 50 },
        '2': { exitAfterMs: 50 },
        '3': { exitAfterMs: 50 },
        '4': { exitAfterMs: 50 },
      },
    },
  })

  await launched.page.evaluate(() => {
    const target = window as typeof window & { __cliStatuses?: string[] }
    target.__cliStatuses = []
    window.ouroboros.onCLIStatus((status) => {
      target.__cliStatuses?.push(status)
    })
  })

  await expect.poll(async () => {
    return launched!.page.evaluate(() => {
      const target = window as typeof window & { __cliStatuses?: string[] }
      return target.__cliStatuses?.includes('error') ?? false
    })
  }, { timeout: 10_000 }).toBe(true)
})

test('menu accelerator toggles the sidebar through the main-process menu wiring', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)

  await expect.poll(async () => {
    return launched!.page.evaluate(() => localStorage.getItem('ouroboros:sidebar-open'))
  }).toBe('true')

  await launched.app.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const toggleSidebarItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'View')
      ?.submenu?.items.find((item) => item.label === 'Toggle Sidebar')
    toggleSidebarItem?.click(undefined, win, undefined)
  })
  await expect.poll(async () => {
    return launched!.page.evaluate(() => localStorage.getItem('ouroboros:sidebar-open'))
  }).toBe('false')

  await launched.app.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const toggleSidebarItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'View')
      ?.submenu?.items.find((item) => item.label === 'Toggle Sidebar')
    toggleSidebarItem?.click(undefined, win, undefined)
  })
  await expect.poll(async () => {
    return launched!.page.evaluate(() => localStorage.getItem('ouroboros:sidebar-open'))
  }).toBe('true')
})

test('macOS app menu exposes check for updates below about', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)

  await launched.page.evaluate(() => {
    const target = window as typeof window & { __updateStatuses?: string[] }
    target.__updateStatuses = []
    window.electronAPI.onUpdateStatus((result) => {
      target.__updateStatuses?.push(result.status)
    })
  })

  const labels = await launched.app.evaluate(({ Menu }) => {
    return (
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === 'Ouroboros')
        ?.submenu?.items.map((item) => item.label || item.type) ?? []
    )
  })

  expect(labels.slice(0, 3)).toEqual(['About Ouroboros', 'Check for Updates...', 'separator'])

  await launched.app.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const checkForUpdatesItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'Ouroboros')
      ?.submenu?.items.find((item) => item.label === 'Check for Updates...')
    checkForUpdatesItem?.click(undefined, win, undefined)
  })

  await expect.poll(async () => {
    return launched!.page.evaluate(() => {
      const target = window as typeof window & { __updateStatuses?: string[] }
      return target.__updateStatuses?.includes('not-available') ?? false
    })
  }).toBe(true)
})
