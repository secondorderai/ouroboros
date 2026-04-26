/**
 * Mid-flight steering — unit tests for `Agent.enqueueSteer` and the drain
 * point at the top of each ReAct iteration.
 */
import { describe, test, expect } from 'bun:test'
import { Agent, type AgentEvent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok } from '@src/types'
import type { ToolDefinition, ToolExecutionContext } from '@src/tools/types'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

function createMockModel(turns: LanguageModelV3StreamPart[][]): LanguageModel {
  let turnIndex = 0
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not used by agent — use doStream')
    },
    doStream: async () => {
      const parts = turns[turnIndex] ?? []
      turnIndex++
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  } as LanguageModel
}

function makeAgentOptions(
  model: LanguageModel,
  registry: ToolRegistry,
  overrides?: Partial<AgentOptions>,
): AgentOptions {
  return {
    model,
    toolRegistry: registry,
    systemPromptBuilder: () => 'You are a test assistant.',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
    ...overrides,
  }
}

const TOOL_CALL_TURN: LanguageModelV3StreamPart[] = [
  { type: 'tool-input-start', id: 'call_1', toolName: 'noop' },
  { type: 'tool-input-end', id: 'call_1' },
  {
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'noop',
    input: '{}',
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
  },
]

const FINAL_TEXT_TURN: LanguageModelV3StreamPart[] = [
  { type: 'text-start', id: 'tx1' },
  { type: 'text-delta', id: 'tx1', delta: 'done' },
  { type: 'text-end', id: 'tx1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 12, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    },
  },
]

describe('Agent.enqueueSteer', () => {
  test('rejects when the agent is not currently running', () => {
    const model = createMockModel([FINAL_TEXT_TURN])
    const agent = new Agent(makeAgentOptions(model, new ToolRegistry()))
    const result = agent.enqueueSteer({ id: 'req-1', text: 'hello' })
    expect(result).toEqual({ accepted: false, reason: 'no-active-run' })
    expect(agent.isRunning()).toBe(false)
  })

  test('accepts a steer mid-run via a tool callback and drains it before the next LLM call', async () => {
    const events: AgentEvent[] = []
    const registry = new ToolRegistry()

    let agentRef!: Agent

    // The fake tool runs during turn 1 and uses the agent reference to enqueue
    // a steer. Drain happens at the top of turn 2 — we then assert the steer
    // landed in conversationHistory before the second streamText call.
    const noopTool: ToolDefinition = {
      name: 'noop',
      description: 'no-op',
      schema: z.object({}),
      execute: async (_args, _ctx?: ToolExecutionContext) => {
        const result = agentRef.enqueueSteer({ id: 'req-mid-1', text: 'pivot to plan B' })
        expect(result.accepted).toBe(true)
        return ok({ ok: true })
      },
    }
    registry.register(noopTool)

    const model = createMockModel([TOOL_CALL_TURN, FINAL_TEXT_TURN])
    agentRef = new Agent(
      makeAgentOptions(model, registry, {
        onEvent: (e) => events.push(e),
      }),
    )

    const result = await agentRef.run('do something')
    expect(result.stopReason).toBe('completed')
    expect(result.iterations).toBe(2)

    const history = agentRef.getConversationHistory()
    // Expected shape: [user prompt, assistant tool call, tool result, user steer, assistant final]
    const userTurns = history.filter((m) => m.role === 'user')
    expect(userTurns).toHaveLength(2)
    const steerTurn = userTurns[1]!
    const text =
      typeof steerTurn.content === 'string'
        ? steerTurn.content
        : steerTurn.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('')
    expect(text).toBe('pivot to plan B')

    const injected = events.find((e) => e.type === 'steer-injected')
    expect(injected).toBeDefined()
    if (injected?.type === 'steer-injected') {
      expect(injected.steerId).toBe('req-mid-1')
      expect(injected.iteration).toBe(2)
      expect(injected.text).toBe('pivot to plan B')
    }

    // Steer was drained — no orphan event should fire for the same id.
    const orphan = events.find((e) => e.type === 'steer-orphaned')
    expect(orphan).toBeUndefined()
  })

  test('idempotent: same requestId is accepted but only injected once', async () => {
    const registry = new ToolRegistry()
    let agentRef!: Agent

    const noopTool: ToolDefinition = {
      name: 'noop',
      description: 'no-op',
      schema: z.object({}),
      execute: async () => {
        agentRef.enqueueSteer({ id: 'dup', text: 'same' })
        const second = agentRef.enqueueSteer({ id: 'dup', text: 'same' })
        expect(second).toEqual({ accepted: true, duplicate: true })
        return ok({ ok: true })
      },
    }
    registry.register(noopTool)

    const events: AgentEvent[] = []
    const model = createMockModel([TOOL_CALL_TURN, FINAL_TEXT_TURN])
    agentRef = new Agent(makeAgentOptions(model, registry, { onEvent: (e) => events.push(e) }))
    await agentRef.run('go')

    const injectedEvents = events.filter((e) => e.type === 'steer-injected')
    expect(injectedEvents).toHaveLength(1)
  })

  test('orphans pending steers when run completes with empty queue check', async () => {
    // Steer arrives during the FINAL streaming turn (no upcoming tool call):
    // there is no safe injection seam, so the agent must orphan it on exit.
    const registry = new ToolRegistry()
    let agentRef!: Agent

    const events: AgentEvent[] = []

    // Inject the steer through onEvent: when we see the very first text
    // delta, enqueue the steer. The run is mid-stream of a final answer, so
    // by the time the run returns the queue is non-empty and must orphan.
    const onEvent = (e: AgentEvent) => {
      events.push(e)
      if (e.type === 'text' && events.filter((x) => x.type === 'text').length === 1) {
        agentRef.enqueueSteer({ id: 'late', text: 'too-late' })
      }
    }

    const model = createMockModel([FINAL_TEXT_TURN])
    agentRef = new Agent(makeAgentOptions(model, registry, { onEvent }))
    const result = await agentRef.run('hi')
    expect(result.stopReason).toBe('completed')

    const orphan = events.find((e) => e.type === 'steer-orphaned')
    expect(orphan).toBeDefined()
    if (orphan?.type === 'steer-orphaned') {
      expect(orphan.reason).toBe('turn-completed')
      expect(orphan.steers).toEqual([{ id: 'late', text: 'too-late' }])
    }
  })
})
