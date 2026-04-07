/**
 * IPC Handlers
 *
 * Registers Electron IPC handlers that bridge between the renderer
 * process and the CLI via the JSON-RPC client. Theme and platform
 * handlers are registered separately in index.ts (via electron-store).
 */

import { ipcMain, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import type Store from 'electron-store'
import type { RpcClient } from './rpc-client'
import type { CLIProcessManager } from './cli-process'
import { IPC_CHANNELS, type CLIStatus, type NotificationMethod, type Theme } from '../shared/protocol'

export interface IpcHandlerContext {
  rpcClient: RpcClient
  cliProcess: CLIProcessManager
  getMainWindow: () => BrowserWindow | null
  store: Store<{ theme: Theme; apiKeys?: Record<string, string> }>
}

export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  registerRpcHandler(ctx)
  registerDialogHandlers()
  registerNotificationForwarding(ctx)
  registerCLIStatusForwarding(ctx)
}

function registerRpcHandler(ctx: IpcHandlerContext): void {
  ipcMain.handle(
    IPC_CHANNELS.RPC_REQUEST,
    async (_event, method: string, params?: Record<string, unknown>) => {
      try {
        const result = await ctx.rpcClient.send(method, params)

        // Persist API keys to electron-store so they survive restarts
        if (method === 'config/setApiKey' && params) {
          const provider = params.provider as string
          const apiKey = params.apiKey as string
          if (provider && apiKey) {
            const apiKeys = ctx.store.get('apiKeys', {})
            apiKeys[provider] = apiKey
            ctx.store.set('apiKeys', apiKeys)
            // Update env vars for future CLI respawns
            ctx.cliProcess.setExtraEnv({ ...getApiKeyEnv(apiKeys) })
          }
        }

        return { ok: true, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const name = error instanceof Error ? error.name : 'Error'
        return { ok: false, error: { name, message } }
      }
    },
  )
}

function getApiKeyEnv(apiKeys: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  if (apiKeys.anthropic) env.ANTHROPIC_API_KEY = apiKeys.anthropic
  if (apiKeys.openai) env.OPENAI_API_KEY = apiKeys.openai
  if (apiKeys['openai-compatible']) env.OPENAI_API_KEY = apiKeys['openai-compatible']
  return env
}

function registerDialogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHOW_OPEN_DIALOG,
    async (_event, options: OpenDialogOptions) => {
      const result = await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      // Return all paths when multiSelections is requested, single path otherwise
      if (options.properties?.includes('multiSelections')) {
        return result.filePaths
      }
      return result.filePaths[0]
    },
  )
}

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

function registerCLIStatusForwarding(ctx: IpcHandlerContext): void {
  ctx.cliProcess.on('status', (status: CLIStatus) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLI_STATUS, status)
    }
  })
}
