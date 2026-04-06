/**
 * IPC Handlers
 *
 * Registers Electron IPC handlers that bridge between the renderer
 * process and the CLI via the JSON-RPC client. Also handles native
 * OS features (dialogs, theme, platform).
 */

import { ipcMain, dialog, nativeTheme, type BrowserWindow, type OpenDialogOptions } from 'electron'
import type { RpcClient } from './rpc-client'
import type { CLIProcessManager } from './cli-process'
import { IPC_CHANNELS, type CLIStatus, type NotificationMethod } from '../shared/protocol'

// ── Types ──────────────────────────────────────────────────────────

export interface IpcHandlerContext {
  rpcClient: RpcClient
  cliProcess: CLIProcessManager
  getMainWindow: () => BrowserWindow | null
}

// ── Register All Handlers ──────────────────────────────────────────

export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  registerRpcHandler(ctx)
  registerDialogHandlers()
  registerThemeHandlers()
  registerPlatformHandler()
  registerNotificationForwarding(ctx)
  registerCLIStatusForwarding(ctx)
}

// ── RPC Request Handler ────────────────────────────────────────────

/**
 * Handles 'ouroboros:rpc-request' from the renderer.
 * Forwards the request to the CLI via RpcClient and returns the result.
 */
function registerRpcHandler(ctx: IpcHandlerContext): void {
  ipcMain.handle(
    IPC_CHANNELS.RPC_REQUEST,
    async (_event, method: string, params?: Record<string, unknown>) => {
      try {
        const result = await ctx.rpcClient.send(method, params)
        return { ok: true, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const name = error instanceof Error ? error.name : 'Error'
        return { ok: false, error: { name, message } }
      }
    },
  )
}

// ── Dialog Handlers ────────────────────────────────────────────────

function registerDialogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHOW_OPEN_DIALOG,
    async (_event, options: OpenDialogOptions) => {
      const result = await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    },
  )
}

// ── Theme Handlers ─────────────────────────────────────────────────

function registerThemeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GET_THEME, () => {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })

  ipcMain.handle(IPC_CHANNELS.SET_THEME, (_event, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
  })
}

// ── Platform Handler ───────────────────────────────────────────────

function registerPlatformHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GET_PLATFORM, () => {
    return process.platform as 'darwin' | 'win32'
  })
}

// ── Notification Forwarding ────────────────────────────────────────

/**
 * Forward all CLI notifications to the renderer via IPC.
 * Subscribes to each known notification method on the RPC client
 * and sends them to all renderer windows.
 */
function registerNotificationForwarding(ctx: IpcHandlerContext): void {
  const notificationMethods: NotificationMethod[] = [
    'agent/text',
    'agent/toolCallStart',
    'agent/toolCallEnd',
    'agent/turnComplete',
    'agent/error',
    'agent/thinking',
    'agent/status',
    'memory/updated',
    'skill/activated',
    'approval/request',
  ]

  for (const method of notificationMethods) {
    ctx.rpcClient.onNotification(method, (params) => {
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.CLI_NOTIFICATION, method, params)
      }
    })
  }
}

// ── CLI Status Forwarding ──────────────────────────────────────────

/**
 * Forward CLI status changes to the renderer via IPC.
 */
function registerCLIStatusForwarding(ctx: IpcHandlerContext): void {
  ctx.cliProcess.on('status', (status: CLIStatus) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLI_STATUS, status)
    }
  })
}
