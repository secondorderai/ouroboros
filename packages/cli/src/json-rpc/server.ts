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

import { AsyncLocalStorage } from 'node:async_hooks'
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
import {
  setSkillActivatedHandler,
  setSkillApprovalHandler,
  type SkillApprovalRequest,
} from '@src/tools/skill-manager'
import { createRegistry } from '@src/tools/registry'
import { McpManager } from '@src/mcp/manager'
import {
  setWorkerDiffApprovalHandler,
  type WorkerDiffApprovalRequest,
} from '@src/tools/worker-diff-approval'
import {
  setTierApprovalHandler,
  tierApprovalRisk,
  type TierApprovalDetails,
} from '@src/tier-approval'
import { resolve } from 'node:path'
import {
  createHandlers,
  bridgeAgentEvent,
  toConversationHistory,
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

  // Capture the directory the CLI was launched from so `workspace/clear`
  // can revert process.cwd() back to it.
  const initialCwd = process.cwd()

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
  const pendingSkillApprovals = new Map<
    string,
    {
      request: SkillApprovalRequest
      resolve: (
        result:
          | { ok: true; value: { approved: boolean; reason?: string } }
          | { ok: false; error: Error },
      ) => void
    }
  >()
  const pendingTierApprovals = new Map<
    string,
    {
      toolName: string
      toolTier: number
      toolArgs: unknown
      details: TierApprovalDetails
      description: string
      resolve: (result: { approved: true } | Error) => void
    }
  >()

  // Create tool registry
  const registry = await createRegistry()

  // Connect any MCP servers configured in .ouroboros and register their tools.
  const mcpManager = new McpManager({
    config: config.mcp,
    registry,
    handlers: {
      onServerConnected: ({ name, toolCount }) => {
        writeMessage(makeNotification('mcp/serverConnected', { name, toolCount }))
      },
      onServerDisconnected: ({ name, reason }) => {
        writeMessage(
          makeNotification('mcp/serverDisconnected', {
            name,
            ...(reason ? { reason } : {}),
          }),
        )
      },
      onServerError: ({ name, message, willRetry }) => {
        writeMessage(makeNotification('mcp/serverError', { name, message, willRetry }))
      },
    },
    log: (message) => debugLog(message),
  })
  await mcpManager.start()
  const stopMcp = (): void => {
    void mcpManager.stop()
  }
  process.once('SIGTERM', stopMcp)
  process.once('SIGINT', stopMcp)
  process.once('beforeExit', stopMcp)

  // ── Per-session run state ────────────────────────────────────────
  //
  // The JSON-RPC server is multi-session: a session that is mid-stream must
  // not be disrupted when the desktop switches view to another session. So
  // every piece of run state is keyed by sessionId rather than process-wide.
  //
  // - `agentsBySession`        : the Agent instance whose conversationHistory
  //                              belongs to that session. Created lazily in
  //                              getAgentForSession (history is hydrated from
  //                              SQLite the first time).
  // - `abortsBySession`        : per-session AbortController so cancelling one
  //                              session's run can't affect another.
  // - `skillActivationsBySession`: dedup'd, ordered list of skills activated
  //                              during a session's currently-streaming turn.
  //                              Drained by agent/run at end-of-turn.
  // - `sessionRunStorage`      : AsyncLocalStorage that pins `sessionId` to
  //                              the async context of `agent.run(...)`. The
  //                              global skill-activation handler reads it so
  //                              activations attribute to the right session
  //                              even when multiple runs are concurrent.
  const agentsBySession = new Map<string, Agent>()
  const abortsBySession = new Map<string, AbortController>()
  const skillActivationsBySession = new Map<string, string[]>()
  const sessionRunStorage = new AsyncLocalStorage<{ sessionId: string }>()

  setSkillActivatedHandler((name) => {
    const store = sessionRunStorage.getStore()
    const sessionId = store?.sessionId ?? null
    writeMessage(makeNotification('skill/activated', { sessionId, name }))
    if (!sessionId) return
    const list = skillActivationsBySession.get(sessionId) ?? []
    if (!list.includes(name)) {
      list.push(name)
      skillActivationsBySession.set(sessionId, list)
    }
  })

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

  setSkillApprovalHandler(async (request) => {
    const createdAt = new Date().toISOString()
    writeMessage(
      makeNotification('approval/request', {
        id: request.approvalId,
        type: 'skill-activation',
        description: request.description,
        createdAt,
        skillName: request.skillName,
      }),
    )

    return new Promise((resolveDecision) => {
      pendingSkillApprovals.set(request.approvalId, {
        request,
        resolve: resolveDecision,
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

  setTierApprovalHandler(async (toolName: string, toolTier: number, toolArgs: unknown) => {
    const approvalId = `tier-approval-${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()
    const tierLabel = tierApprovalLabel(toolTier)
    const description = `Approve one ${tierLabel} operation: ${toolName}`
    const details: TierApprovalDetails = {
      approvalId,
      toolName,
      toolTier: toolTier as 1 | 2 | 3 | 4,
      toolArgs,
      tierLabel,
      createdAt,
    }

    writeMessage(
      makeNotification('approval/request', {
        id: approvalId,
        type: 'tier-operation',
        description,
        createdAt,
        risk: tierApprovalRisk(toolTier as 1 | 2 | 3 | 4),
        tier: details,
      }),
    )

    return new Promise((resolve) => {
      pendingTierApprovals.set(approvalId, {
        toolName,
        toolTier,
        toolArgs,
        details,
        description,
        resolve: (result) => {
          if (result instanceof Error) {
            resolve({ ok: false, error: result })
            return
          }
          resolve({ ok: true, value: undefined })
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

  // Single event bridge for all per-session agents. The sessionId comes from
  // the AsyncLocalStorage scope opened around `agent.run(...)` (see the
  // wrapper in handlers.ts via cancelSessionRun callsite below). Events fired
  // outside any run (rare — shutdown, RSI background tasks) report
  // `sessionId: null` rather than guessing.
  const eventProxy: AgentEventHandler = (event) => {
    const sessionId = sessionRunStorage.getStore()?.sessionId ?? null
    bridgeAgentEvent(event, sessionId)
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

  /**
   * Materialize the agent for a session, hydrating its conversation history
   * from SQLite the first time. Subsequent calls return the same instance so
   * that mid-stream state (in-progress tool calls, pending text) survives a
   * view switch.
   *
   * Passing no sessionId returns the agent for `currentSessionId`, or — if no
   * session has been created yet — a transient anonymous agent. The latter
   * exists only so legacy single-session callers (the REPL, some tests) keep
   * working; production multi-session use always passes a sessionId.
   */
  let anonymousAgent: Agent | null = null
  function buildAgent(basePath = configDir): Agent {
    const providerResult = createProvider(config.model, configDir)
    if (!providerResult.ok) {
      throw new Error(providerResult.error.message)
    }
    const rsiOrchestrator = new RSIOrchestrator({
      config,
      llm: providerResult.value,
      onEvent: eventProxy,
      basePath,
    })
    return new Agent({
      model: providerResult.value,
      toolRegistry: registry,
      onEvent: eventProxy,
      config,
      transcriptStore,
      basePath,
      rsiOrchestrator,
      modeManager,
      taskGraphStore,
    })
  }

  function getAgentForSession(sessionId?: string): Agent {
    const targetSessionId = sessionId ?? currentSessionId ?? undefined
    if (!targetSessionId) {
      if (!anonymousAgent) anonymousAgent = buildAgent()
      return anonymousAgent
    }
    const existing = agentsBySession.get(targetSessionId)
    if (existing) return existing

    // Hydrate the agent's conversation history from SQLite so subsequent
    // turns build on the prior conversation.
    const sessionData = transcriptStore.getSession(targetSessionId)
    const a = buildAgent(
      sessionData.ok ? (sessionData.value.workspacePath ?? configDir) : configDir,
    )
    a.setSessionId(targetSessionId)
    if (sessionData.ok) {
      a.setConversationHistory(toConversationHistory(sessionData.value))
    }
    agentsBySession.set(targetSessionId, a)
    return a
  }

  function resetAllAgents(): void {
    anonymousAgent = null
    agentsBySession.clear()
    abortsBySession.clear()
    skillActivationsBySession.clear()
  }

  // Legacy single-run abort controller — kept for the REPL / tests that still
  // expect process-wide cancel semantics. Per-session runs use
  // `abortsBySession` via `cancelSessionRun`.
  let currentRunAbort: AbortController | null = null
  let currentSessionId: string | null = null

  // Build handler context
  const ctx: HandlerContext = {
    getAgent: getAgentForSession,
    cancelSessionRun: (sessionId) => {
      const abort = abortsBySession.get(sessionId)
      if (!abort) return false
      abort.abort()
      abortsBySession.delete(sessionId)
      // Steers queued before the user hit Cancel become orphans the desktop
      // can offer to resend as a fresh turn — preserving intent without
      // auto-starting a new run.
      const agent = agentsBySession.get(sessionId)
      agent?.flushPendingSteersAsOrphans('cancelled')
      return true
    },
    registerSessionAbort: (sessionId, abort) => {
      if (abort === null) {
        // Only delete if it's still ours — a fast cancel + restart sequence
        // could have replaced this entry already.
        abortsBySession.delete(sessionId)
      } else {
        abortsBySession.set(sessionId, abort)
      }
    },
    forgetSession: (sessionId) => {
      abortsBySession.get(sessionId)?.abort()
      abortsBySession.delete(sessionId)
      agentsBySession.delete(sessionId)
      skillActivationsBySession.delete(sessionId)
    },
    config,
    configDir,
    initialCwd,
    initialConfigDir,
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
      // Drop all cached agents so they pick up the new config on next use.
      resetAllAgents()
    },
    setConfigDir: (newConfigDir) => {
      configDir = newConfigDir
      ctx.configDir = newConfigDir
      resetAllAgents()
    },
    authManager: new OpenAIChatGPTAuthManager(),
    modeManager,
    taskGraphStore,
    mcpManager,
    takeSkillActivations: (sessionId) => {
      const list = skillActivationsBySession.get(sessionId)
      if (!list || list.length === 0) return []
      skillActivationsBySession.delete(sessionId)
      return list
    },
    runWithSessionScope: <T>(sessionId: string, fn: () => Promise<T>) => {
      // Track abort per-session so concurrent runs can be cancelled
      // independently. agent/run sets this just before calling here.
      return sessionRunStorage.run({ sessionId }, fn)
    },
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
      ...Array.from(pendingSkillApprovals.values()).map(({ request }) =>
        toSkillApprovalItem(request),
      ),
      ...Array.from(pendingTierApprovals.values()).map((pending) => toTierApprovalItem(pending)),
    ],
    respondToApproval: (id, approved, reason) => {
      const pendingSkill = pendingSkillApprovals.get(id)
      if (pendingSkill) {
        pendingSkillApprovals.delete(id)
        const trimmedReason = reason?.trim() || undefined
        pendingSkill.resolve({
          ok: true,
          value: { approved, ...(trimmedReason ? { reason: trimmedReason } : {}) },
        })
        return {
          status: approved ? 'approved' : 'denied',
          message: approved
            ? `Skill "${pendingSkill.request.skillName}" approved.`
            : (trimmedReason ?? `Skill "${pendingSkill.request.skillName}" denied.`),
          skillName: pendingSkill.request.skillName,
        }
      }
      const pending = pendingLeaseApprovals.get(id)
      if (!pending) {
        const pendingTier = pendingTierApprovals.get(id)
        if (pendingTier) {
          pendingTierApprovals.delete(id)
          if (approved) {
            pendingTier.resolve({ approved: true })
            return {
              status: 'approved',
              message: `Tier ${pendingTier.toolTier} operation "${pendingTier.toolName}" approved.`,
            }
          }
          const denialReason =
            reason?.trim() ||
            `Tier ${pendingTier.toolTier} operation "${pendingTier.toolName}" denied by user.`
          pendingTier.resolve(new Error(denialReason))
          return { status: 'denied', message: denialReason }
        }
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

function toSkillApprovalItem(request: SkillApprovalRequest): ApprovalItem {
  return {
    id: request.approvalId,
    type: 'skill-activation',
    description: request.description,
    createdAt: new Date().toISOString(),
    skillName: request.skillName,
  }
}

function toTierApprovalItem(pending: {
  details: TierApprovalDetails
  description: string
}): ApprovalItem {
  return {
    id: pending.details.approvalId,
    type: 'tier-operation',
    description: pending.description,
    createdAt: pending.details.createdAt,
    risk: tierApprovalRisk(pending.details.toolTier),
    tier: pending.details,
  }
}

function tierApprovalLabel(toolTier: number): string {
  switch (toolTier) {
    case 1:
      return 'Tier 1: Scoped writes'
    case 2:
      return 'Tier 2: Skill generation'
    case 3:
      return 'Tier 3: Self-modification'
    case 4:
      return 'Tier 4: System-level'
    default:
      return `Tier ${toolTier}`
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
