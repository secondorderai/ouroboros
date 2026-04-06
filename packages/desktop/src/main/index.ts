/**
 * Electron Main Process Entry Point
 *
 * Bootstraps the application: creates the main window, spawns the CLI
 * child process, wires up the JSON-RPC client and IPC bridge, and
 * manages the application lifecycle.
 */

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { CLIProcessManager } from './cli-process'
import { RpcClient } from './rpc-client'
import { registerIpcHandlers } from './ipc-handlers'

// ── State ──────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let cliProcess: CLIProcessManager | null = null
let rpcClient: RpcClient | null = null

// ── Window Creation ────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // In development, load from Vite dev server; in production, load built files
  if (process.env.NODE_ENV === 'development') {
    const devUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  return win
}

// ── CLI Process & RPC Initialization ───────────────────────────────

function initializeCLI(): { cliProcess: CLIProcessManager; rpcClient: RpcClient } {
  const client = new RpcClient()

  const cli = new CLIProcessManager({
    onStdoutLine: (line) => client.handleLine(line),
    onStderrLine: (line) => console.error(`[cli-stderr] ${line}`),
    onStatusChange: (status) => console.log(`[cli-status] ${status}`),
  })

  // Attach the CLI process to the RPC client so it can write to stdin
  client.attach(cli)

  return { cliProcess: cli, rpcClient: client }
}

/**
 * Perform the initial health check after the CLI has been spawned.
 * Waits a short moment for the process to start, then sends a
 * config/get request.
 */
async function performHealthCheck(
  cli: CLIProcessManager,
  client: RpcClient,
): Promise<void> {
  // Give the CLI a moment to initialize
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

// ── Application Lifecycle ──────────────────────────────────────────

app.whenReady().then(async () => {
  // Initialize CLI process and RPC client
  const initialized = initializeCLI()
  cliProcess = initialized.cliProcess
  rpcClient = initialized.rpcClient

  // Create the main window
  mainWindow = createWindow()

  // Register IPC handlers (bridges renderer <-> CLI)
  registerIpcHandlers({
    rpcClient,
    cliProcess,
    getMainWindow: () => mainWindow,
  })

  // Start the CLI child process
  cliProcess.start()

  // Run health check
  await performHealthCheck(cliProcess, rpcClient)

  // Re-create window on macOS dock click
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

// ── Graceful Shutdown ──────────────────────────────────────────────

app.on('before-quit', async (event) => {
  if (cliProcess) {
    event.preventDefault()

    // Reject any pending RPC requests
    if (rpcClient) {
      rpcClient.rejectAll('Application is shutting down')
    }

    // Graceful shutdown of CLI process
    await cliProcess.shutdown()
    cliProcess = null

    // Now actually quit
    app.quit()
  }
})

app.on('window-all-closed', () => {
  // On macOS, apps typically stay open until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
