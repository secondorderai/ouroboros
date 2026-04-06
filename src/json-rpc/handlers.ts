/**
 * JSON-RPC Method Handlers
 *
 * Maps JSON-RPC method names to handler functions that implement the
 * actual logic. Each handler receives params and returns a result or
 * throws an error (caught by the dispatcher).
 */

import type { Agent, AgentEvent } from '@src/agent'
import type { OuroborosConfig } from '@src/config'
import { saveConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import { TranscriptStore } from '@src/memory/transcripts'
import { listSkills, getSkillInfo, activateSkill } from '@src/tools/skill-manager'
import { JSON_RPC_ERRORS, makeNotification } from './types'
import { writeMessage } from './transport'

// ── Types ────────────────────────────────────────────────────────────

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>

export interface HandlerContext {
  agent: Agent
  config: OuroborosConfig
  configDir: string
  transcriptStore: TranscriptStore
  /** Set to the abort controller of the current agent run, or null. */
  currentRunAbort: AbortController | null
  setCurrentRunAbort: (abort: AbortController | null) => void
  setConfig: (config: OuroborosConfig) => void
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

// ── Event-to-notification bridge ─────────────────────────────────────

/**
 * Translates an AgentEvent into a JSON-RPC notification written to stdout.
 */
export function bridgeAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'text':
      writeMessage(makeNotification('agent/text', { text: event.text }))
      break
    case 'tool-call-start':
      writeMessage(
        makeNotification('agent/toolCallStart', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }),
      )
      break
    case 'tool-call-end':
      writeMessage(
        makeNotification('agent/toolCallEnd', {
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
          text: event.text,
          iterations: event.iterations,
        }),
      )
      break
    case 'error':
      writeMessage(
        makeNotification('agent/error', {
          message: event.error.message,
          recoverable: event.recoverable,
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

  // ── agent/* ──────────────────────────────────────────────────────

  handlers.set('agent/run', async (params) => {
    const message = params.message
    if (typeof message !== 'string' || message.length === 0) {
      throw new HandlerError(
        JSON_RPC_ERRORS.INVALID_PARAMS.code,
        'params.message is required and must be a non-empty string',
      )
    }

    // Cancel any prior run
    if (ctx.currentRunAbort) {
      ctx.currentRunAbort.abort()
    }

    const abort = new AbortController()
    ctx.setCurrentRunAbort(abort)

    // Run the agent asynchronously. Events are bridged to stdout
    // via the onEvent handler already wired in the server.
    try {
      const result = await ctx.agent.run(message)
      return {
        text: result.text,
        iterations: result.iterations,
        maxIterationsReached: result.maxIterationsReached,
      }
    } finally {
      ctx.setCurrentRunAbort(null)
    }
  })

  handlers.set('agent/cancel', async () => {
    if (ctx.currentRunAbort) {
      ctx.currentRunAbort.abort()
      ctx.setCurrentRunAbort(null)
      return { cancelled: true }
    }
    return { cancelled: false, message: 'No agent run in progress' }
  })

  // ── session/* ────────────────────────────────────────────────────

  handlers.set('session/list', async (params) => {
    const limit = typeof params.limit === 'number' ? params.limit : 20
    const result = ctx.transcriptStore.getRecentSessions(limit)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    return { sessions: result.value }
  })

  handlers.set('session/load', async (params) => {
    const id = params.id
    if (typeof id !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const result = ctx.transcriptStore.getSession(id)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    return result.value
  })

  handlers.set('session/new', async () => {
    // Clear agent conversation history for a fresh session
    ctx.agent.clearHistory()
    const result = ctx.transcriptStore.createSession()
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    return { sessionId: result.value }
  })

  handlers.set('session/delete', async (params) => {
    const id = params.id
    if (typeof id !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const result = ctx.transcriptStore.deleteSession(id)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    return { deleted: true }
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

  handlers.set('config/testConnection', async () => {
    // Basic structure — create provider and verify it doesn't error
    const providerResult = createProvider(ctx.config.model)
    if (!providerResult.ok) {
      return { connected: false, error: providerResult.error.message }
    }
    return { connected: true }
  })

  // ── skills/* ─────────────────────────────────────────────────────

  handlers.set('skills/list', async () => {
    const skills = listSkills()
    return { skills }
  })

  handlers.set('skills/get', async (params) => {
    const name = params.name
    if (typeof name !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.name is required')
    }
    const info = getSkillInfo(name)
    if (!info.ok) {
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, info.error.message)
    }
    // Also try to load full instructions
    const activation = activateSkill(name)
    return {
      ...info.value,
      instructions: activation.ok ? activation.value.instructions : null,
    }
  })

  // ── rsi/* ────────────────────────────────────────────────────────

  handlers.set('rsi/dream', async () => {
    // RSI orchestrator not yet implemented — stub
    return { status: 'not-implemented', message: 'RSI orchestrator not yet available' }
  })

  handlers.set('rsi/status', async () => {
    // RSI orchestrator not yet implemented — stub
    return { status: 'idle', message: 'RSI orchestrator not yet available' }
  })

  // ── evolution/* ──────────────────────────────────────────────────

  handlers.set('evolution/list', async () => {
    // Evolution log not yet implemented — stub
    return { entries: [], message: 'Evolution log not yet available' }
  })

  handlers.set('evolution/stats', async () => {
    // Evolution log not yet implemented — stub
    return { stats: {}, message: 'Evolution log not yet available' }
  })

  // ── approval/* ───────────────────────────────────────────────────

  handlers.set('approval/list', async () => {
    // Approval queue not yet implemented — return empty
    return { approvals: [] }
  })

  handlers.set('approval/respond', async () => {
    // Approval queue not yet implemented
    return { status: 'not-implemented', message: 'Approval system not yet available' }
  })

  // ── workspace/* ──────────────────────────────────────────────────

  handlers.set('workspace/set', async (params) => {
    const dir = params.directory
    if (typeof dir !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.directory is required')
    }
    try {
      process.chdir(dir)
      return { directory: process.cwd() }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new HandlerError(
        JSON_RPC_ERRORS.INTERNAL_ERROR.code,
        `Failed to change directory: ${message}`,
      )
    }
  })

  return handlers
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
