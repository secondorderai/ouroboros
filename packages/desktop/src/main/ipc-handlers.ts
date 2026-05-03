/**
 * IPC Handlers
 *
 * Registers Electron IPC handlers that bridge between the renderer
 * process and the CLI via the JSON-RPC client. Theme and platform
 * handlers are registered separately in index.ts (via electron-store).
 */

import { ipcMain, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { basename, dirname, extname } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type Store from 'electron-store'
import type { RpcClient } from './rpc-client'
import type { CLIProcessManager } from './cli-process'
import {
  IPC_CHANNELS,
  type CLIStatus,
  type CLIStatusEvent,
  type ImageAttachment,
  type ImageAttachmentValidationResult,
  type NotificationMethod,
  type RegisterImagePathsResult,
  type SaveArtifactArgs,
  type SaveArtifactResult,
  type SupportedImageMediaType,
  type Theme,
} from '../shared/protocol'
import {
  TEST_DIALOG_RESPONSES_PATH,
  TEST_POLICY_RESPONSES_PATH,
  TEST_SAVE_ARTIFACT_LOG_PATH,
} from './test-paths'
import { RpcPolicyGate, type ShowConfirmation } from './rpc-policy'
import { ImageGrantStore } from './image-grant-store'

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
let policyResponsesQueue: boolean[] | null = null
let installUpdateCount = 0
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MEDIA_TYPES: Record<string, SupportedImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export interface IpcHandlerContext {
  rpcClient: RpcClient
  cliProcess: CLIProcessManager
  getMainWindow: () => BrowserWindow | null
  store: Store<{ theme: Theme; apiKeys?: Record<string, string> }>
}

export interface RegisteredIpcHandlers {
  policyGate: RpcPolicyGate
  imageGrants: ImageGrantStore
}

export function registerIpcHandlers(ctx: IpcHandlerContext): RegisteredIpcHandlers {
  const imageGrants = new ImageGrantStore()
  const policyGate = registerRpcHandler(ctx, imageGrants)
  registerDialogHandlers(ctx, imageGrants)
  registerArtifactSaveHandler()
  registerImageAttachmentHandlers(ctx, imageGrants)
  registerNotificationForwarding(ctx)
  registerCLIStatusForwarding(ctx)
  if (process.env.NODE_ENV === 'test') {
    registerTestHandlers(ctx)
  }
  return { policyGate, imageGrants }
}

function registerRpcHandler(ctx: IpcHandlerContext, imageGrants: ImageGrantStore): RpcPolicyGate {
  const showConfirmation = createShowConfirmation()
  const policyGate = new RpcPolicyGate({
    rpcClient: ctx.rpcClient,
    getMainWindow: ctx.getMainWindow,
    showConfirmation,
    imageGrants,
    log: (message) => console.warn(message),
  })
  policyGate.attachApprovalSubscription()

  ipcMain.handle(
    IPC_CHANNELS.RPC_REQUEST,
    async (event, method: string, params?: Record<string, unknown>) => {
      try {
        const decision = await policyGate.evaluate(event, method, params)
        if (!decision.ok) {
          return decision
        }

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

        // Keep the legacy electron-store copy for existing UI state only. The CLI
        // persists API keys to .ouroboros and reloads that file on respawn.
        if (method === 'config/setApiKey' && params) {
          const provider = params.provider as string
          const apiKey = params.apiKey as string
          if (provider && apiKey) {
            const apiKeys = ctx.store.get('apiKeys', {})
            apiKeys[provider] = apiKey
            ctx.store.set('apiKeys', apiKeys)
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

  return policyGate
}

function createShowConfirmation(): ShowConfirmation {
  return async ({ windowOwner, title, message, detail }) => {
    const override = consumePolicyResponse()
    if (override !== undefined) {
      return override
    }
    const options = {
      type: 'warning' as const,
      title,
      message,
      detail,
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
    const result =
      windowOwner && !windowOwner.isDestroyed()
        ? await dialog.showMessageBox(windowOwner, options)
        : await dialog.showMessageBox(options)
    return result.response === 0
  }
}

function consumePolicyResponse(): boolean | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined

  if (policyResponsesQueue === null) {
    const raw = process.env.OUROBOROS_TEST_POLICY_RESPONSES ?? readTestPolicyResponses()
    if (!raw) {
      policyResponsesQueue = []
    } else {
      try {
        const parsed = JSON.parse(raw) as Array<boolean>
        policyResponsesQueue = Array.isArray(parsed)
          ? parsed.filter((value): value is boolean => typeof value === 'boolean')
          : []
      } catch {
        policyResponsesQueue = []
      }
    }
  }

  // In test mode, when the explicit response queue is exhausted, default to
  // "allow" so existing E2E tests that don't explicitly opt into the gate
  // (e.g. onboarding flows that now trigger Layer 2 prompts) continue to
  // work. Tests that want to verify denial populate `policyResponses` with
  // specific boolean values.
  if (policyResponsesQueue.length === 0) return true
  return policyResponsesQueue.shift()
}

function readTestPolicyResponses(): string | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined
  try {
    return readFileSync(TEST_POLICY_RESPONSES_PATH, 'utf8')
  } catch {
    return undefined
  }
}

function registerDialogHandlers(ctx: IpcHandlerContext, imageGrants: ImageGrantStore): void {
  ipcMain.handle(IPC_CHANNELS.SHOW_OPEN_DIALOG, async (event, options: OpenDialogOptions) => {
    const override = consumeDialogResponse()
    let paths: string[]
    if (override !== undefined) {
      if (override === null) return null
      paths = Array.isArray(override) ? override : [override]
    } else {
      const result = await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      paths = result.filePaths
    }

    // Auto-grant image-extension paths produced by a native dialog. The
    // dialog already represents direct user intent, so the grant store
    // skips the magic-byte/size pre-check here for UX (the existing
    // validate handler still verifies before reading).
    const imageCandidates = paths.filter((path) => isPotentialImagePath(path))
    if (imageCandidates.length > 0) {
      imageGrants.grant(findOwningWindow(ctx, event), imageCandidates)
    }

    if (options.properties?.includes('multiSelections')) {
      return paths
    }
    return paths[0]
  })
}

function isPotentialImagePath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  return Boolean(IMAGE_MEDIA_TYPES[extname(path).toLowerCase()])
}

function findOwningWindow(ctx: IpcHandlerContext, event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  const main = ctx.getMainWindow()
  if (main && !main.isDestroyed() && main.webContents.id === event.sender.id) {
    return main
  }
  return null
}

function sanitizeArtifactFilename(name: string): string {
  const trimmed = name.trim().toLowerCase()
  const replaced = trimmed.replace(/\s+/g, '-').replace(/[^a-z0-9._-]+/g, '')
  const stripped = replaced.replace(/^[.-]+/, '')
  return stripped.length > 0 ? stripped : 'artifact'
}

function registerArtifactSaveHandler(): void {
  ipcMain.handle(
    IPC_CHANNELS.SAVE_ARTIFACT,
    async (_event, args: SaveArtifactArgs): Promise<SaveArtifactResult> => {
      if (
        !args ||
        typeof args.html !== 'string' ||
        typeof args.defaultName !== 'string' ||
        args.defaultName.trim().length === 0
      ) {
        recordSaveArtifact({ saved: false, reason: 'invalid-args' })
        throw new Error('saveArtifact: html and defaultName are required')
      }

      const baseName = sanitizeArtifactFilename(args.defaultName)
      const defaultFilename = baseName.endsWith('.html') ? baseName : `${baseName}.html`

      const override = consumeDialogResponse()
      let chosenPath: string | null
      if (override !== undefined) {
        chosenPath = typeof override === 'string' ? override : null
      } else {
        const result = await dialog.showSaveDialog({
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML', extensions: ['html'] }],
        })
        chosenPath = result.canceled || !result.filePath ? null : result.filePath
      }

      if (!chosenPath) {
        recordSaveArtifact({ saved: false, reason: 'cancelled' })
        return { saved: false }
      }

      try {
        writeFileSync(chosenPath, args.html, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        recordSaveArtifact({ saved: false, reason: message, path: chosenPath })
        throw new Error(`Failed to write artifact: ${message}`)
      }

      recordSaveArtifact({ saved: true, path: chosenPath, bytes: args.html.length })
      return { saved: true, path: chosenPath }
    },
  )
}

function recordSaveArtifact(record: Record<string, unknown>): void {
  const logPath =
    process.env.OUROBOROS_TEST_SAVE_ARTIFACT_LOG_PATH ??
    (process.env.NODE_ENV === 'test' ? TEST_SAVE_ARTIFACT_LOG_PATH : undefined)
  if (!logPath) return
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, JSON.stringify(record) + '\n')
}

function registerImageAttachmentHandlers(
  ctx: IpcHandlerContext,
  imageGrants: ImageGrantStore,
): void {
  ipcMain.handle(
    IPC_CHANNELS.VALIDATE_IMAGE_ATTACHMENTS,
    async (event, paths: unknown): Promise<ImageAttachmentValidationResult> => {
      if (!Array.isArray(paths)) {
        return {
          accepted: [],
          rejected: [{ path: '', reason: 'Image attachment paths must be an array' }],
        }
      }

      const window = findOwningWindow(ctx, event)
      const accepted: ImageAttachment[] = []
      const rejected: ImageAttachmentValidationResult['rejected'] = []
      const seen = new Set<string>()

      for (const path of paths) {
        if (typeof path !== 'string' || path.trim().length === 0) {
          rejected.push({ path: String(path ?? ''), reason: 'Path must be a non-empty string' })
          continue
        }
        if (seen.has(path)) continue
        seen.add(path)

        if (!imageGrants.has(window, path)) {
          rejected.push({
            path,
            reason: 'Path is not authorised — attach via the file picker or drop it onto the chat area',
          })
          continue
        }

        const result = readImageAttachment(path)
        if ('reason' in result) {
          rejected.push(result)
        } else {
          accepted.push(result)
        }
      }

      return { accepted, rejected }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.REGISTER_DROPPED_IMAGE_PATHS,
    async (event, paths: unknown): Promise<RegisterImagePathsResult> => {
      return runRegisterHandler(ctx, imageGrants, event, paths)
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.REGISTER_SESSION_IMAGE_PATHS,
    async (event, paths: unknown): Promise<RegisterImagePathsResult> => {
      return runRegisterHandler(ctx, imageGrants, event, paths)
    },
  )
}

function runRegisterHandler(
  ctx: IpcHandlerContext,
  imageGrants: ImageGrantStore,
  event: Electron.IpcMainInvokeEvent,
  paths: unknown,
): RegisterImagePathsResult {
  if (!Array.isArray(paths)) {
    return {
      granted: [],
      rejected: [{ path: '', reason: 'Image attachment paths must be an array' }],
    }
  }
  const window = findOwningWindow(ctx, event)
  return imageGrants.grant(window, paths)
}

function readImageAttachment(path: string): ImageAttachment | { path: string; reason: string } {
  const mediaType = mediaTypeForPath(path)
  if (!mediaType) {
    return { path, reason: 'Supported image formats are JPG, PNG, and WebP' }
  }

  try {
    const stats = statSync(path)
    if (!stats.isFile()) {
      return { path, reason: 'Path is not a file' }
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      return { path, reason: 'Image is larger than 20 MB' }
    }

    const data = readFileSync(path)
    return {
      path,
      name: basename(path),
      mediaType,
      sizeBytes: stats.size,
      previewDataUrl: `data:${mediaType};base64,${data.toString('base64')}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { path, reason: `Could not read image: ${message}` }
  }
}

function mediaTypeForPath(path: string): SupportedImageMediaType | null {
  return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? null
}

function registerNotificationForwarding(ctx: IpcHandlerContext): void {
  const notificationMethods: NotificationMethod[] = [
    'agent/contextUsage',
    'agent/text',
    'agent/toolCallStart',
    'agent/toolCallEnd',
    'agent/turnComplete',
    'agent/error',
    'agent/steerInjected',
    'agent/steerOrphaned',
    'agent/turnAborted',
    'agent/thinking',
    'agent/status',
    'agent/subagentStarted',
    'agent/subagentUpdated',
    'agent/subagentCompleted',
    'agent/subagentFailed',
    'agent/permissionLeaseUpdated',
    'team/graphOpen',
    'team/graphUpdated',
    'memory/updated',
    'skill/activated',
    'approval/request',
    'askUser/request',
    'rsi/reflection',
    'rsi/crystallization',
    'rsi/dream',
    'rsi/error',
    'rsi/runtime',
    'mode/entered',
    'mode/exited',
    'mode/planSubmitted',
    'agent/artifactCreated',
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
  ctx.cliProcess.on('status', (event: CLIStatusEvent) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLI_STATUS, event)
    }
  })

  // Replay-on-subscribe: the renderer asks for the status history when its
  // `onCLIStatus` listener attaches, so transitions that fired before the
  // renderer mounted (very common: CLI reaches `ready` ~1 s before React
  // finishes its first paint) still reach the subscriber. The seq numbers
  // let the renderer dedupe against any live events delivered in parallel.
  ipcMain.handle(IPC_CHANNELS.CLI_STATUS_HISTORY, (): CLIStatusEvent[] => {
    return ctx.cliProcess.getStatusHistory()
  })
}

function registerTestHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle(
    TEST_IPC_CHANNELS.SET_RPC_OVERRIDE,
    (_event, method: string, override: TestRpcOverride | null) => {
      if (override == null) {
        rpcOverrides.delete(method)
      } else {
        rpcOverrides.set(method, override)
      }
    },
  )

  ipcMain.handle(TEST_IPC_CHANNELS.CLEAR_RPC_OVERRIDES, () => {
    rpcOverrides.clear()
  })

  ipcMain.handle(
    TEST_IPC_CHANNELS.EMIT_NOTIFICATION,
    (_event, method: string, params?: unknown) => {
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.CLI_NOTIFICATION, method, params)
      }
    },
  )

  // Test-only synthetic CLI status emit. Real emits go through CLIProcessManager
  // which assigns a sequence number, so wrap the raw `status` in a payload that
  // matches the CLIStatusEvent shape the renderer expects. Use a high seq to
  // avoid colliding with the real history (renderers dedupe by seq).
  let testStatusSeq = 1_000_000
  ipcMain.handle(TEST_IPC_CHANNELS.EMIT_CLI_STATUS, (_event, status: CLIStatus) => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      testStatusSeq += 1
      win.webContents.send(IPC_CHANNELS.CLI_STATUS, { seq: testStatusSeq, status })
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
