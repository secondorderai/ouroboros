/**
 * JSON-RPC Client
 *
 * Typed client that wraps the raw stdin/stdout transport provided by
 * CLIProcessManager. Manages request IDs, correlates responses, handles
 * timeouts, and dispatches notifications.
 */

import type { CLIProcessManager } from './cli-process'
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcError,
  type RpcMethodMap,
  type RpcMethod,
  type NotificationMap,
  type NotificationMethod,
  isJsonRpcResponse,
  isJsonRpcNotification,
} from '../shared/protocol'

// ── Configuration ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000
const HEALTH_CHECK_TIMEOUT_MS = 5_000
const METHODS_WITHOUT_TIMEOUT = new Set(['agent/run'])

// ── Error Types ────────────────────────────────────────────────────

export class RpcTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly id: number,
    public readonly timeoutMs: number,
  ) {
    super(`JSON-RPC request '${method}' (id=${id}) timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}

export class RpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpcError: JsonRpcError,
  ) {
    super(`JSON-RPC error for '${method}': [${rpcError.code}] ${rpcError.message}`)
    this.name = 'RpcError'
  }
}

// ── Pending Request Tracker ────────────────────────────────────────

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

// ── Notification Listener ──────────────────────────────────────────

type NotificationCallback = (params: unknown) => void

// ── RPC Client ─────────────────────────────────────────────────────

export class RpcClient {
  private nextId = 1
  private pending = new Map<number | string, PendingRequest>()
  private notificationListeners = new Map<string, Set<NotificationCallback>>()
  private cliProcess: CLIProcessManager | null = null

  /**
   * Attach the CLI process manager. Must be called before sending requests.
   * Separated from constructor to break the circular initialization dependency
   * between RpcClient and CLIProcessManager.
   */
  attach(cliProcess: CLIProcessManager): void {
    this.cliProcess = cliProcess
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Send a typed JSON-RPC request and wait for the response.
   *
   * @param method - The RPC method name
   * @param params - The request parameters (typed per method)
   * @param timeoutMs - Optional timeout override. Pass `null` to disable the timeout.
   * @returns Promise resolving to the typed result
   */
  send<M extends RpcMethod>(
    method: M,
    params?: RpcMethodMap[M]['params'],
    timeoutMs?: number | null,
  ): Promise<RpcMethodMap[M]['result']>

  /**
   * Send an untyped JSON-RPC request (for methods not in the type map).
   */
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number | null): Promise<unknown>

  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number | null,
  ): Promise<unknown> {
    const id = this.nextId++
    const effectiveTimeoutMs =
      timeoutMs === undefined
        ? METHODS_WITHOUT_TIMEOUT.has(method)
          ? null
          : DEFAULT_TIMEOUT_MS
        : timeoutMs

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    }

    return new Promise((resolve, reject) => {
      const timer =
        effectiveTimeoutMs == null
          ? null
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new RpcTimeoutError(method, id, effectiveTimeoutMs))
            }, effectiveTimeoutMs)

      // Track pending request
      this.pending.set(id, { method, resolve, reject, timer })

      // Write to CLI stdin
      try {
        if (!this.cliProcess) {
          throw new Error('RPC client not attached to a CLI process')
        }
        this.cliProcess.writeLine(JSON.stringify(request))
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Register a handler for a notification method.
   * Returns an unsubscribe function.
   */
  onNotification<M extends NotificationMethod>(
    method: M,
    callback: (params: NotificationMap[M]) => void,
  ): () => void

  onNotification(method: string, callback: NotificationCallback): () => void

  onNotification(method: string, callback: NotificationCallback): () => void {
    let listeners = this.notificationListeners.get(method)
    if (!listeners) {
      listeners = new Set()
      this.notificationListeners.set(method, listeners)
    }
    listeners.add(callback)

    // Return unsubscribe function
    return () => {
      listeners!.delete(callback)
      if (listeners!.size === 0) {
        this.notificationListeners.delete(method)
      }
    }
  }

  /**
   * Handle an incoming line from the CLI's stdout.
   * Parses it as JSON-RPC and dispatches to the appropriate handler.
   * Called by the CLIProcessManager's onStdoutLine callback.
   */
  handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      console.error(`[rpc-client] Failed to parse JSON from CLI stdout: ${line.slice(0, 200)}`)
      return
    }

    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(parsed)
    } else if (isJsonRpcNotification(parsed)) {
      this.handleNotification(parsed)
    } else {
      console.error(`[rpc-client] Unknown message format from CLI: ${line.slice(0, 200)}`)
    }
  }

  /**
   * Perform a health check by sending a config/get request with a
   * shorter timeout (5 seconds). Returns true if the CLI responds.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.send('config/get', {}, HEALTH_CHECK_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  /**
   * Reject all pending requests (e.g., when the CLI process exits).
   */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error(`${reason} (pending request '${pending.method}' id=${id})`))
    }
    this.pending.clear()
  }

  /**
   * Get the count of pending requests.
   */
  get pendingCount(): number {
    return this.pending.size
  }

  // ── Private ─────────────────────────────────────────────────────

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null) {
      // A response with null id is typically an error for a malformed request.
      // Log it but don't crash.
      if (response.error) {
        console.error(
          `[rpc-client] Received error response with null id: ` +
            `[${response.error.code}] ${response.error.message}`,
        )
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      console.error(`[rpc-client] Received response for unknown request id=${response.id}`)
      return
    }

    this.pending.delete(response.id)
    if (pending.timer) clearTimeout(pending.timer)

    if (response.error) {
      pending.reject(new RpcError(pending.method, response.error))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const listeners = this.notificationListeners.get(notification.method)
    if (!listeners || listeners.size === 0) {
      return
    }

    for (const callback of listeners) {
      try {
        callback(notification.params ?? {})
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          `[rpc-client] Notification handler error for '${notification.method}': ${message}`,
        )
      }
    }
  }
}
