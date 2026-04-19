import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent, type AgentEvent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok } from '@src/types'
import { configSchema } from '@src/config'
import type { ToolDefinition } from '@src/tools/types'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Create a mock LanguageModelV3 that yields predetermined stream parts
 * across multiple turns. Each call to doStream() consumes the next entry
 * from the `turns` array.
 */
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
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  } as LanguageModel
}

/** Create a simple tool definition for testing. */
function makeTool(
  name: string,
  handler?: (args: Record<string, unknown>) => unknown,
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    schema: z.object({ input: z.string().optional() }),
    execute: async (args) =>
      ok(handler ? handler(args as Record<string, unknown>) : { output: `${name} executed` }),
  }
}

/** Collect all events from an agent run. */
function collectEvents(): { events: AgentEvent[]; handler: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, handler: (e: AgentEvent) => events.push(e) }
}

/** Build default agent options with overrides. */
function makeAgentOptions(
  model: LanguageModel,
  registry: ToolRegistry,
  overrides?: Partial<AgentOptions>,
): AgentOptions {
  return {
    model,
    toolRegistry: registry,
    // Override system prompt builder and providers to avoid filesystem access
    systemPromptBuilder: () => 'You are a test assistant.',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
    ...overrides,
  }
}

// ── Feature Tests ────────────────────────────────────────────────────

describe('Agent', () => {
  let registry: ToolRegistry
  let originalCwd: string

  beforeEach(() => {
    registry = new ToolRegistry()
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  // -------------------------------------------------------------------
  // Test: Simple text response (no tool calls)
  // -------------------------------------------------------------------
  describe('simple text response', () => {
    test('agent emits text chunks and turn completes with full text', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'Hello' },
          { type: 'text-delta', id: 'tx1', delta: ', world!' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const { events, handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Say hello')

      expect(result.text).toBe('Hello, world!')
      expect(result.iterations).toBe(1)
      expect(result.maxIterationsReached).toBe(false)

      // Check text events were emitted
      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents).toHaveLength(2)
      expect(textEvents[0]).toEqual({ type: 'text', text: 'Hello' })
      expect(textEvents[1]).toEqual({ type: 'text', text: ', world!' })

      // Check turn-complete event
      const turnComplete = events.find((e) => e.type === 'turn-complete')
      expect(turnComplete).toBeDefined()
      if (turnComplete?.type === 'turn-complete') {
        expect(turnComplete.text).toBe('Hello, world!')
        expect(turnComplete.iterations).toBe(1)
      }
    })
  })

  // -------------------------------------------------------------------
  // Test: Single tool call round-trip
  // -------------------------------------------------------------------
  describe('single tool call round-trip', () => {
    test('agent calls tool, injects result, and LLM produces final response', async () => {
      registry.register(makeTool('bash', () => ({ output: 'hi\n', exitCode: 0 })))

      const model = createMockModel([
        // Turn 1: LLM responds with a tool call
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"echo hi"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 15, text: undefined, reasoning: undefined },
            },
          },
        ],
        // Turn 2: LLM produces final text after seeing tool result
        [
          { type: 'text-start', id: 'tx2' },
          { type: 'text-delta', id: 'tx2', delta: 'The command output: hi' },
          { type: 'text-end', id: 'tx2' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 30,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 10, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const { events, handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Run echo hi')

      expect(result.text).toBe('The command output: hi')
      expect(result.iterations).toBe(2)

      // Check tool events
      const toolStarts = events.filter((e) => e.type === 'tool-call-start')
      expect(toolStarts).toHaveLength(1)
      if (toolStarts[0]?.type === 'tool-call-start') {
        expect(toolStarts[0].toolName).toBe('bash')
        expect(toolStarts[0].toolCallId).toBe('call_1')
      }

      const toolEnds = events.filter((e) => e.type === 'tool-call-end')
      expect(toolEnds).toHaveLength(1)
      if (toolEnds[0]?.type === 'tool-call-end') {
        expect(toolEnds[0].toolName).toBe('bash')
        expect(toolEnds[0].isError).toBe(false)
      }

      // Verify conversation history includes tool call and result
      const history = agent.getConversationHistory()
      const toolMsg = history.find((m) => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      if (toolMsg?.role === 'tool') {
        expect(toolMsg.content).toHaveLength(1)
        expect(toolMsg.content[0].toolCallId).toBe('call_1')
        expect(toolMsg.content[0].toolName).toBe('bash')
      }
    })
  })

  // -------------------------------------------------------------------
  // Test: Multi-tool response
  // -------------------------------------------------------------------
  describe('multi-tool response', () => {
    test('multiple tool calls in one LLM response are executed and results injected', async () => {
      registry.register(makeTool('file-read', (args) => ({ content: `contents of ${args.input}` })))
      registry.register(makeTool('bash', () => ({ output: 'done', exitCode: 0 })))

      const model = createMockModel([
        // Turn 1: LLM responds with two tool calls
        [
          { type: 'tool-input-start', id: 'call_a', toolName: 'file-read' },
          { type: 'tool-input-end', id: 'call_a' },
          {
            type: 'tool-call',
            toolCallId: 'call_a',
            toolName: 'file-read',
            input: '{"input":"file1.txt"}',
          },
          { type: 'tool-input-start', id: 'call_b', toolName: 'file-read' },
          { type: 'tool-input-end', id: 'call_b' },
          {
            type: 'tool-call',
            toolCallId: 'call_b',
            toolName: 'file-read',
            input: '{"input":"file2.txt"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 20, text: undefined, reasoning: undefined },
            },
          },
        ],
        // Turn 2: LLM produces final text
        [
          { type: 'text-start', id: 'tx2' },
          { type: 'text-delta', id: 'tx2', delta: 'Both files have been read.' },
          { type: 'text-end', id: 'tx2' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 50,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 10, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const { events, handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Read two files')

      expect(result.text).toBe('Both files have been read.')
      expect(result.iterations).toBe(2)

      // Both tool calls should have been made
      const toolStarts = events.filter((e) => e.type === 'tool-call-start')
      expect(toolStarts).toHaveLength(2)

      const toolEnds = events.filter((e) => e.type === 'tool-call-end')
      expect(toolEnds).toHaveLength(2)

      // Verify both results were injected
      const history = agent.getConversationHistory()
      const toolMsg = history.find((m) => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      if (toolMsg?.role === 'tool') {
        expect(toolMsg.content).toHaveLength(2)
        expect(toolMsg.content[0].toolCallId).toBe('call_a')
        expect(toolMsg.content[1].toolCallId).toBe('call_b')
      }
    })
  })

  // -------------------------------------------------------------------
  // Test: Multi-turn conversation
  // -------------------------------------------------------------------
  describe('multi-turn conversation', () => {
    test('agent remembers prior turns within a session', async () => {
      // Turn 1: user says name, LLM acknowledges
      // Turn 2: user asks name, LLM recalls from history
      let callCount = 0
      const model = {
        specificationVersion: 'v3',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},

        doGenerate: async () => {
          throw new Error('Not used')
        },

        doStream: async ({ prompt }: { prompt: unknown }) => {
          callCount++
          // Check that the conversation history grows between turns
          const messageCount = (prompt as unknown[]).length

          let responseText: string
          const textId = `tx${callCount}`
          if (callCount === 1) {
            responseText = 'Nice to meet you, Alice!'
          } else {
            // On second call, the conversation should contain prior messages
            // (system + user1 + assistant1 + user2 = at least 4 messages)
            expect(messageCount).toBeGreaterThanOrEqual(4)
            responseText = 'Your name is Alice.'
          }

          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'text-start', id: textId })
                controller.enqueue({ type: 'text-delta', id: textId, delta: responseText })
                controller.enqueue({ type: 'text-end', id: textId })
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 10, text: undefined, reasoning: undefined },
                  },
                })
                controller.close()
              },
            }),
            warnings: [],
          }
        },
      } as LanguageModel

      const agent = new Agent(makeAgentOptions(model, registry))

      const result1 = await agent.run('My name is Alice')
      expect(result1.text).toBe('Nice to meet you, Alice!')

      const result2 = await agent.run("What's my name?")
      expect(result2.text).toBe('Your name is Alice.')

      // Verify conversation history has all 4 messages (user, assistant, user, assistant)
      const history = agent.getConversationHistory()
      expect(history).toHaveLength(4)
      expect(history[0]).toEqual({ role: 'user', content: 'My name is Alice' })
      expect(history[1]).toEqual({ role: 'assistant', content: 'Nice to meet you, Alice!' })
      expect(history[2]).toEqual({ role: 'user', content: "What's my name?" })
      expect(history[3]).toEqual({ role: 'assistant', content: 'Your name is Alice.' })
    })
  })

  // -------------------------------------------------------------------
  // Test: Max step guard
  // -------------------------------------------------------------------
  describe('max step guard', () => {
    test('loop stops after max steps and returns a handoff summary', async () => {
      registry.register(makeTool('bash', () => ({ output: 'looping' })))

      // Mock LLM that always responds with a tool call (infinite loop)
      let callCount = 0
      const model = {
        specificationVersion: 'v3',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},

        doGenerate: async () => {
          throw new Error('Not used')
        },

        doStream: async () => {
          callCount++
          if (callCount === 4) {
            return {
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  controller.enqueue({ type: 'text-start', id: 'summary' })
                  controller.enqueue({
                    type: 'text-delta',
                    id: 'summary',
                    delta: 'Summary: stopped after looping. Next step: continue if needed.',
                  })
                  controller.enqueue({ type: 'text-end', id: 'summary' })
                  controller.enqueue({
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: {
                        total: 10,
                        noCache: undefined,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 5, text: undefined, reasoning: undefined },
                    },
                  })
                  controller.close()
                },
              }),
              warnings: [],
            }
          }

          const callId = `call_${Date.now()}_${Math.random()}`
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'tool-input-start', id: callId, toolName: 'bash' })
                controller.enqueue({ type: 'tool-input-end', id: callId })
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: callId,
                  toolName: 'bash',
                  input: '{"input":"loop"}',
                })
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 5, text: undefined, reasoning: undefined },
                  },
                })
                controller.close()
              },
            }),
            warnings: [],
          }
        },
      } as LanguageModel

      const { events, handler } = collectEvents()
      const agent = new Agent(
        makeAgentOptions(model, registry, {
          maxIterations: 3,
          onEvent: handler,
        }),
      )

      const result = await agent.run('Do something')

      expect(result.maxIterationsReached).toBe(true)
      expect(result.stopReason).toBe('max_steps')
      expect(result.iterations).toBe(3)
      expect(result.text).toContain('Summary: stopped after looping')

      // Should have emitted a turn-complete event
      const turnComplete = events.find((e) => e.type === 'turn-complete')
      expect(turnComplete).toBeDefined()
    })

    test('uses profile-specific maxSteps from config', async () => {
      registry.register(makeTool('bash', () => ({ output: 'looping' })))

      async function runWithProfile(
        profile: 'interactive' | 'desktop' | 'singleShot' | 'automation',
      ) {
        let callCount = 0
        const model = {
          specificationVersion: 'v3',
          provider: 'mock',
          modelId: 'mock-model',
          supportedUrls: {},
          doGenerate: async () => {
            throw new Error('Not used')
          },
          doStream: async () => {
            callCount++
            const isSummaryCall = callCount > 4
            const textId = isSummaryCall ? 'summary' : `tool-${callCount}`
            return {
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  if (isSummaryCall) {
                    controller.enqueue({ type: 'text-start', id: textId })
                    controller.enqueue({ type: 'text-delta', id: textId, delta: 'Limit summary.' })
                    controller.enqueue({ type: 'text-end', id: textId })
                    controller.enqueue({
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: 'stop' },
                      usage: {
                        inputTokens: {
                          total: 10,
                          noCache: undefined,
                          cacheRead: undefined,
                          cacheWrite: undefined,
                        },
                        outputTokens: { total: 5, text: undefined, reasoning: undefined },
                      },
                    })
                    controller.close()
                    return
                  }

                  const callId = `call_${callCount}`
                  controller.enqueue({ type: 'tool-input-start', id: callId, toolName: 'bash' })
                  controller.enqueue({ type: 'tool-input-end', id: callId })
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: callId,
                    toolName: 'bash',
                    input: '{"input":"loop"}',
                  })
                  controller.enqueue({
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: {
                      inputTokens: {
                        total: 10,
                        noCache: undefined,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 5, text: undefined, reasoning: undefined },
                    },
                  })
                  controller.close()
                },
              }),
              warnings: [],
            }
          },
        } as LanguageModel

        const config = configSchema.parse({
          agent: {
            maxSteps: {
              interactive: 1,
              desktop: 2,
              singleShot: 3,
              automation: 4,
            },
          },
        })
        const agent = new Agent(makeAgentOptions(model, registry, { config }))
        return agent.run('Loop', { runProfile: profile })
      }

      await expect(runWithProfile('interactive')).resolves.toMatchObject({
        iterations: 1,
        stopReason: 'max_steps',
      })
      await expect(runWithProfile('desktop')).resolves.toMatchObject({
        iterations: 2,
        stopReason: 'max_steps',
      })
      await expect(runWithProfile('singleShot')).resolves.toMatchObject({
        iterations: 3,
        stopReason: 'max_steps',
      })
      await expect(runWithProfile('automation')).resolves.toMatchObject({
        iterations: 4,
        stopReason: 'max_steps',
      })
    })
  })

  // -------------------------------------------------------------------
  // Test: LLM error recovery
  // -------------------------------------------------------------------
  describe('LLM error recovery', () => {
    test('agent handles LLM error and recovers on retry', async () => {
      let callCount = 0
      const model = {
        specificationVersion: 'v3',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},

        doGenerate: async () => {
          throw new Error('Not used')
        },

        doStream: async () => {
          callCount++

          if (callCount === 1) {
            // First call fails
            throw new Error('fetch failed: ECONNRESET')
          }

          // Second call succeeds
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'text-start', id: 'tx1' })
                controller.enqueue({
                  type: 'text-delta',
                  id: 'tx1',
                  delta: 'Recovered successfully!',
                })
                controller.enqueue({ type: 'text-end', id: 'tx1' })
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: {
                      total: 20,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 10, text: undefined, reasoning: undefined },
                  },
                })
                controller.close()
              },
            }),
            warnings: [],
          }
        },
      } as LanguageModel

      const { events, handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Hello')

      expect(result.text).toBe('Recovered successfully!')
      // First iteration fails, second succeeds
      expect(result.iterations).toBe(2)
      expect(result.maxIterationsReached).toBe(false)

      // Should have emitted a recoverable error event
      const errorEvents = events.filter((e) => e.type === 'error' && e.recoverable)
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    })

    test('agent handles mid-stream errors and recovers', async () => {
      let callCount = 0
      const model = {
        specificationVersion: 'v3',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},

        doGenerate: async () => {
          throw new Error('Not used')
        },

        doStream: async () => {
          callCount++

          if (callCount === 1) {
            // First call: stream starts but then errors
            return {
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(controller) {
                  controller.enqueue({ type: 'text-start', id: 'tx1' })
                  controller.enqueue({ type: 'text-delta', id: 'tx1', delta: 'Partial...' })
                  controller.error(new Error('Connection reset'))
                },
              }),
              warnings: [],
            }
          }

          // Second call succeeds
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: 'text-start', id: 'tx2' })
                controller.enqueue({
                  type: 'text-delta',
                  id: 'tx2',
                  delta: 'Full response after recovery.',
                })
                controller.enqueue({ type: 'text-end', id: 'tx2' })
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: {
                      total: 20,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 15, text: undefined, reasoning: undefined },
                  },
                })
                controller.close()
              },
            }),
            warnings: [],
          }
        },
      } as LanguageModel

      const { handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Hello')

      expect(result.text).toBe('Full response after recovery.')
      expect(result.maxIterationsReached).toBe(false)
    })
  })

  // -------------------------------------------------------------------
  // Additional tests
  // -------------------------------------------------------------------

  describe('conversation management', () => {
    test('clearHistory() resets conversation state', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'First response' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const agent = new Agent(makeAgentOptions(model, registry))
      await agent.run('Hello')

      expect(agent.getConversationHistory()).toHaveLength(2) // user + assistant

      agent.clearHistory()
      expect(agent.getConversationHistory()).toHaveLength(0)
    })

    test('getConversationHistory() returns a copy', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'Response' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const agent = new Agent(makeAgentOptions(model, registry))
      await agent.run('Hello')

      const history1 = agent.getConversationHistory()
      const history2 = agent.getConversationHistory()

      // Should be equal but not the same reference
      expect(history1).toEqual(history2)
      expect(history1).not.toBe(history2)
    })
  })

  describe('tool error handling', () => {
    test('tool execution errors are reported as tool results, not crashes', async () => {
      registry.register({
        name: 'failing-tool',
        description: 'A tool that always fails',
        schema: z.object({ input: z.string().optional() }),
        execute: async () => {
          throw new Error('Tool crashed!')
        },
      })

      const model = createMockModel([
        // Turn 1: LLM calls the failing tool
        [
          { type: 'tool-input-start', id: 'call_fail', toolName: 'failing-tool' },
          { type: 'tool-input-end', id: 'call_fail' },
          {
            type: 'tool-call',
            toolCallId: 'call_fail',
            toolName: 'failing-tool',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        // Turn 2: LLM acknowledges the error
        [
          { type: 'text-start', id: 'tx2' },
          { type: 'text-delta', id: 'tx2', delta: 'The tool failed, let me try another approach.' },
          { type: 'text-end', id: 'tx2' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 30,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 15, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const { events, handler } = collectEvents()
      const agent = new Agent(makeAgentOptions(model, registry, { onEvent: handler }))

      const result = await agent.run('Use the failing tool')

      // Agent should not crash — it should get a response
      expect(result.text).toBe('The tool failed, let me try another approach.')

      // The tool-call-end event should indicate an error
      const toolEnd = events.find((e) => e.type === 'tool-call-end')
      expect(toolEnd).toBeDefined()
      if (toolEnd?.type === 'tool-call-end') {
        expect(toolEnd.isError).toBe(true)
        expect(toolEnd.result).toContain('Tool crashed!')
      }
    })
  })

  describe('emitEvent resilience', () => {
    test('agent completes normally even when onEvent handler throws', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'Hello!' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 2, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const agent = new Agent(
        makeAgentOptions(model, registry, {
          onEvent: () => {
            throw new Error('Rendering exploded!')
          },
        }),
      )

      // Agent should not throw even though every event handler call throws
      const result = await agent.run('Test')

      expect(result.text).toBe('Hello!')
      expect(result.iterations).toBe(1)
      expect(result.maxIterationsReached).toBe(false)
    })
  })

  describe('system prompt building', () => {
    test('system prompt builder is called with tools, skills, memory, and AGENTS.md instructions', async () => {
      registry.register(makeTool('test-tool'))

      const tempDir = join(
        tmpdir(),
        `ouroboros-agent-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      mkdirSync(tempDir, { recursive: true })
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Root instructions\n\nFollow repo rules.')
      process.chdir(tempDir)

      let capturedOptions: unknown = null
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'Ok' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      try {
        const agent = new Agent(
          makeAgentOptions(model, registry, {
            systemPromptBuilder: (opts) => {
              capturedOptions = opts
              return 'Test system prompt'
            },
            memoryProvider: () => 'Test memory content',
            skillCatalogProvider: () => [
              { name: 'test-skill', description: 'A test skill', status: 'core' as const },
            ],
          }),
        )

        await agent.run('Test')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }

      expect(capturedOptions).toBeDefined()
      const opts = capturedOptions as {
        tools: unknown[]
        skills: unknown[]
        memory: string
        agentsInstructions: string
      }
      expect(opts.tools).toHaveLength(1)
      expect(opts.skills).toHaveLength(1)
      expect(opts.memory).toBe('Test memory content')
      expect(opts.agentsInstructions).toContain('Follow repo rules.')
    })
  })

  // -------------------------------------------------------------------
  // Boundary tests: step-limit edge cases
  // -------------------------------------------------------------------
  describe('step-limit boundaries', () => {
    /** A single turn that emits a tool call with no matching text. */
    function oneToolCallTurn(): LanguageModelV3StreamPart[] {
      return [
        { type: 'tool-input-start', id: 'tc1', toolName: 'test_tool' },
        { type: 'tool-input-delta', id: 'tc1', delta: '{"input":"x"}' },
        { type: 'tool-input-end', id: 'tc1' },
        {
          type: 'tool-call',
          toolCallId: 'tc1',
          toolName: 'test_tool',
          input: '{"input":"x"}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: {
              total: 5,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        },
      ]
    }

    /** A turn that just says "done" and finishes. */
    function simpleTextTurn(text: string): LanguageModelV3StreamPart[] {
      return [
        { type: 'text-start', id: `t-${text}` },
        { type: 'text-delta', id: `t-${text}`, delta: text },
        { type: 'text-end', id: `t-${text}` },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 5,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 2, text: undefined, reasoning: undefined },
          },
        },
      ]
    }

    test('maxSteps=1 with a tool-calling model hits the step limit after one iteration', async () => {
      registry.register(makeTool('test_tool'))
      // Model wants to call a tool every turn — so it would loop forever if
      // not for the step limit.
      const model = createMockModel([oneToolCallTurn(), oneToolCallTurn(), oneToolCallTurn()])
      const agent = new Agent(makeAgentOptions(model, registry))

      const result = await agent.run('Do the thing', { maxSteps: 1 })

      expect(result.iterations).toBe(1)
      expect(result.stopReason).toBe('max_steps')
      expect(result.maxIterationsReached).toBe(true)
    })

    test('maxSteps=0 is clamped to minimum of 1 (does not hang or zero out)', async () => {
      registry.register(makeTool('test_tool'))
      const model = createMockModel([oneToolCallTurn(), oneToolCallTurn()])
      const agent = new Agent(makeAgentOptions(model, registry))

      const result = await agent.run('Do the thing', { maxSteps: 0 })

      // Clamped to 1 by resolveMaxSteps — behaves identically to maxSteps: 1.
      expect(result.iterations).toBe(1)
      expect(result.stopReason).toBe('max_steps')
    })

    test('maxSteps higher than needed stops at completion, not the ceiling', async () => {
      const model = createMockModel([simpleTextTurn('done')])
      const agent = new Agent(makeAgentOptions(model, registry))

      const result = await agent.run('Say done', { maxSteps: 50 })

      expect(result.iterations).toBe(1)
      expect(result.stopReason).toBe('completed')
      expect(result.maxIterationsReached).toBe(false)
    })

    test('two sequential runs on the same agent each track their own iteration count', async () => {
      registry.register(makeTool('test_tool'))
      const model = createMockModel([simpleTextTurn('first'), simpleTextTurn('second')])
      const agent = new Agent(makeAgentOptions(model, registry))

      const first = await agent.run('Hi', { maxSteps: 10 })
      const second = await agent.run('Again', { maxSteps: 10 })

      // Each run starts iteration count at 0 — not a cumulative counter.
      expect(first.iterations).toBe(1)
      expect(second.iterations).toBe(1)
    })
  })
})
