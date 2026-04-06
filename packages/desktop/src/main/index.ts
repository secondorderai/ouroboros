import { app, BrowserWindow, ipcMain, nativeTheme, Menu } from 'electron'
import { join } from 'path'
import Store from 'electron-store'
import { createWindowOptions, saveBounds, restoreMaximized } from './window'
import { CLIProcessManager } from './cli-process'
import { RpcClient } from './rpc-client'
import { registerIpcHandlers } from './ipc-handlers'
import type { Theme } from '../shared/protocol'

const store = new Store<{ theme: Theme }>()

let mainWindow: BrowserWindow | null = null
let cliProcess: CLIProcessManager | null = null
let rpcClient: RpcClient | null = null

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
    registerThemeIpcHandlers()

    // Initialize CLI process and RPC client
    const initialized = initializeCLI()
    cliProcess = initialized.cliProcess
    rpcClient = initialized.rpcClient

    createWindow()

    // Register IPC handlers for CLI bridge
    registerIpcHandlers({
      rpcClient,
      cliProcess,
      getMainWindow: () => mainWindow,
    })

    // Start the CLI child process
    cliProcess.start()

    // Run health check
    await performHealthCheck(cliProcess, rpcClient)

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
    onStderrLine: (line) => console.error(`[cli-stderr] ${line}`),
    onStatusChange: (status) => console.log(`[cli-status] ${status}`),
  })

  client.attach(cli)
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
    console.log('[main] CLI health check passed')
  } else {
    cli.markError()
    console.error('[main] CLI health check failed')
  }
}

// ── Window Creation ────────────────────────────────────────────────

function createWindow(): void {
  const options = createWindowOptions()

  mainWindow = new BrowserWindow({
    ...options,
    webPreferences: {
      ...options.webPreferences,
      preload: join(__dirname, '../preload/preload.mjs')
    }
  })

  restoreMaximized(mainWindow)

  mainWindow.on('ready-to-show', () => {
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
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        }]
      : []),
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
}
