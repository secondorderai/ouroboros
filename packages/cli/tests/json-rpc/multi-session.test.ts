/**
 * Multi-session regression tests for the JSON-RPC server.
 *
 * The original bug: starting a new chat session, sending a message, starting
 * another new chat session, then switching back to the first showed an empty
 * chat. Root cause was that `agent/run` read `ctx.currentSessionId` *after*
 * `await agent.run(...)` resolved, so a `session/new` arriving mid-stream
 * redirected end-of-turn persistence to the wrong session — and `agent.clearHistory()`
 * inside that handler wiped the in-memory history that the still-pending run
 * was building on.
 *
 * These tests run end-to-end against the real handlers + a real (in-memory
 * style) TranscriptStore, so they would fail against the broken code.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LanguageModel } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

import { createHandlers, bridgeAgentEvent, type HandlerContext } from '@src/json-rpc/handlers'
import { Agent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { TranscriptStore } from '@src/memory/transcripts'
import { configSchema } from '@src/config'
import { OpenAIChatGPTAuthManager } from '@src/auth/openai-chatgpt'
import { ModeManager } from '@src/modes/manager'

/**
 * Mock model that emits a single text chunk and finishes. Each call to
 * doStream returns a fresh stream.
 */
function makeMockModel(replyText: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
          c.enqueue({ type: 'text-start', id: 't1' })
          c.enqueue({ type: 'text-delta', id: 't1', delta: replyText })
          c.enqueue({ type: 'text-end', id: 't1' })
          c.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5 },
              outputTokens: { total: 5 },
            },
          } as LanguageModelV3StreamPart)
          c.close()
        },
      }),
      warnings: [],
    }),
  } as LanguageModel
}

/**
 * Build a HandlerContext that mimics the per-session wiring server.ts sets up
 * (per-session agent map, per-session abort, per-session skill activations).
 * The unit-test harness intentionally re-implements the wiring rather than
 * importing from server.ts — that way these tests catch regressions in
 * BOTH the handlers and the server-side multi-session contract.
 */
function createMultiSessionContext(replyText = 'Reply'): {
  ctx: HandlerContext
  cleanup: () => void
} {
  const registry = new ToolRegistry()
  const config = configSchema.parse({})
  const configDir = tmpdir()
  const dbPath = join(configDir, `.ouroboros-multi-session-${crypto.randomUUID()}.db`)
  const transcriptStore = new TranscriptStore(dbPath)

  const agentsBySession = new Map<string, Agent>()
  const abortsBySession = new Map<string, AbortController>()
  const skillActivationsBySession = new Map<string, string[]>()

  function buildAgent(): Agent {
    const opts: AgentOptions = {
      model: makeMockModel(replyText),
      toolRegistry: registry,
      systemPromptBuilder: () => '',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      onEvent: bridgeAgentEvent,
      config,
      basePath: configDir,
    }
    return new Agent(opts)
  }

  function getAgent(sessionId?: string): Agent {
    if (!sessionId) {
      // Anonymous fallback — share a single instance for legacy callers.
      const key = '__anon__'
      const existing = agentsBySession.get(key)
      if (existing) return existing
      const a = buildAgent()
      agentsBySession.set(key, a)
      return a
    }
    const existing = agentsBySession.get(sessionId)
    if (existing) return existing
    const a = buildAgent()
    a.setSessionId(sessionId)
    agentsBySession.set(sessionId, a)
    return a
  }

  let currentRunAbort: AbortController | null = null
  let currentSessionId: string | null = null

  const ctx: HandlerContext = {
    getAgent,
    cancelSessionRun: (sessionId) => {
      const abort = abortsBySession.get(sessionId)
      if (!abort) return false
      abort.abort()
      abortsBySession.delete(sessionId)
      return true
    },
    registerSessionAbort: (sessionId, abort) => {
      if (abort === null) abortsBySession.delete(sessionId)
      else abortsBySession.set(sessionId, abort)
    },
    forgetSession: (sessionId) => {
      abortsBySession.get(sessionId)?.abort()
      abortsBySession.delete(sessionId)
      agentsBySession.delete(sessionId)
      skillActivationsBySession.delete(sessionId)
    },
    config,
    configDir,
    initialCwd: process.cwd(),
    initialConfigDir: configDir,
    transcriptStore,
    currentRunAbort,
    setCurrentRunAbort: (abort) => {
      currentRunAbort = abort
      ctx.currentRunAbort = abort
    },
    currentSessionId,
    setCurrentSessionId: (id) => {
      currentSessionId = id
      ctx.currentSessionId = id
    },
    setConfig: () => {},
    authManager: new OpenAIChatGPTAuthManager(),
    modeManager: new ModeManager(),
    takeSkillActivations: (sessionId) => {
      const list = skillActivationsBySession.get(sessionId)
      if (!list || list.length === 0) return []
      skillActivationsBySession.delete(sessionId)
      return list
    },
    runWithSessionScope: async (_sessionId, fn) => fn(),
  }

  return { ctx, cleanup: () => transcriptStore.close() }
}

describe('multi-session JSON-RPC handlers', () => {
  test("regression: switching to a new session before persisting does not lose the first session's chat", async () => {
    // Reproduces the original "chats lost on switch back" bug.
    const { ctx, cleanup } = createMultiSessionContext('A reply')
    const handlers = createHandlers(ctx)
    try {
      // 1. Create session A and send a message — agent runs to completion.
      const a = (await handlers.get('session/new')!({})) as { sessionId: string }
      expect(a.sessionId).toBeTruthy()
      await handlers.get('agent/run')!({ message: 'A user message' })

      // 2. While the user is "switching" — create session B (which used to
      //    call agent.clearHistory() on the singleton agent and clobber A's
      //    in-memory state).
      const b = (await handlers.get('session/new')!({})) as { sessionId: string }
      expect(b.sessionId).not.toBe(a.sessionId)

      // 3. Switch back to A by loading it.
      const loadResult = (await handlers.get('session/load')!({ id: a.sessionId })) as {
        messages: Array<{ role: string; content: string }>
      }

      // 4. A's full conversation must still be there.
      expect(loadResult.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:A user message',
        'assistant:A reply',
      ])
    } finally {
      cleanup()
    }
  })

  test("agent/run persists to the session it was started for, even if the desktop's view-session changes mid-flight", async () => {
    // This directly exercises the "captured at start, not read at end" fix.
    const { ctx, cleanup } = createMultiSessionContext('A reply')
    const handlers = createHandlers(ctx)
    try {
      const a = (await handlers.get('session/new')!({})) as { sessionId: string }
      const aSessionId = a.sessionId

      // Mid-flight, the desktop switches view: ctx.currentSessionId becomes
      // a fresh session B. We simulate this by calling session/new in the
      // middle. The trick: agent/run already captured `aSessionId` at start,
      // so persistence should still land on A, not B.
      const runPromise = handlers.get('agent/run')!({
        message: 'message for A',
        sessionId: aSessionId,
      })

      // Synchronously create a new session — flips ctx.currentSessionId.
      const b = (await handlers.get('session/new')!({})) as { sessionId: string }
      expect(ctx.currentSessionId).toBe(b.sessionId)

      await runPromise

      const aLoaded = (await handlers.get('session/load')!({ id: aSessionId })) as {
        messages: Array<{ role: string; content: string }>
      }
      const bLoaded = (await handlers.get('session/load')!({ id: b.sessionId })) as {
        messages: Array<{ role: string; content: string }>
      }

      // A got both turns; B is empty.
      expect(aLoaded.messages).toHaveLength(2)
      expect(aLoaded.messages[0]).toMatchObject({ role: 'user', content: 'message for A' })
      expect(bLoaded.messages).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('per-session agents have isolated conversation histories', async () => {
    const { ctx, cleanup } = createMultiSessionContext('Generic reply')
    const handlers = createHandlers(ctx)
    try {
      const a = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'first A turn' })

      const b = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'first B turn' })

      // Each session's agent only sees its own turns — no cross-pollution.
      const agentA = ctx.getAgent(a.sessionId)
      const agentB = ctx.getAgent(b.sessionId)
      expect(agentA).not.toBe(agentB)

      const aHistory = agentA.getConversationHistory()
      const bHistory = agentB.getConversationHistory()
      // Both have a user + assistant turn each.
      expect(aHistory).toHaveLength(2)
      expect(bHistory).toHaveLength(2)
      // Verify the user messages are scoped — A's turn does not appear in B.
      const aText = JSON.stringify(aHistory)
      const bText = JSON.stringify(bHistory)
      expect(aText).toContain('first A turn')
      expect(aText).not.toContain('first B turn')
      expect(bText).toContain('first B turn')
      expect(bText).not.toContain('first A turn')
    } finally {
      cleanup()
    }
  })

  test("session/new no longer corrupts an existing session's agent state", async () => {
    // Verifies the fix to session/new: it should NOT call clearHistory or
    // setSessionId on any existing per-session agent. Before this fix, those
    // calls during a streaming run wiped the in-memory history mid-flight.
    const { ctx, cleanup } = createMultiSessionContext('A reply')
    const handlers = createHandlers(ctx)
    try {
      const a = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'A turn 1' })

      // Snapshot A's agent state right before creating B.
      const agentA = ctx.getAgent(a.sessionId)
      const historyBefore = agentA.getConversationHistory().length
      expect(historyBefore).toBeGreaterThan(0)

      // Creating B must NOT touch agent A.
      await handlers.get('session/new')!({})

      const historyAfter = agentA.getConversationHistory().length
      expect(historyAfter).toBe(historyBefore)
    } finally {
      cleanup()
    }
  })

  test("session/delete cancels the session's in-flight run and forgets its agent", async () => {
    const { ctx, cleanup } = createMultiSessionContext('reply')
    const handlers = createHandlers(ctx)
    try {
      const a = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'turn' })
      const agentBefore = ctx.getAgent(a.sessionId)

      await handlers.get('session/delete')!({ id: a.sessionId })

      // Asking for the agent again should give a fresh one (the old one
      // was forgotten).
      const agentAfter = ctx.getAgent(a.sessionId)
      expect(agentAfter).not.toBe(agentBefore)
    } finally {
      cleanup()
    }
  })
})
