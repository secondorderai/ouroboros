/**
 * JSON-RPC Server
 *
 * Long-running server mode for the CLI. Reads JSON-RPC 2.0 requests from
 * stdin (NDJSON), dispatches them to handlers, and writes responses and
 * notifications to stdout.
 *
 * This module is the entry point called from `src/cli.ts` when the
 * `--json-rpc` flag is passed.
 */

import { Agent, type AgentEventHandler } from '@src/agent'
import type { OuroborosConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import { TranscriptStore } from '@src/memory/transcripts'
import { createRegistry } from '@src/tools/registry'
import { resolve } from 'node:path'
import { createHandlers, bridgeAgentEvent, HandlerError, type HandlerContext } from './handlers'
import { writeMessage, debugLog, startLineReader } from './transport'
import { isJsonRpcRequest, makeResponse, makeErrorResponse, JSON_RPC_ERRORS } from './types'

// ── Server entry point ──────────────────────────────────────────────

export interface JsonRpcServerOptions {
  config: OuroborosConfig
  configDir: string
}

/**
 * Start the JSON-RPC server. This function runs indefinitely, processing
 * requests from stdin and writing responses to stdout.
 *
 * It never throws — all errors are returned as JSON-RPC error responses.
 */
export async function startJsonRpcServer(options: JsonRpcServerOptions): Promise<void> {
  const { config: initialConfig, configDir } = options

  let config = initialConfig

  // Create tool registry
  const registry = await createRegistry()

  // Create transcript store
  const dbPath = resolve(configDir, '.ouroboros-transcripts.db')
  const storeResult = TranscriptStore.create(dbPath)
  if (!storeResult.ok) {
    writeMessage(
      makeErrorResponse(null, JSON_RPC_ERRORS.INTERNAL_ERROR.code, storeResult.error.message),
    )
    process.exit(1)
  }
  const transcriptStore = storeResult.value

  // Mutable event dispatch — wired to bridge agent events to JSON-RPC notifications
  let currentHandler: AgentEventHandler = bridgeAgentEvent
  const eventProxy: AgentEventHandler = (event) => {
    currentHandler(event)
  }

  // Agent is created lazily on first use — allows the server to start
  // even when the API key is not yet configured.
  let agent: Agent | null = null

  function getOrCreateAgent(): Agent {
    if (agent) return agent

    const providerResult = createProvider(config.model)
    if (!providerResult.ok) {
      throw new Error(providerResult.error.message)
    }

    agent = new Agent({
      model: providerResult.value,
      toolRegistry: registry,
      onEvent: eventProxy,
    })
    return agent
  }

  // Mutable abort controller for cancelling agent runs
  let currentRunAbort: AbortController | null = null

  // Build handler context
  const ctx: HandlerContext = {
    getAgent: getOrCreateAgent,
    config,
    configDir,
    transcriptStore,
    currentRunAbort,
    setCurrentRunAbort: (abort) => {
      currentRunAbort = abort
      ctx.currentRunAbort = abort
    },
    setConfig: (newConfig) => {
      config = newConfig
      ctx.config = newConfig
      // Reset agent so it picks up the new config on next use
      agent = null
    },
  }

  // Build method handlers
  const handlers = createHandlers(ctx)

  debugLog('JSON-RPC server started')

  // Start reading lines from stdin
  startLineReader((line) => {
    handleLine(line, handlers).catch((e) => {
      const message = e instanceof Error ? e.message : String(e)
      debugLog(`Unhandled error in line handler: ${message}`)
    })
  })
}

// ── Line dispatcher ─────────────────────────────────────────────────

async function handleLine(
  line: string,
  handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>,
): Promise<void> {
  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    writeMessage(
      makeErrorResponse(
        null,
        JSON_RPC_ERRORS.PARSE_ERROR.code,
        JSON_RPC_ERRORS.PARSE_ERROR.message,
      ),
    )
    return
  }

  // Validate as JSON-RPC request
  if (!isJsonRpcRequest(parsed)) {
    writeMessage(
      makeErrorResponse(
        null,
        JSON_RPC_ERRORS.INVALID_REQUEST.code,
        JSON_RPC_ERRORS.INVALID_REQUEST.message,
      ),
    )
    return
  }

  const { id, method, params } = parsed
  const resolvedParams = (params ?? {}) as Record<string, unknown>

  // Look up handler
  const handler = handlers.get(method)
  if (!handler) {
    writeMessage(
      makeErrorResponse(
        id,
        JSON_RPC_ERRORS.METHOD_NOT_FOUND.code,
        `${JSON_RPC_ERRORS.METHOD_NOT_FOUND.message}: ${method}`,
      ),
    )
    return
  }

  // Execute handler
  try {
    const result = await handler(resolvedParams)
    writeMessage(makeResponse(id, result))
  } catch (e) {
    if (e instanceof HandlerError) {
      writeMessage(makeErrorResponse(id, e.code, e.message, e.data))
    } else {
      const message = e instanceof Error ? e.message : String(e)
      writeMessage(makeErrorResponse(id, JSON_RPC_ERRORS.INTERNAL_ERROR.code, message))
    }
  }
}
