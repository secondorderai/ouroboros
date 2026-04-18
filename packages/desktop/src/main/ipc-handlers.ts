/**
 * IPC Handlers
 *
 * Registers Electron IPC handlers that bridge between the renderer
 * process and the CLI via the JSON-RPC client. Theme and platform
 * handlers are registered separately in index.ts (via electron-store).
 */

import { ipcMain, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { readFileSync } from 'node:fs'
import type Store from 'electron-store'
import type { RpcClient } from './rpc-client'
import type { CLIProcessManager } from './cli-process'
import { IPC_CHANNELS, type CLIStatus, type NotificationMethod, type Theme } from '../shared/protocol'
import { TEST_DIALOG_RESPONSES_PATH } from './test-paths'

const TEST_IPC_CHANNELS = {
  SET_RPC_OVERRIDE: 'ouroboros:test:set-rpc-override',
  CLEAR_RPC_OVERRIDES: 'ouroboros:test:clear-rpc-overrides',
  EMIT_NOTIFICATION: 'ouroboros:test:emit-notification',
  EMIT_CLI_STATUS: 'ouroboros:test:emit-cli-status',
  EMIT_UPDATE_DOWNLOADED: 'ouroboros:test:emit-update-downloaded',
  GET_INSTALL_UPDATE_COUNT: 'ouroboros:test:get-install-update-count',
  RESET_INSTALL_UPDATE_COUNT: 'ouroboros:test:reset-install-update-count',
} as const

interface TestRpcOverride {
  ok: boolean
  result?: unknown
  error?: {
    name?: string
    message?: string
  }
}

const rpcOverrides = new Map<string, TestRpcOverride>()
let dialogResponsesQueue: Array<string | string[] | null> | null = null
let installUpdateCount = 0

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
  if (process.env.NODE_ENV === 'test') {
    registerTestHandlers(ctx)
  }
}

function registerRpcHandler(ctx: IpcHandlerContext): void {
  ipcMain.handle(
    IPC_CHANNELS.RPC_REQUEST,
    async (_event, method: string, params?: Record<string, unknown>) => {
      try {
        const override = process.env.NODE_ENV === 'test' ? rpcOverrides.get(method) : undefined
        if (override) {
          if (override.ok) {
            return { ok: true, result: override.result }
          }
          return {
            ok: false,
            error: {
              name: override.error?.name ?? 'Error',
              message: override.error?.message ?? 'Mock RPC error',
            },
          }
        }

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
  if (apiKeys['openai-compatible']) {
    env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = apiKeys['openai-compatible']
  }
  return env
}

function registerDialogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHOW_OPEN_DIALOG,
    async (_event, options: OpenDialogOptions) => {
      const override = consumeDialogResponse()
      if (override !== undefined) {
        return override
      }
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
    'agent/contextUsage',
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
    'rsi/reflection',
    'rsi/crystallization',
    'rsi/dream',
    'rsi/error',
    'rsi/runtime',
    'mode/entered',
    'mode/exited',
    'mode/planSubmitted',
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

function registerTestHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle(TEST_IPC_CHANNELS.SET_RPC_OVERRIDE, (_event, method: string, override: TestRpcOverride | null) => {
    if (override == null) {
      rpcOverrides.delete(method)
    } else {
      rpcOverrides.set(method, override)
    }
  })

  ipcMain.handle(TEST_IPC_CHANNELS.CLEAR_RPC_OVERRIDES, () => {
    rpcOverrides.clear()
  })

  ipcMain.handle(TEST_IPC_CHANNELS.EMIT_NOTIFICATION, (_event, method: string, params?: unknown) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLI_NOTIFICATION, method, params)
    }
  })

  ipcMain.handle(TEST_IPC_CHANNELS.EMIT_CLI_STATUS, (_event, status: CLIStatus) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLI_STATUS, status)
    }
  })

  ipcMain.handle(TEST_IPC_CHANNELS.EMIT_UPDATE_DOWNLOADED, (_event, version: string) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:downloaded', version)
    }
  })

  ipcMain.handle(TEST_IPC_CHANNELS.GET_INSTALL_UPDATE_COUNT, () => installUpdateCount)
  ipcMain.handle(TEST_IPC_CHANNELS.RESET_INSTALL_UPDATE_COUNT, () => {
    installUpdateCount = 0
  })
}

function consumeDialogResponse(): string | string[] | null | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined

  if (dialogResponsesQueue === null) {
    const raw = process.env.OUROBOROS_TEST_DIALOG_RESPONSES ?? readTestDialogResponses()
    if (!raw) {
      dialogResponsesQueue = []
    } else {
      try {
        const parsed = JSON.parse(raw) as Array<string | string[] | null>
        dialogResponsesQueue = Array.isArray(parsed) ? [...parsed] : []
      } catch {
        dialogResponsesQueue = []
      }
    }
  }

  if (dialogResponsesQueue.length === 0) return undefined
  return dialogResponsesQueue.shift()
}

function readTestDialogResponses(): string | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined
  try {
    return readFileSync(TEST_DIALOG_RESPONSES_PATH, 'utf8')
  } catch {
    return undefined
  }
}

export function recordInstallUpdateRequest(): void {
  installUpdateCount += 1
}
