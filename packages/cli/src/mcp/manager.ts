/**
 * McpManager — owns one MCP client per configured server.
 *
 * Phase 1 supports stdio (local subprocess) servers. Remote (HTTP) servers
 * are accepted in config but rejected at start time.
 *
 * Lifecycle:
 *   start() — connect every server in parallel; on success, list its tools
 *             and register them in the shared ToolRegistry.
 *   stop()  — close all transports; called on SIGTERM / process exit.
 *   restart(name) — bounce a single server.
 *
 * Crash supervision:
 *   When a transport's `onclose` fires unexpectedly we retry connecting with
 *   exponential backoff (1s/2s/4s/8s/16s, capped at 30s). Tools whose server
 *   is currently disconnected return Result.err with a clear message.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpConfig, McpLocalServerConfig, McpServerConfig } from '@src/config'
import { type Result, ok, err } from '@src/types'
import type { ToolRegistry } from '@src/tools/registry'
import {
  mcpToolToDefinition,
  mcpToolRegistryName,
  type McpCallToolFn,
  type McpCallToolResult,
} from './adapter'
import type {
  McpServerConnectedEvent,
  McpServerDisconnectedEvent,
  McpServerErrorEvent,
  McpServerStatus,
  McpServerStatusEntry,
  McpToolDescriptor,
} from './types'

const CLIENT_INFO = { name: 'ouroboros', version: '0.1.0' } as const
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30000
const BACKOFF_FACTOR = 2

export interface McpManagerEventHandlers {
  onServerConnected?: (event: McpServerConnectedEvent) => void
  onServerDisconnected?: (event: McpServerDisconnectedEvent) => void
  onServerError?: (event: McpServerErrorEvent) => void
}

export interface McpManagerOptions {
  config: McpConfig
  registry: ToolRegistry
  handlers?: McpManagerEventHandlers
  /** Logger; defaults to no-op so library code stays quiet in tests. */
  log?: (message: string) => void
}

interface ServerState {
  config: McpServerConfig
  status: McpServerStatus
  client?: Client
  transport?: Transport
  toolNames: Set<string>
  errorMessage?: string
  pid?: number
  retryAttempt: number
  retryTimer?: ReturnType<typeof setTimeout>
  shuttingDown: boolean
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>()
  private readonly registry: ToolRegistry
  private readonly handlers: McpManagerEventHandlers
  private readonly log: (message: string) => void
  private started = false
  private stopped = false

  constructor(options: McpManagerOptions) {
    this.registry = options.registry
    this.handlers = options.handlers ?? {}
    this.log = options.log ?? (() => {})
    for (const config of options.config.servers) {
      if (this.servers.has(config.name)) {
        throw new Error(`Duplicate MCP server name in config: "${config.name}"`)
      }
      this.servers.set(config.name, {
        config,
        status: 'disconnected',
        toolNames: new Set(),
        retryAttempt: 0,
        shuttingDown: false,
      })
    }
  }

  /** Connect every configured server in parallel. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const work: Array<Promise<void>> = []
    for (const state of this.servers.values()) {
      work.push(this.connectServer(state))
    }
    await Promise.allSettled(work)
  }

  /** Close every server transport. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const work: Array<Promise<void>> = []
    for (const state of this.servers.values()) {
      state.shuttingDown = true
      if (state.retryTimer) {
        clearTimeout(state.retryTimer)
        state.retryTimer = undefined
      }
      if (state.transport) {
        const t = state.transport
        work.push(t.close().catch(() => undefined))
      }
    }
    await Promise.allSettled(work)
  }

  /** Public, serializable snapshot for the `mcp/list` RPC. */
  getServerStatuses(): McpServerStatusEntry[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.config.name,
      type: s.config.type,
      status: s.status,
      toolCount: s.toolNames.size,
      ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
      ...(typeof s.pid === 'number' ? { pid: s.pid } : {}),
    }))
  }

  /** Force a single server to bounce (close + reconnect). */
  async restartServer(name: string): Promise<Result<void>> {
    const state = this.servers.get(name)
    if (!state) return err(new Error(`Unknown MCP server "${name}"`))
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = undefined
    }
    state.retryAttempt = 0
    if (state.transport) {
      try {
        await state.transport.close()
      } catch {
        // close errors are non-fatal; we'll respawn anyway.
      }
    }
    this.removeRegisteredTools(state)
    await this.connectServer(state)
    return ok(undefined)
  }

  // ---- internals -------------------------------------------------------

  private async connectServer(state: ServerState): Promise<void> {
    if (state.shuttingDown || this.stopped) return

    if (state.config.type !== 'local') {
      this.markError(state, 'Remote (HTTP) MCP transports are not supported in Phase 1', false)
      return
    }

    state.status = 'connecting'
    state.errorMessage = undefined

    const transport = createStdioTransport(state.config)
    transport.onerror = (error) => {
      this.log(`[mcp] ${state.config.name} transport error: ${error.message}`)
    }
    transport.onclose = () => {
      this.handleTransportClose(state)
    }

    const client = new Client(CLIENT_INFO, { capabilities: {} })

    try {
      await client.connect(transport)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.markError(state, `Failed to connect: ${message}`, true)
      this.scheduleRetry(state)
      return
    }

    state.transport = transport
    state.client = client
    state.pid = transport instanceof StdioClientTransport ? (transport.pid ?? undefined) : undefined
    state.status = 'connected'
    state.errorMessage = undefined
    state.retryAttempt = 0

    let toolCount = 0
    try {
      toolCount = await this.registerTools(state)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.markError(state, `listTools failed: ${message}`, true)
      try {
        await transport.close()
      } catch {
        // ignored — transport is already broken.
      }
      this.scheduleRetry(state)
      return
    }

    this.handlers.onServerConnected?.({ name: state.config.name, toolCount })
  }

  private async registerTools(state: ServerState): Promise<number> {
    const client = state.client
    if (!client) return 0
    const response = await client.listTools()
    const tools: McpToolDescriptor[] = (response.tools ?? []) as McpToolDescriptor[]
    this.removeRegisteredTools(state)
    let count = 0
    for (const tool of tools) {
      const definition = mcpToolToDefinition({
        serverName: state.config.name,
        tool,
        callTool: this.makeCallToolFn(state, tool.name),
      })
      this.registry.register(definition)
      state.toolNames.add(definition.name)
      count += 1
    }
    return count
  }

  private makeCallToolFn(state: ServerState, mcpToolName: string): McpCallToolFn {
    return async (toolName, args, signal) => {
      if (toolName !== mcpToolName) {
        throw new Error(`Adapter mismatch: expected "${mcpToolName}", got "${toolName}"`)
      }
      const client = state.client
      if (!client || state.status !== 'connected') {
        throw new Error(
          `MCP server "${state.config.name}" is not connected (status: ${state.status})`,
        )
      }
      const timeoutMs = state.config.timeout
      const requestOptions: { signal?: AbortSignal; timeout?: number } = { timeout: timeoutMs }
      if (signal) requestOptions.signal = signal
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        requestOptions,
      )
      return result as McpCallToolResult
    }
  }

  private handleTransportClose(state: ServerState): void {
    if (state.shuttingDown || this.stopped) return
    if (state.status === 'disconnected' || state.status === 'error') {
      return
    }
    state.status = 'disconnected'
    state.client = undefined
    state.transport = undefined
    state.pid = undefined
    this.handlers.onServerDisconnected?.({
      name: state.config.name,
      reason: state.errorMessage,
    })
    this.scheduleRetry(state)
  }

  private scheduleRetry(state: ServerState): void {
    if (state.shuttingDown || this.stopped) return
    if (state.retryTimer) return
    const delay = computeBackoffDelay(state.retryAttempt)
    state.retryAttempt += 1
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      void this.connectServer(state)
    }, delay)
  }

  private markError(state: ServerState, message: string, willRetry: boolean): void {
    state.status = 'error'
    state.errorMessage = message
    this.handlers.onServerError?.({ name: state.config.name, message, willRetry })
  }

  private removeRegisteredTools(state: ServerState): void {
    for (const toolName of state.toolNames) {
      this.registry.denyTool(toolName, `MCP server "${state.config.name}" is not connected`)
    }
    state.toolNames.clear()
  }
}

function createStdioTransport(config: McpLocalServerConfig): StdioClientTransport {
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...getDefaultEnvironment(), ...config.env },
    ...(config.cwd ? { cwd: config.cwd } : {}),
  })
}

function computeBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt))
}

/** Helper for tests / handlers that need the canonical registry tool name. */
export { mcpToolRegistryName }
