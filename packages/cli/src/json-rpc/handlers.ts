/**
 * JSON-RPC Method Handlers
 *
 * Maps JSON-RPC method names to handler functions that implement the
 * actual logic. Each handler receives params and returns a result or
 * throws an error (caught by the dispatcher).
 */

import type { Agent, AgentEvent } from '@src/agent'
import type { OuroborosConfig } from '@src/config'
import type { LLMMessage } from '@src/llm/types'
import { saveConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import type { SessionSummary, SessionWithMessages, TranscriptStore } from '@src/memory/transcripts'
import { listSkills, getSkillInfo, activateSkill } from '@src/tools/skill-manager'
import { JSON_RPC_ERRORS, makeNotification } from './types'
import { writeMessage } from './transport'

// ── Types ────────────────────────────────────────────────────────────

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>

export interface HandlerContext {
  /** Lazily creates the agent on first call. Throws if the provider can't be created (e.g. missing API key). */
  getAgent: () => Agent
  config: OuroborosConfig
  configDir: string
  transcriptStore: TranscriptStore
  /** Set to the abort controller of the current agent run, or null. */
  currentRunAbort: AbortController | null
  setCurrentRunAbort: (abort: AbortController | null) => void
  currentSessionId: string | null
  setCurrentSessionId: (sessionId: string | null) => void
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
  const validClients = new Set(['desktop', 'cli'])
  const validResponseStyles = new Set(['default', 'desktop-readable'])

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

    // Cancel any prior run
    if (ctx.currentRunAbort) {
      ctx.currentRunAbort.abort()
    }

    const abort = new AbortController()
    ctx.setCurrentRunAbort(abort)

    // Run the agent asynchronously. Events are bridged to stdout
    // via the onEvent handler already wired in the server.
    try {
      const agent = ctx.getAgent()
      const historyBeforeRun = agent.getConversationHistory().length
      const result = await agent.run(message, {
        responseStyle:
          typeof responseStyle === 'string'
            ? (responseStyle as 'default' | 'desktop-readable')
            : undefined,
      })
      const sessionId = ctx.currentSessionId
      if (sessionId) {
        const persistResult = persistConversationDelta(
          ctx.transcriptStore,
          sessionId,
          agent.getConversationHistory().slice(historyBeforeRun),
        )
        if (!persistResult.ok) {
          throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, persistResult.error.message)
        }
      }
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

    const sessionResults = result.value.map((summary) =>
      toDesktopSessionInfo(summary, ctx.transcriptStore),
    )
    const sessions = []
    for (const session of sessionResults) {
      if (!session.ok) {
        throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, session.error.message)
      }
      sessions.push(session.value)
    }

    return { sessions }
  })

  handlers.set('session/load', async (params) => {
    const id = params.id
    if (typeof id !== 'string') {
      throw new HandlerError(JSON_RPC_ERRORS.INVALID_PARAMS.code, 'params.id is required')
    }
    const result = ctx.transcriptStore.getSession(id)
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)

    ctx.setCurrentSessionId(id)
    try {
      ctx.getAgent().setConversationHistory(toConversationHistory(result.value))
    } catch {
      /* agent not yet created — session will hydrate on first run */
    }

    return toDesktopSessionData(result.value)
  })

  handlers.set('session/new', async () => {
    // Clear agent conversation history for a fresh session
    try {
      ctx.getAgent().clearHistory()
    } catch {
      /* agent not yet created — nothing to clear */
    }
    const result = ctx.transcriptStore.createSession()
    if (!result.ok)
      throw new HandlerError(JSON_RPC_ERRORS.INTERNAL_ERROR.code, result.error.message)
    ctx.setCurrentSessionId(result.value)
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
    if (ctx.currentSessionId === id) {
      ctx.setCurrentSessionId(null)
      try {
        ctx.getAgent().clearHistory()
      } catch {
        /* agent not yet created — nothing to clear */
      }
    }
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

  handlers.set('config/testConnection', async (params) => {
    const provider =
      typeof params.provider === 'string' ? params.provider : ctx.config.model.provider
    const apiKey = typeof params.apiKey === 'string' ? params.apiKey : undefined

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
        provider: provider as 'anthropic' | 'openai' | 'openai-compatible',
        apiKey,
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

    const updatedConfig: OuroborosConfig = {
      ...ctx.config,
      model: {
        ...ctx.config.model,
        provider: provider as 'anthropic' | 'openai' | 'openai-compatible',
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

function toDesktopSessionInfo(summary: SessionSummary, transcriptStore: TranscriptStore) {
  if (summary.messageCount === 0) {
    return {
      ok: true as const,
      value: {
        id: summary.id,
        createdAt: summary.startedAt,
        lastActive: summary.endedAt ?? summary.startedAt,
        messageCount: 0,
        title: summary.summary ?? undefined,
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
      title: getSessionTitle(sessionResult.value) ?? summary.summary ?? undefined,
    },
  }
}

function toDesktopSessionData(session: SessionWithMessages) {
  return {
    id: session.id,
    createdAt: session.startedAt,
    messages: session.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.createdAt,
      })),
  }
}

function toConversationHistory(session: SessionWithMessages): LLMMessage[] {
  return session.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) =>
      message.role === 'user'
        ? { role: 'user' as const, content: message.content }
        : { role: 'assistant' as const, content: message.content },
    )
}

function getSessionTitle(session: SessionWithMessages): string | undefined {
  const firstUserMessage = session.messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  )

  if (!firstUserMessage) return undefined
  return deriveSessionTitle(firstUserMessage.content)
}

function toSentenceCase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function finalizeSessionTitle(input: string): string {
  const maxChars = 42
  const words = input.split(/\s+/).filter(Boolean)
  const limitedWords = words.slice(0, 6).join(' ')
  const candidate =
    limitedWords.length > maxChars
      ? limitedWords.slice(0, maxChars).replace(/\s+\S*$/, '')
      : limitedWords

  return candidate || 'New conversation'
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
) {
  for (const message of historyDelta) {
    if (message.role === 'user') {
      const addResult = transcriptStore.addMessage(sessionId, {
        role: 'user',
        content: message.content,
      })
      if (!addResult.ok) return addResult
      continue
    }

    if (message.role === 'assistant') {
      if (message.content.trim().length > 0) {
        const addResult = transcriptStore.addMessage(sessionId, {
          role: 'assistant',
          content: message.content,
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
