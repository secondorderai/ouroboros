import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, Menu, shell } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'fs'
import Store from 'electron-store'
import { createWindowOptions, saveBounds, restoreMaximized } from './window'
import { CLIProcessManager } from './cli-process'
import { RpcClient } from './rpc-client'
import { registerIpcHandlers } from './ipc-handlers'
import { handleInstallUpdate, initAutoUpdater } from './auto-updater'
import { initCrashRollback } from './crash-rollback'
import { writeTestLog } from './test-logging'
import { isSafeArtifactPath } from './artifact-paths'
import {
  registerArtifactProtocolHandler,
  registerArtifactProtocolScheme,
} from './artifact-protocol'
import {
  TEST_EXTERNAL_URL_LOG_PATH,
  TEST_OPEN_ARTIFACT_LOG_PATH,
  TEST_USER_DATA_DIR,
} from './test-paths'
import type { Theme } from '../shared/protocol'

const APP_NAME = 'Ouroboros'

app.setName(APP_NAME)

// Privileged scheme for embedding HTML artifacts in the renderer's iframe.
// Must be registered synchronously before app.whenReady() resolves.
registerArtifactProtocolScheme()

const hideTestWindow =
  process.env.NODE_ENV === 'test' && process.env.OUROBOROS_TEST_HIDE_WINDOW === '1'

if (process.env.NODE_ENV === 'test') {
  app.setPath('userData', TEST_USER_DATA_DIR)
}

const store = new Store<{ theme: Theme; apiKeys?: Record<string, string> }>()

let mainWindow: BrowserWindow | null = null
let cliProcess: CLIProcessManager | null = null
let rpcClient: RpcClient | null = null
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    writeTestLog('app.whenReady start')
    // Crash rollback runs first, before heavy init
    initCrashRollback()
    writeTestLog('crash rollback initialized')

    registerArtifactProtocolHandler()
    writeTestLog('artifact protocol registered')

    registerThemeIpcHandlers()
    writeTestLog('theme ipc registered')

    // Initialize CLI process and RPC client
    const initialized = initializeCLI()
    cliProcess = initialized.cliProcess
    rpcClient = initialized.rpcClient
    writeTestLog('cli initialized')

    applyDockIcon()
    writeTestLog('dock icon applied')

    createWindow()
    writeTestLog('window created')

    // Register IPC handlers for CLI bridge
    registerIpcHandlers({
      rpcClient,
      cliProcess,
      getMainWindow: () => mainWindow,
      store,
    })
    writeTestLog('ipc handlers registered')

    // Start the CLI child process
    cliProcess.start()
    writeTestLog('cli start requested')

    // Run health check
    await performHealthCheck(cliProcess, rpcClient)
    writeTestLog('health check completed')

    // Auto-updater after window is created so IPC events reach renderer
    initAutoUpdater()
    writeTestLog('auto updater initialized')

    // macOS: re-create window when dock icon is clicked
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Graceful shutdown of CLI process
app.on('before-quit', async (event) => {
  if (cliProcess) {
    event.preventDefault()
    if (rpcClient) rpcClient.rejectAll('Application is shutting down')
    await cliProcess.shutdown()
    cliProcess = null
    app.quit()
  }
})

// ── CLI Process & RPC Initialization ───────────────────────────────

function initializeCLI(): { cliProcess: CLIProcessManager; rpcClient: RpcClient } {
  const client = new RpcClient()

  const cli = new CLIProcessManager({
    onStdoutLine: (line) => client.handleLine(line),
    onStderrLine: (line) => writeTestLog(`[cli-stderr] ${line}`),
    onStatusChange: (status) => writeTestLog(`[cli-status] ${status}`),
  })

  client.attach(cli)
  cli.on('spawned', ({ restartCount }: { restartCount: number }) => {
    if (restartCount > 0) {
      void performHealthCheck(cli, client)
    }
  })
  writeTestLog('rpc client attached')
  return { cliProcess: cli, rpcClient: client }
}

async function performHealthCheck(
  cli: CLIProcessManager,
  client: RpcClient,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const healthy = await client.healthCheck()
  if (healthy) {
    cli.markReady()
    writeTestLog('[main] CLI health check passed')
  } else {
    cli.markError()
    writeTestLog('[main] CLI health check failed')
  }
}

// ── Window Creation ────────────────────────────────────────────────

function createWindow(): void {
  const options = createWindowOptions()
  const iconPath = getAppIconPath()

  mainWindow = new BrowserWindow({
    ...options,
    ...(iconPath && process.platform !== 'darwin' ? { icon: iconPath } : {}),
    webPreferences: {
      ...options.webPreferences,
      preload: join(__dirname, '../preload/preload.cjs')
    }
  })

  restoreMaximized(mainWindow)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  mainWindow.on('ready-to-show', () => {
    if (hideTestWindow) {
      writeTestLog('window ready-to-show skipped because OUROBOROS_TEST_HIDE_WINDOW=1')
      return
    }

    mainWindow?.show()
  })

  mainWindow.on('resized', () => { if (mainWindow) saveBounds(mainWindow) })
  mainWindow.on('moved', () => { if (mainWindow) saveBounds(mainWindow) })
  mainWindow.on('maximize', () => { if (mainWindow) saveBounds(mainWindow) })
  mainWindow.on('unmaximize', () => { if (mainWindow) saveBounds(mainWindow) })

  mainWindow.on('closed', () => { mainWindow = null })

  nativeTheme.on('updated', () => {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    mainWindow?.webContents.send('theme:nativeChanged', theme)
  })

  // Menu with Cmd/Ctrl+B sidebar toggle
  const isMac = process.platform === 'darwin'
  const menu = Menu.buildFromTemplate([
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        }]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => { mainWindow?.webContents.send('sidebar:toggle') }
        },
        { type: 'separator' as const },
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    }
  ])
  Menu.setApplicationMenu(menu)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getAppIconPath(): string | null {
  const candidatePaths = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(__dirname, '../../resources/icon.png')]

  return candidatePaths.find((path) => existsSync(path)) ?? null
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin') return

  const iconPath = getAppIconPath()
  if (!iconPath) return

  const icon = nativeImage.createFromPath(iconPath)
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon)
  }
}

// ── Theme IPC Handlers ─────────────────────────────────────────────

function registerThemeIpcHandlers(): void {
  ipcMain.handle('theme:get', (): Theme => {
    return store.get('theme', 'system')
  })

  ipcMain.handle('theme:set', (_event, theme: Theme) => {
    store.set('theme', theme)
  })

  ipcMain.handle('theme:getNative', () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  ipcMain.handle('platform:get', () => {
    return process.platform
  })

  ipcMain.on('shell:openExternal', (_event, url: string) => {
    openExternalUrl(url)
  })

  ipcMain.on('shell:openArtifact', (_event, rawPath: string) => {
    openArtifactPath(rawPath)
  })

  ipcMain.on('update:install', () => {
    handleInstallUpdate()
  })

  ipcMain.handle('app:getHomeDirectory', () => {
    return homedir()
  })

}

function openExternalUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl)
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      recordExternalUrl(rawUrl, false)
      console.error(`[main] Blocked external URL with unsupported protocol: ${rawUrl}`)
      return
    }
    recordExternalUrl(url.toString(), true)
    if (process.env.NODE_ENV === 'test') {
      return
    }
    shell.openExternal(url.toString())
  } catch {
    recordExternalUrl(rawUrl, false)
    console.error(`[main] Blocked invalid external URL: ${rawUrl}`)
  }
}

function recordExternalUrl(url: string, allowed: boolean): void {
  const logPath = process.env.OUROBOROS_TEST_EXTERNAL_URL_LOG_PATH ?? (
    process.env.NODE_ENV === 'test' ? TEST_EXTERNAL_URL_LOG_PATH : undefined
  )
  if (!logPath) return

  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, JSON.stringify({ url, allowed }) + '\n')
}

function openArtifactPath(rawPath: string): void {
  if (!isSafeArtifactPath(rawPath)) {
    recordOpenArtifact(rawPath, false, 'invalid-path')
    console.error(`[main] Blocked openArtifact for unsafe path: ${rawPath}`)
    return
  }

  try {
    const stats = statSync(rawPath)
    if (!stats.isFile()) {
      recordOpenArtifact(rawPath, false, 'not-a-file')
      console.error(`[main] openArtifact: not a file: ${rawPath}`)
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordOpenArtifact(rawPath, false, message)
    console.error(`[main] openArtifact stat failed: ${message}`)
    return
  }

  recordOpenArtifact(rawPath, true)
  if (process.env.NODE_ENV === 'test') return
  void shell.openPath(rawPath).then((errorMessage) => {
    if (errorMessage) {
      console.error(`[main] shell.openPath failed: ${errorMessage}`)
    }
  })
}

function recordOpenArtifact(path: string, allowed: boolean, reason?: string): void {
  const logPath = process.env.OUROBOROS_TEST_OPEN_ARTIFACT_LOG_PATH ?? (
    process.env.NODE_ENV === 'test' ? TEST_OPEN_ARTIFACT_LOG_PATH : undefined
  )
  if (!logPath) return
  mkdirSync(dirname(logPath), { recursive: true })
  const record: Record<string, unknown> = { path, allowed }
  if (reason) record.reason = reason
  appendFileSync(logPath, JSON.stringify(record) + '\n')
}
