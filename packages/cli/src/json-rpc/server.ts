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
import { OpenAIChatGPTAuthManager } from '@src/auth/openai-chatgpt'
import type { OuroborosConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import { TranscriptStore } from '@src/memory/transcripts'
import { ModeManager, PLAN_MODE } from '@src/modes'
import {
  approvePermissionLease,
  setPermissionLeaseApprovalHandler,
  type PermissionLeaseApprovalRequest,
} from '@src/permission-lease'
import { setModeManager as setEnterModeModeManager } from '@src/modes/tools/enter-mode'
import { setModeManager as setSubmitPlanModeManager } from '@src/modes/tools/submit-plan'
import { setModeManager as setExitModeModeManager } from '@src/modes/tools/exit-mode'
import { RSIOrchestrator } from '@src/rsi/orchestrator'
import { TaskGraphStore } from '@src/team/task-graph'
import { setAskUserPromptHandler } from '@src/tools/ask-user'
import { createRegistry } from '@src/tools/registry'
import {
  setWorkerDiffApprovalHandler,
  type WorkerDiffApprovalRequest,
} from '@src/tools/worker-diff-approval'
import { resolve } from 'node:path'
import {
  createHandlers,
  bridgeAgentEvent,
  HandlerError,
  type ApprovalItem,
  type HandlerContext,
} from './handlers'
import { writeMessage, debugLog, startLineReader } from './transport'
import {
  isJsonRpcRequest,
  makeResponse,
  makeErrorResponse,
  makeNotification,
  JSON_RPC_ERRORS,
} from './types'

// ── Server entry point ──────────────────────────────────────────────

export interface JsonRpcServerOptions {
  config: OuroborosConfig
  configDir: string
  maxStepsOverride?: number
}

/**
 * Start the JSON-RPC server. This function runs indefinitely, processing
 * requests from stdin and writing responses to stdout.
 *
 * It never throws — all errors are returned as JSON-RPC error responses.
 */
export async function startJsonRpcServer(options: JsonRpcServerOptions): Promise<void> {
  const { config: initialConfig, configDir: initialConfigDir, maxStepsOverride } = options

  let config = initialConfig
  let configDir = initialConfigDir
  let askUserCounter = 0
  const pendingAskUserPrompts = new Map<string, (response: string) => void>()
  const pendingLeaseApprovals = new Map<
    string,
    {
      request: PermissionLeaseApprovalRequest
      resolve: (result: ReturnType<typeof approvePermissionLease> | Error) => void
    }
  >()
  const pendingWorkerDiffApprovals = new Map<
    string,
    {
      request: WorkerDiffApprovalRequest
      resolve: (result: { approved: true; approvedAt: string } | Error) => void
    }
  >()

  // Create tool registry
  const registry = await createRegistry()

  setAskUserPromptHandler(async (args) => {
    const id = `ask-user-${++askUserCounter}`
    writeMessage(
      makeNotification('askUser/request', {
        id,
        question: args.question,
        options: args.options ?? [],
        createdAt: new Date().toISOString(),
      }),
    )

    return new Promise((resolvePrompt) => {
      pendingAskUserPrompts.set(id, (response) => {
        resolvePrompt({ ok: true, value: { response } })
      })
    })
  })

  setPermissionLeaseApprovalHandler(async (request) => {
    pendingLeaseApprovals.set(request.approvalId, {
      request,
      resolve: () => {},
    })

    writeMessage(
      makeNotification('approval/request', {
        id: request.approvalId,
        type: 'permission-lease',
        description: request.description,
        createdAt: request.details.createdAt,
        risk: request.details.risk,
        lease: request.details,
      }),
    )
    writeMessage(
      makeNotification('agent/permissionLeaseUpdated', {
        ...request.details,
        status: 'pending',
      }),
    )

    return new Promise((resolveLease) => {
      pendingLeaseApprovals.set(request.approvalId, {
        request,
        resolve: (result) => {
          if (result instanceof Error) {
            resolveLease({ ok: false, error: result })
            return
          }
          resolveLease({ ok: true, value: result })
        },
      })
    })
  })

  setWorkerDiffApprovalHandler(async (request) => {
    pendingWorkerDiffApprovals.set(request.approvalId, {
      request,
      resolve: () => {},
    })

    writeMessage(
      makeNotification('approval/request', {
        id: request.approvalId,
        type: 'worker-diff-apply',
        description: request.description,
        createdAt: request.details.createdAt,
        risk: request.details.risk,
        diff: request.details.diff,
        workerDiff: request.details,
      }),
    )

    return new Promise((resolveDecision) => {
      pendingWorkerDiffApprovals.set(request.approvalId, {
        request,
        resolve: (result) => {
          if (result instanceof Error) {
            resolveDecision({ ok: false, error: result })
            return
          }
          resolveDecision({ ok: true, value: result })
        },
      })
    })
  })

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
  const taskGraphStore = new TaskGraphStore(transcriptStore)

  // Mutable event dispatch — wired to bridge agent events to JSON-RPC notifications
  let currentHandler: AgentEventHandler = bridgeAgentEvent
  const eventProxy: AgentEventHandler = (event) => {
    currentHandler(event)
  }

  // Create ModeManager and register plan mode
  const modeManager = new ModeManager((event) => {
    eventProxy(event as Parameters<AgentEventHandler>[0])
  })
  modeManager.registerMode(PLAN_MODE)

  // Wire ModeManager into mode tools
  setEnterModeModeManager(modeManager)
  setSubmitPlanModeManager(modeManager)
  setExitModeModeManager(modeManager)

  // Agent is created lazily on first use — allows the server to start
  // even when the API key is not yet configured.
  let agent: Agent | null = null

  function getOrCreateAgent(): Agent {
    if (agent) return agent

    const providerResult = createProvider(config.model)
    if (!providerResult.ok) {
      throw new Error(providerResult.error.message)
    }

    const rsiOrchestrator = new RSIOrchestrator({
      config,
      llm: providerResult.value,
      onEvent: eventProxy,
      basePath: configDir,
    })

    agent = new Agent({
      model: providerResult.value,
      toolRegistry: registry,
      onEvent: eventProxy,
      config,
      transcriptStore,
      basePath: configDir,
      rsiOrchestrator,
      modeManager,
      taskGraphStore,
    })
    return agent
  }

  // Mutable abort controller for cancelling agent runs
  let currentRunAbort: AbortController | null = null
  let currentSessionId: string | null = null

  // Build handler context
  const ctx: HandlerContext = {
    getAgent: getOrCreateAgent,
    config,
    configDir,
    transcriptStore,
    maxStepsOverride,
    currentRunAbort,
    setCurrentRunAbort: (abort) => {
      currentRunAbort = abort
      ctx.currentRunAbort = abort
    },
    currentSessionId,
    setCurrentSessionId: (sessionId) => {
      currentSessionId = sessionId
      ctx.currentSessionId = sessionId
    },
    setConfig: (newConfig) => {
      config = newConfig
      ctx.config = newConfig
      // Reset agent so it picks up the new config on next use
      agent = null
    },
    setConfigDir: (newConfigDir) => {
      configDir = newConfigDir
      ctx.configDir = newConfigDir
      agent = null
    },
    authManager: new OpenAIChatGPTAuthManager(),
    modeManager,
    taskGraphStore,
    respondToAskUser: (id, response) => {
      const resolvePrompt = pendingAskUserPrompts.get(id)
      if (!resolvePrompt) {
        throw new HandlerError(
          JSON_RPC_ERRORS.INVALID_PARAMS.code,
          `Unknown ask-user prompt: ${id}`,
        )
      }
      pendingAskUserPrompts.delete(id)
      resolvePrompt(response)
    },
    listApprovals: () => [
      ...Array.from(pendingLeaseApprovals.values()).map(({ request }) =>
        toLeaseApprovalItem(request),
      ),
      ...Array.from(pendingWorkerDiffApprovals.values()).map(({ request }) =>
        toWorkerDiffApprovalItem(request),
      ),
    ],
    respondToApproval: (id, approved, reason) => {
      const pending = pendingLeaseApprovals.get(id)
      if (!pending) {
        const pendingWorkerDiff = pendingWorkerDiffApprovals.get(id)
        if (pendingWorkerDiff) {
          pendingWorkerDiffApprovals.delete(id)
          if (approved) {
            const approvedAt = new Date().toISOString()
            pendingWorkerDiff.resolve({ approved: true, approvedAt })
            return {
              status: 'approved',
              message: 'Worker diff application approved.',
              workerDiff: {
                ...pendingWorkerDiff.request.details,
                reviewStatus: 'approved' as const,
                approvedAt,
              },
            }
          }

          const denialReason = reason?.trim() || 'Worker diff application denied by user.'
          pendingWorkerDiff.resolve(new Error(denialReason))
          return {
            status: 'denied',
            message: denialReason,
            workerDiff: {
              ...pendingWorkerDiff.request.details,
              reviewStatus: 'rejected' as const,
              denialReason,
            },
          }
        }
        throw new HandlerError(
          JSON_RPC_ERRORS.INVALID_PARAMS.code,
          `Unknown approval request: ${id}`,
        )
      }
      pendingLeaseApprovals.delete(id)
      if (approved) {
        const approvedLease = approvePermissionLease(pending.request.lease)
        const details = {
          ...pending.request.details,
          status: 'active' as const,
          approvedAt: approvedLease.approvedAt ?? undefined,
        }
        writeMessage(makeNotification('agent/permissionLeaseUpdated', details))
        pending.resolve(approvedLease)
        return {
          status: 'approved',
          message: 'Permission lease approved.',
          lease: details,
        }
      }

      const denialReason = reason?.trim() || 'Permission lease request denied by user.'
      const deniedDetails = {
        ...pending.request.details,
        status: 'denied' as const,
        denialReason,
      }
      writeMessage(makeNotification('agent/permissionLeaseUpdated', deniedDetails))
      pending.resolve(new Error(denialReason))
      return {
        status: 'denied',
        message: denialReason,
        lease: deniedDetails,
      }
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

function toLeaseApprovalItem(request: PermissionLeaseApprovalRequest): ApprovalItem {
  return {
    id: request.approvalId,
    type: 'permission-lease',
    description: request.description,
    createdAt: request.details.createdAt,
    risk: request.details.risk,
    lease: request.details,
  }
}

function toWorkerDiffApprovalItem(request: WorkerDiffApprovalRequest): ApprovalItem {
  return {
    id: request.approvalId,
    type: 'worker-diff-apply',
    description: request.description,
    createdAt: request.details.createdAt,
    risk: request.details.risk,
    diff: request.details.diff,
    workerDiff: request.details,
  }
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
