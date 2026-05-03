/**
 * RPC Policy Gate
 *
 * Main-process authorization boundary for renderer → CLI JSON-RPC calls.
 * Sits between `ipcMain.handle(IPC_CHANNELS.RPC_REQUEST, …)` and
 * `RpcClient.send(...)`. Without this gate, any renderer compromise
 * (e.g. a Mermaid SVG XSS) can silently invoke `approval/respond`,
 * `workspace/set`, `config/setApiKey`, etc. and gain CLI capabilities.
 *
 * Three layers:
 *
 *   1. Universal (every call):
 *      - method must be in `RPC_METHOD_NAMES`
 *      - sender must be the top frame (no sub-frames / artifact iframe)
 *      - params must be a plain object or undefined
 *
 *   2. Sensitive (first-call-per-window prompt, then trusted for the
 *      lifetime of that BrowserWindow): `workspace/set`, `workspace/clear`,
 *      `config/setApiKey`, `session/delete`, `mcp/restart`, and
 *      `config/set` when the path touches a sensitive subtree
 *      (model.*, mcp.*, workspace.*, auth.*, anything containing apiKey).
 *
 *   3. Critical (`approval/respond`): native confirmation when the
 *      cached `approval/request` had `risk: 'high'`; medium/low pass
 *      through Layer 1.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { RpcClient } from './rpc-client'
import {
  RPC_METHOD_NAMES,
  RPC_RISK_CLASSES,
  type ApprovalRequestNotification,
  type RpcMethod,
} from '../shared/protocol'
import type { ImageGrantStore } from './image-grant-store'

const RPC_METHOD_SET = new Set<string>(RPC_METHOD_NAMES)

export interface ConfirmationRequest {
  windowOwner: BrowserWindow | null
  title: string
  message: string
  detail?: string
}

export type ShowConfirmation = (request: ConfirmationRequest) => Promise<boolean>

export type PolicyResult =
  | { ok: true }
  | { ok: false; error: { name: 'PolicyError'; message: string } }

export interface RpcPolicyGateOptions {
  rpcClient: RpcClient
  getMainWindow: () => BrowserWindow | null
  showConfirmation: ShowConfirmation
  /**
   * Optional grant store consulted for `agent/run` and `agent/steer` image
   * paths. When omitted, image params bypass the gate (used by tests that
   * exercise non-image RPC behavior).
   */
  imageGrants?: ImageGrantStore
  log?: (message: string) => void
}

export class RpcPolicyGate {
  private readonly perWindowConfirmed = new WeakMap<BrowserWindow, Set<string>>()
  private readonly approvalRiskById = new Map<string, 'high' | 'medium' | 'low'>()
  private readonly options: RpcPolicyGateOptions
  private approvalUnsubscribe: (() => void) | null = null

  constructor(options: RpcPolicyGateOptions) {
    this.options = options
  }

  attachApprovalSubscription(): void {
    if (this.approvalUnsubscribe) return
    this.approvalUnsubscribe = this.options.rpcClient.onNotification(
      'approval/request',
      (params: ApprovalRequestNotification) => {
        if (params && typeof params.id === 'string') {
          this.approvalRiskById.set(params.id, params.risk ?? 'low')
        }
      },
    )
  }

  detach(): void {
    this.approvalUnsubscribe?.()
    this.approvalUnsubscribe = null
  }

  forgetWindow(window: BrowserWindow): void {
    this.perWindowConfirmed.delete(window)
    this.options.imageGrants?.forget(window)
  }

  async evaluate(
    event: IpcMainInvokeEvent,
    method: string,
    params: unknown,
  ): Promise<PolicyResult> {
    if (!RPC_METHOD_SET.has(method)) {
      return this.deny('unknown', `unknown method "${method}"`)
    }
    const typedMethod = method as RpcMethod

    const senderFrame = event.senderFrame
    if (!senderFrame) {
      return this.deny(typedMethod, 'sender frame is unavailable')
    }
    if (senderFrame.parent !== null) {
      return this.deny(typedMethod, 'sub-frames cannot invoke RPC')
    }

    if (
      params !== undefined &&
      (params === null || typeof params !== 'object' || Array.isArray(params))
    ) {
      return this.deny(typedMethod, 'params must be an object or undefined')
    }

    const window = this.findOwningWindow(event)

    // Image attachment paths must be grant-store authorised before any
    // method that ultimately reads them. This is independent of the risk
    // class because both `agent/run` (sensitive-ish) and `agent/steer`
    // (write-low) accept image paths.
    if (typedMethod === 'agent/run' || typedMethod === 'agent/steer') {
      const imageDecision = this.gateImageAttachments(typedMethod, params, window)
      if (!imageDecision.ok) return imageDecision
    }

    const risk = RPC_RISK_CLASSES[typedMethod]
    if (risk === 'read' || risk === 'write-low') {
      return { ok: true }
    }

    if (risk === 'sensitive') {
      return this.gateSensitive(typedMethod, params, window)
    }
    if (risk === 'critical') {
      return this.gateCritical(typedMethod, params, window)
    }

    // Defense-in-depth: an unhandled risk class is treated as deny.
    return this.deny(typedMethod, `unhandled risk class "${String(risk)}"`)
  }

  private gateImageAttachments(
    method: RpcMethod,
    params: unknown,
    window: BrowserWindow | null,
  ): PolicyResult {
    if (!params || typeof params !== 'object') return { ok: true }
    const images = (params as Record<string, unknown>).images
    if (images === undefined) return { ok: true }
    if (!Array.isArray(images)) {
      return this.deny(method, 'params.images must be an array')
    }
    if (!this.options.imageGrants) {
      // No grant store wired — fail closed when images are present so we
      // never silently let renderer-claimed paths through to the CLI.
      return this.deny(method, 'image grant store is not configured')
    }
    for (let i = 0; i < images.length; i++) {
      const entry = images[i]
      if (!entry || typeof entry !== 'object') {
        return this.deny(method, `params.images[${i}] must be an object`)
      }
      const path = (entry as Record<string, unknown>).path
      if (typeof path !== 'string' || path.length === 0) {
        return this.deny(method, `params.images[${i}].path must be a non-empty string`)
      }
      if (!this.options.imageGrants.has(window, path)) {
        return this.deny(method, `params.images[${i}].path is not authorised by main grant store`)
      }
    }
    return { ok: true }
  }

  private async gateSensitive(
    method: RpcMethod,
    params: unknown,
    window: BrowserWindow | null,
  ): Promise<PolicyResult> {
    const qualifier = this.sensitiveQualifier(method, params)
    if (qualifier === null) {
      // config/set with a non-sensitive path (e.g. theme) does not need a prompt.
      return { ok: true }
    }

    const cacheKey = qualifier === 'method' ? method : `${method}:${qualifier}`
    const confirmed = this.confirmedSet(window)
    if (confirmed && confirmed.has(cacheKey)) {
      return { ok: true }
    }

    const allowed = await this.options.showConfirmation({
      windowOwner: window,
      title: 'Confirm sensitive action',
      message: this.summarize(method, params),
      detail:
        'Confirm to allow this action for the rest of this window session. Cancel if you did not initiate it.',
    })
    if (!allowed) {
      return this.deny(method, 'user cancelled the confirmation prompt')
    }
    if (confirmed) {
      confirmed.add(cacheKey)
    }
    return { ok: true }
  }

  private async gateCritical(
    method: RpcMethod,
    params: unknown,
    window: BrowserWindow | null,
  ): Promise<PolicyResult> {
    if (method !== 'approval/respond') {
      return { ok: true }
    }
    const id = readStringField(params, 'id')
    if (!id) {
      return this.deny(method, 'approval id is required')
    }

    const risk = this.approvalRiskById.get(id)
    // Forget regardless of outcome so the cache cannot grow unbounded.
    this.approvalRiskById.delete(id)

    if (risk !== 'high') {
      return { ok: true }
    }

    const allowed = await this.options.showConfirmation({
      windowOwner: window,
      title: 'Confirm high-risk approval',
      message: 'Approve a high-risk operation?',
      detail:
        `Approval id: ${id}. A high-risk permission lease, tier escalation, or worker diff is being approved. Cancel if you did not initiate this from the in-app UI.`,
    })
    if (!allowed) {
      return this.deny(method, 'user cancelled high-risk approval')
    }
    return { ok: true }
  }

  private findOwningWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
    const main = this.options.getMainWindow()
    if (main && !main.isDestroyed() && main.webContents.id === event.sender.id) {
      return main
    }
    return null
  }

  private confirmedSet(window: BrowserWindow | null): Set<string> | null {
    if (!window) return null
    let set = this.perWindowConfirmed.get(window)
    if (!set) {
      set = new Set<string>()
      this.perWindowConfirmed.set(window, set)
    }
    return set
  }

  private sensitiveQualifier(method: RpcMethod, params: unknown): string | null {
    if (method !== 'config/set') return 'method'
    const path = readStringField(params, 'path')
    if (!path) return 'method'
    const lower = path.toLowerCase()
    if (lower.includes('apikey')) return 'secret'
    if (lower === 'model' || lower.startsWith('model.')) return 'model'
    if (lower === 'mcp' || lower.startsWith('mcp.')) return 'mcp'
    if (lower === 'workspace' || lower.startsWith('workspace.')) return 'workspace'
    if (lower === 'auth' || lower.startsWith('auth.')) return 'auth'
    return null
  }

  private summarize(method: RpcMethod, params: unknown): string {
    if (method === 'workspace/set') {
      const dir = readStringField(params, 'dir')
      return dir ? `Change workspace to "${dir}"?` : 'Change workspace?'
    }
    if (method === 'workspace/clear') return 'Clear the active workspace?'
    if (method === 'config/setApiKey') {
      const provider = readStringField(params, 'provider')
      return provider ? `Save API key for provider "${provider}"?` : 'Save API key?'
    }
    if (method === 'config/set') {
      const path = readStringField(params, 'path')
      return path ? `Update sensitive config "${path}"?` : 'Update sensitive config?'
    }
    if (method === 'session/delete') {
      const id = readStringField(params, 'id')
      return id ? `Delete session "${id}"?` : 'Delete session?'
    }
    if (method === 'mcp/restart') {
      const name = readStringField(params, 'name')
      return name ? `Restart MCP server "${name}"?` : 'Restart MCP server?'
    }
    return `Confirm ${method}?`
  }

  private deny(method: string, reason: string): PolicyResult {
    // Prefix the message with `PolicyError:` so renderer code can identify
    // policy-gate denials even when Electron's contextBridge does not
    // preserve the custom `error.name` across the isolated-world boundary.
    const message = `PolicyError: blocked RPC call to ${method}: ${reason}.`
    this.options.log?.(`[rpc-policy] ${message}`)
    return { ok: false, error: { name: 'PolicyError', message } }
  }
}

/** True if `error.message` was produced by the main-process RPC policy gate. */
export function isPolicyError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'PolicyError' || error.message.startsWith('PolicyError:')
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' && message.startsWith('PolicyError:')
  }
  return false
}

function readStringField(params: unknown, field: string): string | null {
  if (!params || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}
