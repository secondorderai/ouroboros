/**
 * JSON-RPC Method Handlers
 *
 * Maps JSON-RPC method names to handler functions that implement the
 * actual logic. Each handler receives params and returns a result or
 * throws an error (caught by the dispatcher).
 */

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import type { Agent, AgentEvent } from '@src/agent'
import type { ModeManager } from '@src/modes/manager'
import type { ModeId } from '@src/modes/types'
import {
  OpenAIChatGPTAuthManager,
  OPENAI_CHATGPT_AUTH_METHODS,
  OPENAI_CHATGPT_PROVIDER,
} from '@src/auth/openai-chatgpt'
import type { OuroborosConfig } from '@src/config'
import { loadConfig, resolveConfigDir } from '@src/config'
import type { LLMFilePart, LLMMessage } from '@src/llm/types'
import { saveConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import { activateSkillForRun } from '@src/skills/skill-invocation'
import { readCheckpoint } from '@src/memory/checkpoints'
import { resolveCheckpointsDir, resolveArtifactPath } from '@src/memory/paths'
import { listArtifacts, readArtifact } from '@src/artifacts/storage'
import type {
  SessionSummary,
  SessionWithMessages,
  TranscriptStore,
  WorkspaceMode,
} from '@src/memory/transcripts'
import type { PermissionLeaseApprovalDetails } from '@src/permission-lease'
import type { WorkerDiffApprovalDetails } from '@src/tools/worker-diff-approval'
import { getEntries, getStats } from '@src/rsi/evolution-log'
import type { ReflectionCheckpoint } from '@src/rsi/types'
import type { DreamOptions, DreamResult, SkillProposal } from '@src/memory/dream'
import { TaskGraphStore, type CreateTaskNodeInput } from '@src/team/task-graph'
import {
  createWorkflowTemplate,
  WORKFLOW_TEMPLATE_NAMES,
  type WorkflowTemplateName,
} from '@src/team/workflow-templates'
import {
  discoverConfiguredSkills,
  listSkills,
  getSkillInfo,
  activateSkill,
} from '@src/tools/skill-manager'
import { JSON_RPC_ERRORS, makeNotification } from './types'
import { writeMessage } from './transport'
import { verifyImageFileMagicBytes } from '@src/utils/image-magic-bytes'
import type { McpManager } from '@src/mcp/manager'
import type { McpServerStatusEntry } from '@src/mcp/types'

// ── Types ────────────────────────────────────────────────────────────

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>

type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

interface ImageAttachmentMetadata {
  path: string
  name: string
  mediaType: SupportedImageMediaType
  sizeBytes: number
}

export interface HandlerContext {
  /**
   * Returns the agent for a session. The session-scoped overload materializes
   * a fresh agent (hydrating its conversation history from SQLite) on first
   * use so that runs in different sessions never share in-memory state.
   *
   * The no-argument form is kept for legacy callers (notably tests and the
   * REPL) and resolves to the agent for `currentSessionId`, or a transient
   * "no session" agent when none has been created yet.
   */
  getAgent: (sessionId?: string) => Agent
  /**
   * Abort the in-flight run for a specific session, if any. With per-session
   * agents, multiple runs can be live concurrently so cancellation is no
   * longer process-wide.
   */
  cancelSessionRun?: (sessionId: string) => boolean
  /**
   * Register or clear the AbortController owning the run for `sessionId`.
   * Pass `null` to deregister when the run finishes.
   */
  registerSessionAbort?: (sessionId: string, abort: AbortController | null) => void
  /**
   * Forget any in-memory agent and abort/clear bookkeeping for a session.
   * Used by `session/delete` so a deleted session can't keep emitting events
   * via a stale agent instance.
   */
  forgetSession?: (sessionId: string) => void
  config: OuroborosConfig
  configDir: string
  /** Directory the CLI process was launched from (process.cwd() at startup). */
  initialCwd: string
  /** Resolved config dir at startup — target for `workspace/clear`. */
  initialConfigDir: string
  transcriptStore: TranscriptStore
  /** Optional process-wide autonomous step limit override. */
  maxStepsOverride?: number
  /**
   * Legacy single-run abort controller. Still populated by the REPL/CLI
   * single-session path; the JSON-RPC server uses `cancelSessionRun` instead.
   */
  currentRunAbort: AbortController | null
  setCurrentRunAbort: (abort: AbortController | null) => void
  /**
   * The session the desktop is currently viewing. Used as the fallback when
   * `agent/run` or `agent/cancel` is called without an explicit `sessionId`.
   * No longer drives end-of-turn persistence — that uses the sessionId
   * captured at the *start* of the run.
   */
  currentSessionId: string | null
  setCurrentSessionId: (sessionId: string | null) => void
  setConfig: (config: OuroborosConfig) => void
  setConfigDir?: (configDir: string) => void
  authManager: OpenAIChatGPTAuthManager
  modeManager: ModeManager
  taskGraphStore?: TaskGraphStore
  respondToAskUser?: (id: string, response: string) => void
  listApprovals?: () => ApprovalItem[]
  respondToApproval?: (id: string, approved: boolean, reason?: string) => ApprovalRespondResult
  /**
   * Drain skill activations accumulated for a specific session since the
   * last call. Per-session so concurrent runs in different sessions don't
   * mix activations. Server-managed — populated by setSkillActivatedHandler
   * in server.ts via AsyncLocalStorage scoping.
   */
  takeSkillActivations?: (sessionId: string) => string[]
  /**
   * Run `fn` inside an async-local scope that pins `sessionId`. The scope
   * is what the global skill-activation handler reads to attribute mid-turn
   * activations to the correct session. When unset (e.g. in unit tests),
   * the wrapper is a no-op pass-through and skill activations don't route
   * by session — fine for tests since they don't exercise multi-session.
   */
  runWithSessionScope?: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>
  /**
   * MCP server manager. Optional so unit tests that don't exercise MCP
   * can omit it. The `mcp/list` and `mcp/restart` handlers report a clear
   * error when this is undefined.
   */
  mcpManager?: McpManager
}

export interface ApprovalItem {
  id: string
  type: string
  description: string
  createdAt: string
  risk?: 'high' | 'medium' | 'low'
  diff?: string
  lease?: PermissionLeaseApprovalDetails
  workerDiff?: WorkerDiffApprovalDetails
  tier?: {
    approvalId: string
    toolName: string
    toolTier: 1 | 2 | 3 | 4
    toolArgs: unknown
    tierLabel: string
    createdAt: string
  }
  /** Skill name when type === 'skill-activation'. */
  skillName?: string
}

export interface ApprovalRespondResult {
  status: string
  message?: string
  lease?: PermissionLeaseApprovalDetails & {
    status: 'pending' | 'active' | 'denied'
    approvedAt?: string
    denialReason?: string
  }
  workerDiff?: WorkerDiffApprovalDetails & {
    reviewStatus: 'approved' | 'rejected'
    approvedAt?: string
    denialReason?: string
  }
  /** Set when responding to a skill-activation approval. */
  skillName?: string
}

// ── Handler errors ───────────────────────────────────────────────────

export class HandlerError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = 'HandlerError'
  }
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_MEDIA_TYPES_BY_EXT: Record<string, SupportedImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

// ── Event-to-notification bridge ─────────────────────────────────────

/**
 * Translates an AgentEvent into a JSON-RPC notification written to stdout.
 *
 * `sessionId` identifies which session's run produced the event so the
 * desktop renderer can route concurrent agent runs without crosstalk. It
 * may be `null` for events that fire outside any session (e.g. a skill
 * activated before the first session is created).
 */
export function bridgeAgentEvent(event: AgentEvent, sessionId: string | null = null): void {
  switch (event.type) {
    case 'context-usage':
      writeMessage(
        makeNotification('agent/contextUsage', {
          sessionId,
          estimatedTotalTokens: event.estimatedTotalTokens,
          contextWindowTokens: event.contextWindowTokens,
          usageRatio: event.usageRatio,
          threshold: event.threshold,
          breakdown: event.breakdown,
          contextWindowSource: event.contextWindowSource,
        }),
      )
      break
    case 'text':
      writeMessage(makeNotification('agent/text', { sessionId, text: event.text }))
      break
    case 'tool-call-start':
      writeMessage(
        makeNotification('agent/toolCallStart', {
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }),
      )
      break
    case 'tool-call-end':
      writeMessage(
        makeNotification('agent/toolCallEnd', {
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        }),
      )
      break
    case 'turn-complete':
      writeMessage(
        makeNotification('agent/turnComplete', {
          sessionId,
          text: event.text,
          iterations: event.iterations,
        }),
      )
      break
    case 'steer-injected':
      writeMessage(
        makeNotification('agent/steerInjected', {
          sessionId,
          steerId: event.steerId,
          iteration: event.iteration,
          text: event.text,
        }),
      )
      break
    case 'steer-orphaned':
      writeMessage(
        makeNotification('agent/steerOrphaned', {
          sessionId,
          reason: event.reason,
          steers: event.steers,
        }),
      )
      break
    case 'turn-aborted':
      writeMessage(
        makeNotification('agent/turnAborted', {
          sessionId,
          iterations: event.iterations,
          partialText: event.partialText,
        }),
      )
      break
    case 'mode-entered':
      writeMessage(
        makeNotification('mode/entered', {
          modeId: event.modeId,
          displayName: event.displayName,
          reason: event.reason,
        }),
      )
      break
    case 'mode-exited':
      writeMessage(
        makeNotification('mode/exited', {
          modeId: event.modeId,
          reason: event.reason,
        }),
      )
      break
    case 'plan-submitted':
      writeMessage(makeNotification('mode/planSubmitted', { sessionId, plan: event.plan }))
      break
    case 'artifact-created':
      writeMessage(
        makeNotification('agent/artifactCreated', {
          sessionId,
          artifactId: event.artifactId,
          version: event.version,
          title: event.title,
          description: event.description,
          path: event.path,
          bytes: event.bytes,
          createdAt: event.createdAt,
        }),
      )
      break
    case 'error':
      writeMessage(
        makeNotification('agent/error', {
          sessionId,
          message: event.error.message,
          recoverable: event.recoverable,
        }),
      )
      break
    case 'subagent-started':
      writeMessage(
        makeNotification('agent/subagentStarted', {
          sessionId,
          runId: event.runId,
          parentSessionId: event.parentSessionId,
          childSessionId: event.childSessionId,
          agentId: event.agentId,
          task: event.task,
          status: event.status,
          startedAt: event.startedAt,
        }),
      )
      break
    case 'subagent-updated':
      writeMessage(
        makeNotification('agent/subagentUpdated', {
          sessionId,
          runId: event.runId,
          parentSessionId: event.parentSessionId,
          childSessionId: event.childSessionId,
          agentId: event.agentId,
          task: event.task,
          status: event.status,
          startedAt: event.startedAt,
          updatedAt: event.updatedAt,
          message: event.message,
        }),
      )
      break
    case 'subagent-completed':
      writeMessage(
        makeNotification('agent/subagentCompleted', {
          sessionId,
          runId: event.runId,
          parentSessionId: event.parentSessionId,
          childSessionId: event.childSessionId,
          agentId: event.agentId,
          task: event.task,
          status: event.status,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          result: event.result,
          workerDiff: event.workerDiff,
        }),
      )
      break
    case 'subagent-failed':
      writeMessage(
        makeNotification('agent/subagentFailed', {
          sessionId,
          runId: event.runId,
          parentSessionId: event.parentSessionId,
          childSessionId: event.childSessionId,
          agentId: event.agentId,
          task: event.task,
          status: event.status,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          error: event.error,
          result: event.result,
          workerDiff: event.workerDiff,
        }),
      )
      break
    case 'permission-lease-check':
      break
    case 'permission-lease-updated':
      writeMessage(
        makeNotification('agent/permissionLeaseUpdated', {
          leaseId: event.leaseId,
          agentRunId: event.agentRunId,
          requestedTools: event.requestedTools,
          requestedPaths: event.requestedPaths,
          requestedBashCommands: event.requestedBashCommands,
          expiresAt: event.expiresAt,
          riskSummary: event.riskSummary,
          risk: event.risk,
          createdAt: event.createdAt,
          status: event.status,
          approvedAt: event.approvedAt,
          denialReason: event.denialReason,
        }),
      )
      break
    case 'team-graph-open':
      writeMessage(makeNotification('team/graphOpen', { graph: event.graph, reason: event.reason }))
      break
    case 'team-graph-updated':
      writeMessage(
        makeNotification('team/graphUpdated', { graph: event.graph, reason: event.reason }),
      )
      break
    case 'rsi-reflection':
      writeMessage(
        makeNotification('rsi/reflection', {
          description: event.reflection.reasoning,
        }),
      )
      break
    case 'rsi-crystallization':
      writeMessage(
        makeNotification('rsi/crystallization', {
          outcome: event.result.outcome,
          skillName: event.result.skillName,
          description: event.result.reflection?.reasoning,
        }),
      )
      break
    case 'rsi-dream':
      writeMessage(
        makeNotification('rsi/dream', {
          message: `Promoted ${event.result.durablePromotions.length} durable items, pruned ${event.result.durablePrunes.length}.`,
        }),
      )
      break
    case 'rsi-observation-recorded':
    case 'rsi-checkpoint-written':
    case 'rsi-context-flushed':
    case 'rsi-history-compacted':
    case 'rsi-length-recovery-succeeded':
    case 'rsi-length-recovery-failed':
    case 'rsi-durable-memory-promoted':
    case 'rsi-durable-memory-pruned':
    case 'rsi-skill-proposed-from-observations':
      writeMessage(
        makeNotification('rsi/runtime', {
          eventType: event.type,
          payload: event,
        }),
      )
      break
    case 'rsi-error':
      writeMessage(
        makeNotification('rsi/error', {
          message: event.error.message,
        }),
      )
      break
  }
}

// ── Handler factory ──────────────────────────────────────────────────

/**
 * Build the method handler map. Each handler is an async function that
 * receives params and returns a result.
 */
export function createHandlers(ctx: HandlerContext): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  const validClients = new Set(['desktop', 'cli'])
  const validResponseStyles = new Set(['default', 'desktop-readable'])
  const validAuthMethods = new Set(OPENAI_CHATGPT_AUTH_METHODS)
  const taskGraphStore = ctx.taskGraphStore ?? new TaskGraphStore()

  const refreshSkills = () => {
    // Scan both the config dir (where .ouroboros lives — may be a parent
    // like ~ when a global config exists) and the current workspace cwd.
    // Workspace-local skills take precedence on name collision.
    // Built-in skills shipped with the desktop bundle are picked up from
    // OUROBOROS_BUILTIN_SKILLS_DIR by discoverConfiguredSkills as the
    // lowest-precedence source.
    discoverConfiguredSkills(
      ctx.config.skillDirectories,
      [ctx.configDir, process.cwd()],
      ctx.config.disabledSkills,
    )
  }
  const toDesktopSkillInfo = (skill: ReturnType<typeof listSkills>[number]) => ({
    name: skill.name,
    description: skill.description,
    status: skill.status,
    path: skill.dirPath,
    version:
      typeof skill.frontmatter.metadata?.version === 'string'
        ? skill.frontmatter.metadata.version
        : '1.0',
    enabled: skill.enabled,
  })

  // ── agent/* ──────────────────────────────────────────────────────

  handlers.set('agent/run', async (params) => {
    const message = params.message
    if (typeof message !== 'string' || message.length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.message is required and must be a non-empty string',
      )
    }
    const client = params.client
    if (client !== undefined && (typeof client !== 'string' || !validClients.has(client))) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.client must be "desktop" or "cli" when provided',
      )
    }
    const responseStyle = params.responseStyle
    if (
      responseStyle !== undefined &&
      (typeof responseStyle !== 'string' || !validResponseStyles.has(responseStyle))
    ) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.responseStyle must be "default" or "desktop-readable" when provided',
      )
    }
    const maxSteps = params.maxSteps
    if (
      maxSteps !== undefined &&
      (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps <= 0)
    ) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.maxSteps must be a positive integer when provided',
      )
    }
    const skillName = params.skillName
    if (skillName !== undefined && (typeof skillName !== 'string' || skillName.length === 0)) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.skillName must be a non-empty string when provided',
      )
    }
    const explicitSessionId = params.sessionId
    if (
      explicitSessionId !== undefined &&
      (typeof explicitSessionId !== 'string' || explicitSessionId.length === 0)
    ) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.sessionId must be a non-empty string when provided',
      )
    }
    const images = validateAndReadImageAttachments(params.images)

    // Pin the run to a specific session. We capture this *once* up front so
    // that `session/new` or `session/load` arriving mid-stream cannot redirect
    // the persistence target. This is the core of the "chats lost on switch
    // back" fix. May be null for legacy CLI single-shot runs that don't
    // bother creating a session — those skip persistence at end-of-turn,
    // matching the prior behavior.
    const sessionId: string | null =
      (typeof explicitSessionId === 'string' && explicitSessionId) || ctx.currentSessionId

    // Drain any leftovers from a previous run *for this session* before
    // activating below. Per-session so concurrent runs in other sessions are
    // unaffected.
    if (sessionId) ctx.takeSkillActivations?.(sessionId)

    const activatedSkill =
      typeof skillName === 'string'
        ? await activateSkillForRun(skillName, ctx.config, ctx.configDir)
        : undefined

    if (activatedSkill && !activatedSkill.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, activatedSkill.error.message)
    }

    // Note: skill/activated notification is emitted from inside activateSkill
    // (see setSkillActivatedHandler wiring in server.ts), so it fires for both
    // user-selected skills (via activateSkillForRun above) and mid-turn LLM
    // activations through the skill-manager tool — single source of truth.

    // Cancel only THIS session's prior run, not other sessions'.
    if (sessionId) ctx.cancelSessionRun?.(sessionId)
    else if (ctx.currentRunAbort) ctx.currentRunAbort.abort()

    const abort = new AbortController()
    ctx.setCurrentRunAbort(abort) // legacy single-run tracking, kept for tests
    if (sessionId) ctx.registerSessionAbort?.(sessionId, abort)

    // Wrap the run in the per-session async scope so the global
    // skill-activation handler can attribute mid-turn activations to this
    // session. Falls through to a plain call when no scope provider is
    // wired (single-session tests) or when no sessionId.
    const runScoped: <T>(id: string, fn: () => Promise<T>) => Promise<T> =
      sessionId && ctx.runWithSessionScope ? ctx.runWithSessionScope : async (_id, fn) => fn()

    try {
      const agent = ctx.getAgent(sessionId ?? undefined)
      const historyBeforeRun = agent.getConversationHistory().length
      const result = await runScoped(sessionId ?? '', () =>
        agent.run(message, {
          responseStyle:
            typeof responseStyle === 'string'
              ? (responseStyle as 'default' | 'desktop-readable')
              : undefined,
          runProfile: client === 'desktop' ? 'desktop' : 'automation',
          maxSteps: maxSteps ?? ctx.maxStepsOverride,
          images,
          activatedSkill: activatedSkill?.value,
          abortSignal: abort.signal,
        }),
      )
      if (sessionId) {
        // Drain skill activations attributed to *this* session — both the
        // user-selected one (via activateSkillForRun above) and any mid-turn
        // LLM activations routed by the AsyncLocalStorage scope in server.ts.
        const activatedSkills = ctx.takeSkillActivations?.(sessionId) ?? []
        const persistResult = persistConversationDelta(
          ctx.transcriptStore,
          sessionId,
          agent.getConversationHistory().slice(historyBeforeRun),
          { activatedSkills },
        )
        if (!persistResult.ok) {
          throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, persistResult.error.message)
        }
        const titleResult = refreshAutoSessionTitle(ctx.transcriptStore, sessionId)
        if (!titleResult.ok) {
          throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, titleResult.error.message)
        }
      }
      return {
        text: result.text,
        iterations: result.iterations,
        stopReason: result.stopReason,
        maxIterationsReached: result.maxIterationsReached,
      }
    } finally {
      ctx.setCurrentRunAbort(null)
      if (sessionId) ctx.registerSessionAbort?.(sessionId, null)
    }
  })

  handlers.set('agent/steer', async (params) => {
    const message = params.message
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.message is required and must be a non-empty string',
      )
    }
    const requestId = params.requestId
    if (typeof requestId !== 'string' || requestId.trim().length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.requestId is required and must be a non-empty string',
      )
    }
    const explicitSessionId = params.sessionId
    if (
      explicitSessionId !== undefined &&
      (typeof explicitSessionId !== 'string' || explicitSessionId.length === 0)
    ) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.sessionId must be a non-empty string when provided',
      )
    }
    const images = validateAndReadImageAttachments(params.images)
    const sessionId: string | null =
      (typeof explicitSessionId === 'string' && explicitSessionId) || ctx.currentSessionId
    if (!sessionId) {
      return { accepted: false, reason: 'no-active-run' }
    }
    const agent = ctx.getAgent(sessionId)
    if (!agent.isRunning()) {
      return { accepted: false, reason: 'no-active-run' }
    }
    const result = agent.enqueueSteer({
      id: requestId,
      text: message,
      ...(images && images.length > 0 ? { images } : {}),
    })
    if (!result.accepted) {
      return { accepted: false, reason: result.reason }
    }
    return { accepted: true, duplicate: result.duplicate ?? false }
  })

  handlers.set('agent/cancel', async (params) => {
    const explicitSessionId = params.sessionId
    if (
      explicitSessionId !== undefined &&
      (typeof explicitSessionId !== 'string' || explicitSessionId.length === 0)
    ) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.sessionId must be a non-empty string when provided',
      )
    }
    const target =
      (typeof explicitSessionId === 'string' && explicitSessionId) || ctx.currentSessionId
    if (target && ctx.cancelSessionRun?.(target)) {
      return { cancelled: true }
    }
    if (ctx.currentRunAbort) {
      ctx.currentRunAbort.abort()
      ctx.setCurrentRunAbort(null)
      return { cancelled: true }
    }
    return { cancelled: false, message: 'No agent run in progress' }
  })

  handlers.set('askUser/respond', async (params) => {
    const id = params.id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }

    const response = params.response
    if (typeof response !== 'string' || response.trim().length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.response is required and must be a non-empty string',
      )
    }

    if (!ctx.respondToAskUser) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'No ask-user prompt is currently pending',
      )
    }

    ctx.respondToAskUser(id, response.trim())
    return { ok: true }
  })

  // ── session/* ────────────────────────────────────────────────────

  handlers.set('session/list', async (params) => {
    const rawLimit = typeof params.limit === 'number' ? params.limit : 20
    const rawOffset = typeof params.offset === 'number' ? params.offset : 0
    const limit = Math.max(0, Math.floor(rawLimit))
    const offset = Math.max(0, Math.floor(rawOffset))
    const result = ctx.transcriptStore.getRecentSessions(limit + 1, offset)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)

    const page = result.value.slice(0, limit)
    const sessionResults = page.map((summary) => toDesktopSessionInfo(summary, ctx.transcriptStore))
    const sessions = []
    for (const session of sessionResults) {
      if (!session.ok) {
        throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, session.error.message)
      }
      sessions.push(session.value)
    }

    return { sessions, hasMore: result.value.length > limit }
  })

  handlers.set('session/load', async (params) => {
    const id = params.id
    if (typeof id !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const result = ctx.transcriptStore.getSession(id)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)

    // Switching the desktop's "current view" is purely a view operation now.
    // The session's agent (if any) keeps running with its own conversation
    // history — see getAgent(sessionId) for hydration. Concurrent sessions
    // are isolated from each other's mid-run state.
    ctx.setCurrentSessionId(id)

    return toDesktopSessionData(result.value)
  })

  handlers.set('session/new', async (params) => {
    // Create a fresh session in SQLite. We deliberately do NOT touch any
    // existing agent: a run from another session can still be in flight,
    // and clobbering its history mid-stream is what caused the original
    // "chats lost on switch back" bug. The new session's agent is
    // materialized on first agent/run via getAgent(sessionId).
    const explicitWorkspaceMode = params.workspaceMode !== undefined
    const workspaceMode = parseWorkspaceMode(params.workspaceMode)
    const requestedWorkspace = parseOptionalString(params.workspacePath, 'params.workspacePath')
    let workspacePath: string | null = null

    if (workspaceMode === 'workspace') {
      if (requestedWorkspace === undefined && explicitWorkspaceMode) {
        throw new HandlerError(
          JSON_RPC_ERRORS.INVALID_PARAMS.code,
          'params.workspacePath is required when workspaceMode is "workspace"',
        )
      }
      workspacePath =
        requestedWorkspace !== undefined
          ? validateWorkspaceDirectory(requestedWorkspace)
          : process.cwd()
    }

    const result = ctx.transcriptStore.createSession(workspacePath, workspaceMode)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)

    if (workspaceMode === 'simple') {
      workspacePath = resolve(ctx.configDir, '.ouroboros-simple-sessions', result.value)
      mkdirSync(workspacePath, { recursive: true })
      const updateResult = ctx.transcriptStore.updateSessionWorkspace(result.value, workspacePath)
      if (!updateResult.ok) {
        throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, updateResult.error.message)
      }
    }

    ctx.setCurrentSessionId(result.value)
    return { sessionId: result.value, workspacePath, workspaceMode }
  })

  handlers.set('session/delete', async (params) => {
    const id = params.id
    if (typeof id !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    // Abort any in-flight run for this session and drop its agent so it can't
    // emit lingering events after deletion.
    ctx.cancelSessionRun?.(id)
    ctx.forgetSession?.(id)
    const result = ctx.transcriptStore.deleteSession(id)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    if (ctx.currentSessionId === id) {
      ctx.setCurrentSessionId(null)
    }
    return { deleted: true }
  })

  handlers.set('session/rename', async (params) => {
    const id = params.id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const title = params.title
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.title is required and must be a non-empty string',
      )
    }
    const cleanedTitle = normalizeManualSessionTitle(title)
    const result = ctx.transcriptStore.updateSessionTitle(id, cleanedTitle, 'manual')
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    return { id, title: cleanedTitle, titleSource: 'manual' }
  })

  // ── config/* ─────────────────────────────────────────────────────

  handlers.set('config/get', async () => {
    return ctx.config
  })

  handlers.set('config/set', async (params) => {
    const path = params.path
    const value = params.value
    if (typeof path !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.path is required')
    }

    // Deep-set the value in the config object
    const updated = deepSet(structuredClone(ctx.config) as Record<string, unknown>, path, value)
    // Re-validate through the config schema by using the raw object
    const { configSchema } = await import('@src/config')
    const parsed = configSchema.safeParse(updated)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${String(i.path.join('.'))}: ${i.message}`)
        .join('; ')
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `Invalid config: ${issues}`)
    }

    // Persist to disk
    const saveResult = saveConfig(ctx.configDir, parsed.data)
    if (!saveResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, saveResult.error.message)
    }

    ctx.setConfig(parsed.data)
    return parsed.data
  })

  handlers.set('config/testConnection', async (params) => {
    const provider =
      typeof params.provider === 'string' ? params.provider : ctx.config.model.provider
    const apiKey = typeof params.apiKey === 'string' ? params.apiKey : undefined
    const baseUrl = typeof params.baseUrl === 'string' ? params.baseUrl : undefined

    if (provider === OPENAI_CHATGPT_PROVIDER) {
      const authResult = await ctx.authManager.testConnection()
      if (!authResult.ok) {
        return { success: false, error: authResult.error.message }
      }
      return { success: true, models: authResult.value.models }
    }

    // Temporarily set the env var so createProvider picks it up
    const envKey =
      provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : provider === 'openai-compatible'
          ? 'OUROBOROS_OPENAI_COMPATIBLE_API_KEY'
          : 'OPENAI_API_KEY'
    const previousValue = process.env[envKey]
    if (apiKey) process.env[envKey] = apiKey

    try {
      const providerResult = createProvider({
        ...ctx.config.model,
        provider: provider as 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt',
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      })
      if (!providerResult.ok) {
        return { success: false, error: providerResult.error.message }
      }
      return { success: true }
    } finally {
      // Restore previous env var
      if (apiKey) {
        if (previousValue !== undefined) {
          process.env[envKey] = previousValue
        } else {
          delete process.env[envKey]
        }
      }
    }
  })

  handlers.set('config/setApiKey', async (params) => {
    const provider = params.provider
    const apiKey = params.apiKey
    if (typeof provider !== 'string' || typeof apiKey !== 'string') {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.provider and params.apiKey are required',
      )
    }
    if (provider === OPENAI_CHATGPT_PROVIDER) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'openai-chatgpt uses interactive auth, not API keys',
      )
    }

    const updatedConfig: OuroborosConfig = {
      ...ctx.config,
      model: {
        ...ctx.config.model,
        provider: provider as 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt',
        apiKey,
      },
    }

    const saveResult = saveConfig(ctx.configDir, updatedConfig)
    if (!saveResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, saveResult.error.message)
    }

    ctx.setConfig(updatedConfig)

    const envKey =
      provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : provider === 'openai-compatible'
          ? 'OUROBOROS_OPENAI_COMPATIBLE_API_KEY'
          : 'OPENAI_API_KEY'
    process.env[envKey] = apiKey
    return { ok: true }
  })

  handlers.set('auth/getStatus', async (params) => {
    const provider = params.provider
    if (provider !== OPENAI_CHATGPT_PROVIDER) {
      return {
        provider,
        connected: false,
        authType: null,
        pending: false,
        availableMethods: [],
        models: [],
      }
    }
    return ctx.authManager.getStatus()
  })

  handlers.set('auth/startLogin', async (params) => {
    const provider = params.provider
    const method = typeof params.method === 'string' ? params.method : 'browser'

    if (provider !== OPENAI_CHATGPT_PROVIDER) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        `Provider "${String(provider)}" does not support interactive login`,
      )
    }
    if (!validAuthMethods.has(method as (typeof OPENAI_CHATGPT_AUTH_METHODS)[number])) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.method must be "browser" or "headless"',
      )
    }

    const startResult = await ctx.authManager.startLogin(
      method as (typeof OPENAI_CHATGPT_AUTH_METHODS)[number],
    )
    if (!startResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, startResult.error.message)
    }
    return startResult.value
  })

  handlers.set('auth/pollLogin', async (params) => {
    const provider = params.provider
    const flowId = params.flowId

    if (provider !== OPENAI_CHATGPT_PROVIDER || typeof flowId !== 'string') {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.provider=openai-chatgpt and params.flowId are required',
      )
    }

    const pollResult = await ctx.authManager.pollLogin(flowId)
    if (!pollResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, pollResult.error.message)
    }
    return pollResult.value
  })

  handlers.set('auth/cancelLogin', async (params) => {
    const provider = params.provider
    const flowId = params.flowId

    if (provider !== OPENAI_CHATGPT_PROVIDER || typeof flowId !== 'string') {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.provider=openai-chatgpt and params.flowId are required',
      )
    }

    const cancelResult = await ctx.authManager.cancelLogin(flowId)
    if (!cancelResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, cancelResult.error.message)
    }
    return cancelResult.value
  })

  handlers.set('auth/logout', async (params) => {
    const provider = params.provider

    if (provider !== OPENAI_CHATGPT_PROVIDER) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        `Provider "${String(provider)}" does not support logout`,
      )
    }

    const logoutResult = await ctx.authManager.logout()
    if (!logoutResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, logoutResult.error.message)
    }
    return { ok: true }
  })

  // ── skills/* ─────────────────────────────────────────────────────

  handlers.set('skills/list', async (params) => {
    refreshSkills()
    const includeDisabled =
      typeof params?.includeDisabled === 'boolean' ? params.includeDisabled : false
    const skills = listSkills({ includeDisabled }).map(toDesktopSkillInfo)
    return { skills }
  })

  handlers.set('skills/get', async (params) => {
    refreshSkills()
    const name = params.name
    if (typeof name !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.name is required')
    }
    const info = getSkillInfo(name)
    if (!info.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, info.error.message)
    }
    if (!info.value.enabled) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `Skill disabled: "${name}"`)
    }
    // Also try to load full instructions
    const activation = await activateSkill(name)
    return {
      ...toDesktopSkillInfo(info.value),
      instructions: activation.ok ? activation.value.instructions : null,
    }
  })

  // ── rsi/* ────────────────────────────────────────────────────────

  handlers.set('rsi/dream', async (params) => {
    const orchestrator = ctx.getAgent().getRSIOrchestrator()
    if (!orchestrator) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INTERNAL_ERROR.code,
        'RSI orchestrator unavailable for this session',
      )
    }

    const dreamOptions: DreamOptions = {}
    const requestedMode = params?.mode
    if (
      requestedMode === 'full' ||
      requestedMode === 'consolidate-only' ||
      requestedMode === 'propose-only'
    ) {
      dreamOptions.mode = requestedMode
    }

    const result = await orchestrator.triggerDream(dreamOptions)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }
    return toRsiDreamResult(result.value)
  })

  handlers.set('rsi/status', async () => {
    // No notion of an in-flight RSI run yet; the dream cycle is invoked
    // synchronously from rsi/dream and emits its own progress notifications.
    return { status: 'idle' as const }
  })

  handlers.set('rsi/history', async (params) => {
    const limit = typeof params.limit === 'number' ? params.limit : undefined
    const checkpoints = listCheckpointSummaries(ctx.configDir, limit)
    if (!checkpoints.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, checkpoints.error.message)
    }

    return { entries: checkpoints.value }
  })

  handlers.set('rsi/checkpoint', async (params) => {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.sessionId is required')
    }

    const checkpointResult = readCheckpoint(sessionId, ctx.configDir)
    if (!checkpointResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, checkpointResult.error.message)
    }

    return {
      checkpoint: checkpointResult.value ? toDesktopCheckpoint(checkpointResult.value) : null,
    }
  })

  // ── evolution/* ──────────────────────────────────────────────────

  handlers.set('evolution/list', async (params) => {
    const limit = typeof params.limit === 'number' ? params.limit : undefined
    const result = getEntries({ limit }, ctx.configDir)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }

    return {
      entries: result.value.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        type: entry.type,
        description: entry.summary,
        sessionId: entry.details.sessionId,
        skillName: entry.details.skillName,
        details: Object.keys(entry.details).length > 0 ? entry.details : undefined,
      })),
    }
  })

  handlers.set('evolution/stats', async () => {
    const result = getStats(ctx.configDir)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }

    return { stats: result.value }
  })

  // ── approval/* ───────────────────────────────────────────────────

  handlers.set('approval/list', async () => {
    return { approvals: ctx.listApprovals?.() ?? [] }
  })

  handlers.set('approval/respond', async (params) => {
    const id = params.id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const approved = params.approved
    if (typeof approved !== 'boolean') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.approved is required')
    }
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    if (!ctx.respondToApproval) {
      return { status: 'not-implemented', message: 'Approval system not yet available' }
    }
    return ctx.respondToApproval(id, approved, reason)
  })

  // ── team/* ───────────────────────────────────────────────────────

  handlers.set('team/create', async (params) => {
    const name = typeof params.name === 'string' ? params.name : undefined
    const tasks = params.tasks === undefined ? undefined : parseTaskInputs(params.tasks)
    const result = taskGraphStore.createGraph({ name, tasks })
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return { graph: result.value }
  })

  handlers.set('team/createWorkflow', async (params) => {
    const template = parseWorkflowTemplateName(params.template)
    const taskContext = requireStringParam(params, 'taskContext')
    const name = typeof params.name === 'string' ? params.name : undefined
    const templateResult = createWorkflowTemplate({ template, taskContext, name })
    if (!templateResult.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, templateResult.error.message)
    }
    const result = taskGraphStore.createGraph(templateResult.value)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return { graph: result.value }
  })

  handlers.set('team/get', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const result = taskGraphStore.getGraph(graphId)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return { graph: result.value }
  })

  handlers.set('team/start', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const result = taskGraphStore.startGraph(graphId)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return { graph: result.value }
  })

  handlers.set('team/cancel', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const result = taskGraphStore.cancelGraph(graphId, reason)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return { graph: result.value }
  })

  handlers.set('team/cleanup', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const result = taskGraphStore.cleanupGraph(graphId)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return result.value
  })

  handlers.set('team/addTask', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const task = parseTaskInput(params.task)
    const result = taskGraphStore.addTask(graphId, task)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return result.value
  })

  handlers.set('team/assignTask', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const taskId = requireStringParam(params, 'taskId')
    const agentId = requireStringParam(params, 'agentId')
    const result = taskGraphStore.assignTask({ graphId, taskId, agentId })
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return result.value
  })

  handlers.set('team/sendMessage', async (params) => {
    const graphId = requireStringParam(params, 'graphId')
    const message = requireStringParam(params, 'message')
    const agentId = typeof params.agentId === 'string' ? params.agentId : undefined
    const taskId = typeof params.taskId === 'string' ? params.taskId : undefined
    const result = taskGraphStore.sendMessage({ graphId, message, agentId, taskId })
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, result.error.message)
    return result.value
  })

  // ── mode/* ───────────────────────────────────────────────────────

  handlers.set('mode/getState', async () => {
    return ctx.modeManager.getActiveMode()
  })

  handlers.set('mode/enter', async (params) => {
    const mode = params.mode
    if (typeof mode !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.mode is required')
    }
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const result = ctx.modeManager.enterMode(mode as ModeId, reason)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }
    return { displayName: result.value }
  })

  handlers.set('mode/exit', async (params) => {
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const result = ctx.modeManager.exitMode(reason)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }
    return { displayName: result.value }
  })

  handlers.set('mode/getPlan', async () => {
    return ctx.modeManager.getCurrentPlan()
  })

  // ── workspace/* ──────────────────────────────────────────────────

  handlers.set('workspace/set', async (params) => {
    const dir = params.directory
    if (typeof dir !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.directory is required')
    }
    try {
      const resolvedDir = resolveConfigDir(dir)
      const configResult = loadConfig(resolvedDir)
      if (!configResult.ok) {
        throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, configResult.error.message)
      }

      process.chdir(dir)
      ctx.setConfig(configResult.value)
      ctx.setConfigDir?.(resolvedDir)
      refreshSkills()

      if (ctx.currentSessionId) {
        const updateResult = ctx.transcriptStore.updateSessionWorkspace(
          ctx.currentSessionId,
          process.cwd(),
        )
        if (!updateResult.ok) {
          throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, updateResult.error.message)
        }
      }

      return { directory: process.cwd() }
    } catch (e) {
      if (e instanceof HandlerError) {
        throw e
      }
      const message = e instanceof Error ? e.message : String(e)
      throw new HandlerError(
        JSON_RPC_ERRORS.INTERNAL_ERROR.code,
        `Failed to change directory: ${message}`,
      )
    }
  })

  // ── artifacts/* ──────────────────────────────────────────────────

  // Artifacts live under the session's workspacePath (e.g. simple-mode
  // sessions write to .ouroboros-simple-sessions/{id}/). Mirror the
  // basePath resolution used for agent construction so reads find them.
  const resolveArtifactsBasePath = (sessionId: string): string => {
    const sessionData = ctx.transcriptStore.getSession(sessionId)
    return sessionData.ok ? (sessionData.value.workspacePath ?? ctx.configDir) : ctx.configDir
  }

  handlers.set('artifacts/list', async (params) => {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.sessionId is required')
    }
    const basePath = resolveArtifactsBasePath(sessionId)
    const result = listArtifacts(sessionId, basePath)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }
    return {
      artifacts: result.value.map((meta) => ({
        artifactId: meta.artifactId,
        version: meta.version,
        sessionId,
        title: meta.title,
        description: meta.description,
        path: resolveArtifactPath(sessionId, meta.artifactId, meta.version, basePath),
        bytes: meta.bytes,
        createdAt: meta.createdAt,
      })),
    }
  })

  handlers.set('artifacts/read', async (params) => {
    const sessionId = params.sessionId
    const artifactId = params.artifactId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.sessionId is required')
    }
    if (typeof artifactId !== 'string' || artifactId.length === 0) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.artifactId is required')
    }
    const versionParam = params.version
    let version: number | undefined
    if (versionParam !== undefined) {
      if (typeof versionParam !== 'number' || !Number.isInteger(versionParam) || versionParam < 1) {
        throw new HandlerError(
          JSON_RPC_ERRORS.INVALID_PARAMS.code,
          'params.version must be a positive integer when provided',
        )
      }
      version = versionParam
    }
    const basePath = resolveArtifactsBasePath(sessionId)
    const result = readArtifact(sessionId, artifactId, version, basePath)
    if (!result.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    }
    const meta = result.value.metadata
    return {
      html: result.value.html,
      artifact: {
        artifactId: meta.artifactId,
        version: meta.version,
        sessionId,
        title: meta.title,
        description: meta.description,
        path: resolveArtifactPath(sessionId, meta.artifactId, meta.version, basePath),
        bytes: meta.bytes,
        createdAt: meta.createdAt,
      },
    }
  })

  handlers.set('workspace/clear', async () => {
    try {
      const configResult = loadConfig(ctx.initialConfigDir)
      if (!configResult.ok) {
        throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, configResult.error.message)
      }

      process.chdir(ctx.initialCwd)
      ctx.setConfig(configResult.value)
      ctx.setConfigDir?.(ctx.initialConfigDir)
      refreshSkills()

      if (ctx.currentSessionId) {
        const updateResult = ctx.transcriptStore.updateSessionWorkspace(
          ctx.currentSessionId,
          process.cwd(),
        )
        if (!updateResult.ok) {
          throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, updateResult.error.message)
        }
      }

      return { directory: process.cwd() }
    } catch (e) {
      if (e instanceof HandlerError) {
        throw e
      }
      const message = e instanceof Error ? e.message : String(e)
      throw new HandlerError(
        JSON_RPC_ERRORS.INTERNAL_ERROR.code,
        `Failed to clear workspace: ${message}`,
      )
    }
  })

  handlers.set('mcp/list', async (): Promise<{ servers: McpServerStatusEntry[] }> => {
    if (!ctx.mcpManager) return { servers: [] }
    return { servers: ctx.mcpManager.getServerStatuses() }
  })

  handlers.set('mcp/restart', async (params) => {
    const name = typeof params.name === 'string' ? params.name : ''
    if (!name) {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'mcp/restart requires "name"')
    }
    if (!ctx.mcpManager) {
      return { ok: false, errorMessage: 'MCP manager not available' }
    }
    const result = await ctx.mcpManager.restartServer(name)
    if (result.ok) return { ok: true }
    return { ok: false, errorMessage: result.error.message }
  })

  return handlers
}

function toDesktopSessionInfo(summary: SessionSummary, transcriptStore: TranscriptStore) {
  if (summary.messageCount === 0) {
    return {
      ok: true as const,
      value: {
        id: summary.id,
        createdAt: summary.startedAt,
        lastActive: summary.endedAt ?? summary.startedAt,
        messageCount: 0,
        title: summary.title ?? summary.summary ?? undefined,
        titleSource: summary.titleSource ?? undefined,
        workspacePath: summary.workspacePath,
        workspaceMode: summary.workspaceMode,
      },
    }
  }

  const sessionResult = transcriptStore.getSession(summary.id)
  if (!sessionResult.ok) {
    return sessionResult
  }

  return {
    ok: true as const,
    value: {
      id: summary.id,
      createdAt: summary.startedAt,
      lastActive:
        sessionResult.value.messages.at(-1)?.createdAt ?? summary.endedAt ?? summary.startedAt,
      messageCount: summary.messageCount,
      title:
        sessionResult.value.title ??
        getSessionTitle(sessionResult.value) ??
        summary.summary ??
        undefined,
      titleSource: sessionResult.value.titleSource ?? undefined,
      workspacePath: summary.workspacePath,
      workspaceMode: summary.workspaceMode,
    },
  }
}

function parseWorkspaceMode(value: unknown): WorkspaceMode {
  if (value === undefined) return 'workspace'
  if (value === 'simple' || value === 'workspace') return value
  throw new HandlerError(
    JSON_RPC_ERRORS.INVALID_PARAMS.code,
    'params.workspaceMode must be "simple" or "workspace" when provided',
  )
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.trim().length > 0) return value
  throw new HandlerError(
    JSON_RPC_ERRORS.INVALID_PARAMS.code,
    `${label} must be a non-empty string when provided`,
  )
}

function validateWorkspaceDirectory(path: string): string {
  const resolved = resolve(path)
  try {
    const stats = statSync(resolved)
    if (!stats.isDirectory()) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.workspacePath must be a directory',
      )
    }
    return resolved
  } catch (error) {
    if (error instanceof HandlerError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.workspacePath must be an existing directory: ${message}`,
    )
  }
}

function validateAndReadImageAttachments(value: unknown): LLMFilePart[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.images must be an array')
  }

  const images: LLMFilePart[] = []
  for (const [index, item] of value.entries()) {
    const metadata = parseIncomingImageAttachment(item, index)
    const image = readImageFilePart(metadata, index)
    if (image) images.push(image)
  }
  return images
}

function requireStringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `params.${name} is required`)
  }
  return value.trim()
}

function parseWorkflowTemplateName(value: unknown): WorkflowTemplateName {
  if (
    typeof value !== 'string' ||
    !WORKFLOW_TEMPLATE_NAMES.includes(value as WorkflowTemplateName)
  ) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.template must be one of: ${WORKFLOW_TEMPLATE_NAMES.join(', ')}`,
    )
  }
  return value as WorkflowTemplateName
}

function parseTaskInputs(value: unknown): CreateTaskNodeInput[] {
  if (!Array.isArray(value)) {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.tasks must be an array')
  }
  return value.map((item, index) => parseTaskInput(item, `params.tasks[${index}]`))
}

function parseTaskInput(value: unknown, path = 'params.task'): CreateTaskNodeInput {
  if (value == null || typeof value !== 'object') {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `${path} must be an object`)
  }
  const record = value as Record<string, unknown>
  const title = record.title
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `${path}.title is required`)
  }

  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    title,
    description: typeof record.description === 'string' ? record.description : undefined,
    dependencies: parseStringArray(record.dependencies, `${path}.dependencies`),
    assignedAgentId:
      typeof record.assignedAgentId === 'string' ? record.assignedAgentId : undefined,
    requiredArtifacts:
      parseStringArray(record.requiredArtifacts, `${path}.requiredArtifacts`) ?? [],
    qualityGates: parseQualityGates(record.qualityGates, `${path}.qualityGates`),
  }
}

function parseStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `${path} must be an array of strings`,
    )
  }
  return value
}

function parseQualityGates(
  value: unknown,
  path: string,
): CreateTaskNodeInput['qualityGates'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, `${path} must be an array`)
  }
  return value.map((item, index) => {
    if (item == null || typeof item !== 'object') {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        `${path}[${index}] must be an object`,
      )
    }
    const record = item as Record<string, unknown>
    if (typeof record.description !== 'string' || record.description.trim().length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        `${path}[${index}].description is required`,
      )
    }
    return {
      id: typeof record.id === 'string' ? record.id : undefined,
      description: record.description,
      required: typeof record.required === 'boolean' ? record.required : undefined,
      status:
        record.status === 'pending' || record.status === 'passed' || record.status === 'failed'
          ? record.status
          : undefined,
    }
  })
}

function parseIncomingImageAttachment(value: unknown, index: number): ImageAttachmentMetadata {
  if (value == null || typeof value !== 'object') {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}] must be an object`,
    )
  }

  const record = value as Record<string, unknown>
  const path = record.path
  const name = record.name
  const mediaType = record.mediaType
  const sizeBytes = record.sizeBytes

  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}].path must be a non-empty string`,
    )
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}].name must be a non-empty string`,
    )
  }
  if (typeof mediaType !== 'string' || !SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}].mediaType must be image/jpeg, image/png, or image/webp`,
    )
  }
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > MAX_IMAGE_BYTES
  ) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}].sizeBytes must be an integer up to 20 MB`,
    )
  }

  const extMediaType = IMAGE_MEDIA_TYPES_BY_EXT[extname(path).toLowerCase()]
  if (!extMediaType || extMediaType !== mediaType) {
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${index}] has an unsupported image file extension`,
    )
  }

  return { path, name, mediaType: mediaType as SupportedImageMediaType, sizeBytes }
}

function readImageFilePart(
  metadata: ImageAttachmentMetadata,
  indexForErrors?: number,
): LLMFilePart | null {
  try {
    const stats = statSync(metadata.path)
    if (!stats.isFile()) {
      if (indexForErrors === undefined) return null
      throw new Error('path is not a file')
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      if (indexForErrors === undefined) return null
      throw new Error('image is larger than 20 MB')
    }
    const extMediaType = IMAGE_MEDIA_TYPES_BY_EXT[extname(metadata.path).toLowerCase()]
    if (!extMediaType || extMediaType !== metadata.mediaType) {
      if (indexForErrors === undefined) return null
      throw new Error('unsupported image file extension')
    }
    // Magic-byte sniff defends against renamed binaries (e.g. id_rsa.png).
    // Mirrors the desktop grant-store check; the CLI handles standalone use
    // and must not depend solely on the desktop boundary.
    if (!verifyImageFileMagicBytes(metadata.path, metadata.mediaType)) {
      if (indexForErrors === undefined) return null
      throw new Error('image content does not match declared format')
    }

    return {
      type: 'file',
      data: readFileSync(metadata.path),
      mediaType: metadata.mediaType,
      filename: metadata.name || basename(metadata.path),
      path: metadata.path,
      sizeBytes: stats.size,
    }
  } catch (error) {
    if (indexForErrors === undefined) return null
    const message = error instanceof Error ? error.message : String(error)
    throw new HandlerError(
      JSON_RPC_ERRORS.INVALID_PARAMS.code,
      `params.images[${indexForErrors}] could not be read: ${message}`,
    )
  }
}

function parseImageAttachmentMetadata(toolArgs: string | null): ImageAttachmentMetadata[] {
  if (!toolArgs) return []
  try {
    const parsed = JSON.parse(toolArgs) as { imageAttachments?: unknown }
    if (!Array.isArray(parsed.imageAttachments)) return []
    return parsed.imageAttachments.filter(isImageAttachmentMetadata)
  } catch {
    return []
  }
}

function isImageAttachmentMetadata(value: unknown): value is ImageAttachmentMetadata {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string' &&
    typeof record.name === 'string' &&
    typeof record.mediaType === 'string' &&
    SUPPORTED_IMAGE_MEDIA_TYPES.has(record.mediaType) &&
    typeof record.sizeBytes === 'number'
  )
}

interface DesktopToolCall {
  id: string
  toolName: string
  input?: unknown
  output?: unknown
  error?: string
}

interface DesktopSessionMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  imageAttachments?: ImageAttachmentMetadata[]
  toolCalls?: DesktopToolCall[]
  activatedSkills?: string[]
}

function parseJsonOrRaw(value: string | null): unknown {
  if (value == null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Pull a string[] off a parsed message-metadata blob. Returns undefined when
 * the blob is missing or the field is not a non-empty string array, so callers
 * can use `if (value) currentAssistant.field = value`.
 */
function readMetadataStringArray(
  metadata: Record<string, unknown> | null,
  key: string,
): string[] | undefined {
  if (!metadata) return undefined
  const value = metadata[key]
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function toDesktopSessionData(session: SessionWithMessages) {
  const messages: DesktopSessionMessage[] = []
  let currentAssistant: DesktopSessionMessage | null = null
  // FIFO queue of tool-calls awaiting a matching tool-result row.
  let pendingByName: Map<string, DesktopToolCall[]> = new Map()

  for (const row of session.messages) {
    if (row.role === 'user') {
      currentAssistant = null
      pendingByName = new Map()
      messages.push({
        role: 'user',
        content: row.content,
        timestamp: row.createdAt,
        imageAttachments: parseImageAttachmentMetadata(row.toolArgs),
      })
      continue
    }

    if (row.role === 'assistant') {
      currentAssistant = {
        role: 'assistant',
        content: row.content,
        timestamp: row.createdAt,
      }
      const activatedSkills = readMetadataStringArray(row.metadata, 'activatedSkills')
      if (activatedSkills) currentAssistant.activatedSkills = activatedSkills
      messages.push(currentAssistant)
      continue
    }

    if (row.role === 'tool-call') {
      if (!currentAssistant) {
        currentAssistant = {
          role: 'assistant',
          content: '',
          timestamp: row.createdAt,
        }
        messages.push(currentAssistant)
      }
      const toolCall: DesktopToolCall = {
        id: row.id,
        toolName: row.toolName ?? 'unknown',
        input: parseJsonOrRaw(row.toolArgs),
      }
      currentAssistant.toolCalls = currentAssistant.toolCalls ?? []
      currentAssistant.toolCalls.push(toolCall)

      const key = toolCall.toolName
      const queue = pendingByName.get(key) ?? []
      queue.push(toolCall)
      pendingByName.set(key, queue)
      continue
    }

    if (row.role === 'tool-result') {
      const key = row.toolName ?? 'unknown'
      const queue = pendingByName.get(key)
      const target = queue?.shift()
      if (!target) continue
      target.output = parseJsonOrRaw(row.content)
      continue
    }
  }

  return {
    id: session.id,
    createdAt: session.startedAt,
    workspacePath: session.workspacePath,
    workspaceMode: session.workspaceMode,
    messages,
  }
}

export function toConversationHistory(session: SessionWithMessages): LLMMessage[] {
  return session.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      if (message.role === 'assistant') {
        return { role: 'assistant' as const, content: message.content }
      }

      const images = parseImageAttachmentMetadata(message.toolArgs)
        .map(readImageFilePart)
        .filter((part): part is LLMFilePart => part != null)

      return {
        role: 'user' as const,
        content:
          images.length > 0
            ? [
                ...(message.content.trim().length > 0
                  ? [{ type: 'text' as const, text: message.content }]
                  : []),
                ...images,
              ]
            : message.content,
      }
    })
}

function getSessionTitle(session: SessionWithMessages): string | undefined {
  const firstUserMessage = session.messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  )

  if (!firstUserMessage) return undefined
  const firstAssistantMessage = session.messages.find(
    (message) => message.role === 'assistant' && message.content.trim().length > 0,
  )
  return deriveCompletedSessionTitle(firstUserMessage.content, firstAssistantMessage?.content)
}

function refreshAutoSessionTitle(transcriptStore: TranscriptStore, sessionId: string) {
  const sessionResult = transcriptStore.getSession(sessionId)
  if (!sessionResult.ok) return sessionResult

  const session = sessionResult.value
  if (session.titleSource === 'manual') return { ok: true as const, value: undefined }

  const title = getSessionTitle(session)
  if (!title || title === session.title) return { ok: true as const, value: undefined }

  return transcriptStore.updateSessionTitle(sessionId, title, 'auto')
}

function normalizeManualSessionTitle(input: string): string {
  return finalizeSessionTitle(input.trim().replace(/\s+/g, ' '))
}

function toSentenceCase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function toRsiDreamSkillProposal(proposal: SkillProposal) {
  return {
    proposedName: proposal.proposedName,
    description: proposal.description,
    estimatedImpact: proposal.estimatedImpact,
  }
}

function toRsiDreamResult(result: DreamResult) {
  return {
    sessionsAnalyzed: result.sessionsAnalyzed,
    topicsMerged: result.topicsMerged,
    topicsCreated: result.topicsCreated,
    topicsPruned: result.topicsPruned,
    contradictionsResolved: result.contradictionsResolved,
    memoryIndexUpdated: result.memoryIndexUpdated,
    durablePromotions: result.durablePromotions,
    durablePrunes: result.durablePrunes,
    contradictionsResolvedEntries: result.contradictionsResolvedEntries,
    dailyMemoryFilesUpdated: result.dailyMemoryFilesUpdated,
    skillProposals: result.skillProposals.map(toRsiDreamSkillProposal),
  }
}

function listCheckpointSummaries(basePath: string, limit?: number) {
  try {
    const checkpointsDir = resolveCheckpointsDir(basePath)
    const files = readdirSync(checkpointsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
      .map((entry) => entry.name.slice(0, -3))

    const checkpoints = files
      .map((sessionId) => {
        const checkpointResult = readCheckpoint(sessionId, basePath)
        if (!checkpointResult.ok || checkpointResult.value == null) {
          return null
        }

        return {
          sessionId: checkpointResult.value.sessionId,
          updatedAt: checkpointResult.value.updatedAt,
          goal: checkpointResult.value.goal,
          nextBestStep: checkpointResult.value.nextBestStep,
          openLoopCount: checkpointResult.value.openLoops.length,
          durableCandidateCount: checkpointResult.value.durableMemoryCandidates.length,
          skillCandidateCount: checkpointResult.value.skillCandidates.length,
        }
      })
      .filter((checkpoint): checkpoint is NonNullable<typeof checkpoint> => checkpoint != null)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))

    return {
      ok: true as const,
      value: limit !== undefined && limit >= 0 ? checkpoints.slice(0, limit) : checkpoints,
    }
  } catch (error) {
    const message =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'Checkpoint directory not found'
        : error instanceof Error
          ? error.message
          : String(error)

    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code === 'ENOENT'
    ) {
      return { ok: true as const, value: [] }
    }

    return { ok: false as const, error: new Error(`Failed to list checkpoints: ${message}`) }
  }
}

function toDesktopCheckpoint(checkpoint: ReflectionCheckpoint) {
  return {
    sessionId: checkpoint.sessionId,
    updatedAt: checkpoint.updatedAt,
    goal: checkpoint.goal,
    currentPlan: checkpoint.currentPlan,
    constraints: checkpoint.constraints,
    decisionsMade: checkpoint.decisionsMade,
    filesInPlay: checkpoint.filesInPlay,
    completedWork: checkpoint.completedWork,
    openLoops: checkpoint.openLoops,
    nextBestStep: checkpoint.nextBestStep,
    durableMemoryCandidates: checkpoint.durableMemoryCandidates,
    skillCandidates: checkpoint.skillCandidates,
  }
}

function finalizeSessionTitle(input: string): string {
  const maxChars = 42
  const words = input
    .replace(/[?.!,;:]+(?=\s|$)/g, '')
    .split(/\s+/)
    .filter(Boolean)
  const limitedWords = words.slice(0, 6).join(' ')
  const candidate =
    limitedWords.length > maxChars
      ? limitedWords.slice(0, maxChars).replace(/\s+\S*$/, '')
      : limitedWords

  return candidate || 'New conversation'
}

function deriveCompletedSessionTitle(userInput: string, assistantResponse?: string): string {
  const initialTitle = deriveSessionTitle(userInput)
  const isWeakInitialTitle =
    initialTitle === 'New conversation' ||
    /^(?:Implement|Update|Fix|Add|Build|Create|Help|Please|Can you|Could you)\b/i.test(
      initialTitle,
    ) ||
    /\b(?:option|recommended direction|above|this|that)\b/i.test(initialTitle)

  if (!assistantResponse || !isWeakInitialTitle) return initialTitle

  const assistantTitle = deriveTitleFromAssistantResponse(assistantResponse)
  return assistantTitle && assistantTitle !== 'New conversation' ? assistantTitle : initialTitle
}

function deriveTitleFromAssistantResponse(response: string): string | undefined {
  const text = response.trim().replace(/\s+/g, ' ')
  if (!text) return undefined

  const matchers: Array<[RegExp, (...matches: string[]) => string]> = [
    [
      /\b(?:implemented|added|built|created|updated|fixed|wired|renamed)\s+(?:the\s+)?(.+?)(?:\.|,|;|\band\b|\bwith\b|\bso\b|$)/i,
      (subject) => toSentenceCase(subject),
    ],
    [
      /\b(?:this|the)\s+change\s+(?:adds|updates|fixes|implements)\s+(.+?)(?:\.|,|;|\band\b|\bwith\b|\bso\b|$)/i,
      (subject) => toSentenceCase(subject),
    ],
  ]

  for (const [pattern, formatter] of matchers) {
    const match = text.match(pattern)
    if (match) {
      const title = finalizeSessionTitle(cleanTitleSubject(formatter(...match.slice(1))))
      if (title !== 'New conversation') return title
    }
  }

  return undefined
}

function cleanTitleSubject(input: string): string {
  return input
    .replace(/\b(?:support|path|flow|feature)\b$/i, '')
    .replace(/\b(?:in|to|for|from|with|by)\s*$/i, '')
    .trim()
}

function deriveSessionTitle(input: string): string {
  let text = input.trim().replace(/\s+/g, ' ')
  if (!text) return 'New conversation'

  text = text
    .replace(/^(?:[#>*-]+\s*)+/, '')
    .replace(/^(?:\/[\w-]+\s+)+/i, '')
    .replace(/^without web search,?\s*/i, '')
    .replace(/^(?:plan|task|question)\s+/i, '')

  const matchers: Array<[RegExp, (...matches: string[]) => string]> = [
    [/^create (?:a )?plan to (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^plan for (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^implement (.+)$/i, (subject) => toSentenceCase(subject)],
    [/^(?:fix|add|build|update|improve|refactor) (.+)$/i, (subject) => toSentenceCase(subject)],
    [/^what are the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [/^what is the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [
      /^what materials are good for use in (.+)$/i,
      (subject) => `${toSentenceCase(subject)} materials`,
    ],
    [/^what materials are good for (.+)$/i, (subject) => `${toSentenceCase(subject)} materials`],
    [/^how to (.+)$/i, (subject) => toSentenceCase(subject)],
  ]

  for (const [pattern, formatter] of matchers) {
    const match = text.match(pattern)
    if (match) {
      return finalizeSessionTitle(
        formatter(...match.slice(1))
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
  }

  text = text
    .replace(/^(?:can you|could you|would you|please|help me|i need to)\s+/i, '')
    .replace(/\bto follow\b/gi, '')
    .replace(/\s+(?:and|or)\s+/gi, ' / ')
    .trim()

  return finalizeSessionTitle(toSentenceCase(text))
}

function persistConversationDelta(
  transcriptStore: TranscriptStore,
  sessionId: string,
  historyDelta: LLMMessage[],
  options: { activatedSkills?: string[] } = {},
) {
  // Attach activated-skills metadata to the FIRST assistant message in this
  // delta only. A run produces at most one user-visible assistant turn from
  // the picker's perspective; subsequent assistant entries (e.g. internal
  // reasoning splits) reuse the same activations conceptually but storing
  // duplicates would just bloat the UI.
  const activatedSkills = options.activatedSkills ?? []
  let assistantSkillsConsumed = false

  for (const message of historyDelta) {
    if (message.role === 'user') {
      const imageAttachments = extractImageAttachmentMetadata(message)
      const addResult = transcriptStore.addMessage(sessionId, {
        role: 'user',
        content: getUserTextForTranscript(message.content),
        ...(imageAttachments.length > 0 ? { toolArgs: { imageAttachments } } : {}),
      })
      if (!addResult.ok) return addResult
      continue
    }

    if (message.role === 'assistant') {
      if (message.content.trim().length > 0) {
        const metadata =
          !assistantSkillsConsumed && activatedSkills.length > 0 ? { activatedSkills } : undefined
        if (metadata) assistantSkillsConsumed = true
        const addResult = transcriptStore.addMessage(sessionId, {
          role: 'assistant',
          content: message.content,
          ...(metadata ? { metadata } : {}),
        })
        if (!addResult.ok) return addResult
      }

      for (const toolCall of message.toolCalls ?? []) {
        const addResult = transcriptStore.addMessage(sessionId, {
          role: 'tool-call',
          content: `${toolCall.toolName}: ${JSON.stringify(toolCall.input)}`,
          toolName: toolCall.toolName,
          toolArgs: toolCall.input,
        })
        if (!addResult.ok) return addResult
      }
      continue
    }

    if (message.role === 'tool') {
      for (const toolResult of message.content) {
        const addResult = transcriptStore.addMessage(sessionId, {
          role: 'tool-result',
          content: JSON.stringify(toolResult.result),
          toolName: toolResult.toolName,
        })
        if (!addResult.ok) return addResult
      }
    }

    function extractImageAttachmentMetadata(message: Extract<LLMMessage, { role: 'user' }>) {
      if (typeof message.content === 'string') return []

      return message.content
        .filter((part): part is LLMFilePart => part.type === 'file')
        .map((part) => ({
          path: part.path ?? '',
          name: part.filename ?? (part.path ? basename(part.path) : 'image'),
          mediaType: part.mediaType as SupportedImageMediaType,
          sizeBytes: part.sizeBytes ?? part.data.byteLength,
        }))
        .filter(
          (metadata) =>
            metadata.path.length > 0 && SUPPORTED_IMAGE_MEDIA_TYPES.has(metadata.mediaType),
        )
    }

    function getUserTextForTranscript(content: Extract<LLMMessage, { role: 'user' }>['content']) {
      if (typeof content === 'string') return content
      return content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    }
  }

  return { ok: true as const, value: undefined }
}

// ── Utility ──────────────────────────────────────────────────────────

/**
 * Deep-set a value in a nested object using a dot-delimited path.
 * e.g. deepSet(obj, "model.name", "gpt-4") sets obj.model.name = "gpt-4"
 */
function deepSet(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }

  current[parts[parts.length - 1]] = value
  return obj
}
