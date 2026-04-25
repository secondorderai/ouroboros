/**
 * Cancellation — verifies that an AbortSignal threaded into agent.run
 * promptly stops a long-running tool and returns with stopReason 'cancelled'.
 */
import { describe, test, expect } from 'bun:test'
import { Agent, type AgentEvent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok, err } from '@src/types'
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
  { type: 'tool-input-start', id: 'call_1', toolName: 'sleeper' },
  { type: 'tool-input-end', id: 'call_1' },
  {
    type: 'tool-call',
    toolCallId: 'call_1',
    toolName: 'sleeper',
    input: '{}',
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    },
  },
]

describe('Agent abort', () => {
  test('cancellation-aware tool exits promptly when abortSignal fires', async () => {
    const registry = new ToolRegistry()
    const events: AgentEvent[] = []

    // Tool that polls abortSignal every 20ms for up to 5s. With prompt cancel,
    // it must bail in well under 5s — we assert under 500ms.
    const sleeperTool: ToolDefinition = {
      name: 'sleeper',
      description: 'sleeps until aborted',
      schema: z.object({}),
      execute: async (_args, ctx?: ToolExecutionContext) => {
        const start = Date.now()
        while (Date.now() - start < 5000) {
          if (ctx?.abortSignal?.aborted) {
            return err(new Error('aborted'))
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return ok({ slept: 5000 })
      },
    }
    registry.register(sleeperTool)

    const model = createMockModel([TOOL_CALL_TURN])
    const agent = new Agent(makeAgentOptions(model, registry, { onEvent: (e) => events.push(e) }))

    const abort = new AbortController()
    const start = Date.now()
    setTimeout(() => abort.abort(), 100)

    const result = await agent.run('do it', { abortSignal: abort.signal })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    expect(result.stopReason).toBe('cancelled')

    const turnAborted = events.find((e) => e.type === 'turn-aborted')
    expect(turnAborted).toBeDefined()
  })

  test('agent.run on a pre-aborted signal returns immediately', async () => {
    const registry = new ToolRegistry()
    const model = createMockModel([])
    const agent = new Agent(makeAgentOptions(model, registry))

    const abort = new AbortController()
    abort.abort()

    const start = Date.now()
    const result = await agent.run('hi', { abortSignal: abort.signal })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(100)
    expect(result.stopReason).toBe('cancelled')
  })

  test('cancel while steers are queued emits a steer-orphaned event with reason "cancelled"', async () => {
    const registry = new ToolRegistry()
    const events: AgentEvent[] = []
    let agentRef!: Agent

    const sleeperTool: ToolDefinition = {
      name: 'sleeper',
      description: 'sleeps until aborted',
      schema: z.object({}),
      execute: async (_args, ctx?: ToolExecutionContext) => {
        // Enqueue a steer while we're already running, then loop until aborted.
        agentRef.enqueueSteer({ id: 'req-cancel', text: 'never injected' })
        while (!ctx?.abortSignal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return err(new Error('aborted'))
      },
    }
    registry.register(sleeperTool)

    const model = createMockModel([TOOL_CALL_TURN])
    agentRef = new Agent(makeAgentOptions(model, registry, { onEvent: (e) => events.push(e) }))

    const abort = new AbortController()
    setTimeout(() => abort.abort(), 80)

    const result = await agentRef.run('go', { abortSignal: abort.signal })
    expect(result.stopReason).toBe('cancelled')

    const orphan = events.find((e) => e.type === 'steer-orphaned')
    expect(orphan).toBeDefined()
    if (orphan?.type === 'steer-orphaned') {
      expect(orphan.reason).toBe('cancelled')
      expect(orphan.steers.map((s) => s.id)).toContain('req-cancel')
    }
  })
})
