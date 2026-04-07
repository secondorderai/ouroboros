import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok } from '@src/types'
import type { ToolDefinition } from '@src/tools/types'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { TranscriptStore } from '@src/memory/transcripts'
import { configSchema, type OuroborosConfig } from '@src/config'
import {
  isJsonRpcRequest,
  makeResponse,
  makeErrorResponse,
  makeNotification,
  JSON_RPC_ERRORS,
} from '@src/json-rpc/types'
import { createHandlers, bridgeAgentEvent, type HandlerContext } from '@src/json-rpc/handlers'
import { writeMessage } from '@src/json-rpc/transport'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── Test Helpers ────────────────────────────────────────────────────

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

/** Create a minimal mock config. */
function makeTestConfig(): OuroborosConfig {
  return configSchema.parse({})
}

/** Create a handler context for testing with a mock agent. */
function createTestContext(overrides?: {
  model?: LanguageModel
  registry?: ToolRegistry
  config?: OuroborosConfig
  configDir?: string
  transcriptStore?: TranscriptStore
}): HandlerContext {
  const registry = overrides?.registry ?? new ToolRegistry()
  const model =
    overrides?.model ??
    createMockModel([
      [
        { type: 'text-start', id: 'tx1' },
        { type: 'text-delta', id: 'tx1', delta: 'Hello from agent' },
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

  const config = overrides?.config ?? makeTestConfig()
  const configDir = overrides?.configDir ?? tmpdir()

  // Create a real TranscriptStore in a temp location
  const dbPath = join(configDir, `.ouroboros-test-${crypto.randomUUID()}.db`)
  const transcriptStore = overrides?.transcriptStore ?? new TranscriptStore(dbPath)

  let currentRunAbort: AbortController | null = null

  const agent = new Agent(
    makeAgentOptions(model, registry, {
      onEvent: bridgeAgentEvent,
    }),
  )

  const ctx: HandlerContext = {
    getAgent: () => agent,
    config,
    configDir,
    transcriptStore,
    currentRunAbort,
    setCurrentRunAbort: (abort) => {
      currentRunAbort = abort
      ctx.currentRunAbort = abort
    },
    setConfig: (newConfig) => {
      ctx.config = newConfig
    },
  }

  return ctx
}

/** Capture stdout writes during a function's execution. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') {
      captured += chunk
    } else {
      captured += Buffer.from(chunk).toString('utf-8')
    }
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}

/** Parse NDJSON output lines into an array of objects. */
function parseNdjson(output: string): unknown[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

// ── Feature Tests ───────────────────────────────────────────────────

describe('JSON-RPC', () => {
  // -------------------------------------------------------------------
  // Test: Type helpers
  // -------------------------------------------------------------------
  describe('type helpers', () => {
    test('isJsonRpcRequest validates correctly', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'test', params: {} })).toBe(true)
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'test' })).toBe(true)
      expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'test' })).toBe(false)
      expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false) // missing id
      expect(isJsonRpcRequest(null)).toBe(false)
      expect(isJsonRpcRequest('string')).toBe(false)
    })

    test('makeResponse creates correct response', () => {
      const resp = makeResponse(1, { data: 'test' })
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBe(1)
      expect(resp.result).toEqual({ data: 'test' })
      expect(resp.error).toBeUndefined()
    })

    test('makeErrorResponse creates correct error response', () => {
      const resp = makeErrorResponse(1, -32601, 'Method not found')
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBe(1)
      expect(resp.error).toEqual({ code: -32601, message: 'Method not found' })
      expect(resp.result).toBeUndefined()
    })

    test('makeNotification creates correct notification', () => {
      const notif = makeNotification('agent/text', { text: 'hello' })
      expect(notif.jsonrpc).toBe('2.0')
      expect(notif.method).toBe('agent/text')
      expect(notif.params).toEqual({ text: 'hello' })
      expect((notif as unknown as Record<string, unknown>).id).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------
  // Test: Basic request/response round-trip
  // -------------------------------------------------------------------
  describe('basic request/response round-trip', () => {
    test('session/new returns a session ID', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('session/new')!
      expect(handler).toBeDefined()

      const result = (await handler({})) as { sessionId: string }
      expect(result.sessionId).toBeDefined()
      expect(typeof result.sessionId).toBe('string')
      expect(result.sessionId.length).toBeGreaterThan(0)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Agent run streams notifications
  // -------------------------------------------------------------------
  describe('agent run streams notifications', () => {
    test('agent/run emits text and turnComplete notifications', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('agent/run')!
      expect(handler).toBeDefined()

      const output = await captureStdout(async () => {
        await handler({ message: 'Say hello' })
      })

      const messages = parseNdjson(output)

      // Should have at least one agent/text notification
      const textNotifs = messages.filter(
        (m) => (m as Record<string, unknown>).method === 'agent/text',
      )
      expect(textNotifs.length).toBeGreaterThanOrEqual(1)

      // Should have an agent/turnComplete notification
      const turnComplete = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/turnComplete',
      )
      expect(turnComplete).toBeDefined()

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Tool call events are bridged
  // -------------------------------------------------------------------
  describe('tool call events are bridged', () => {
    test('tool call start and end are emitted as notifications', async () => {
      const registry = new ToolRegistry()
      registry.register(
        makeTool('bash', () => ({
          output: 'hello\n',
          exitCode: 0,
        })),
      )

      const model = createMockModel([
        // Turn 1: LLM calls bash tool
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"echo hello"}',
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
        // Turn 2: LLM produces final text
        [
          { type: 'text-start', id: 'tx3' },
          { type: 'text-delta', id: 'tx3', delta: 'The output is hello' },
          { type: 'text-end', id: 'tx3' },
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

      const ctx = createTestContext({ model, registry })
      const handlers = createHandlers(ctx)
      const handler = handlers.get('agent/run')!

      const output = await captureStdout(async () => {
        await handler({ message: 'Run echo hello' })
      })

      const messages = parseNdjson(output)

      // Should have agent/toolCallStart
      const toolStart = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/toolCallStart',
      ) as { params: { toolCallId: string; toolName: string } } | undefined
      expect(toolStart).toBeDefined()
      expect(toolStart!.params.toolCallId).toBe('call_1')
      expect(toolStart!.params.toolName).toBe('bash')

      // Should have agent/toolCallEnd
      const toolEnd = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/toolCallEnd',
      ) as { params: { toolCallId: string; toolName: string } } | undefined
      expect(toolEnd).toBeDefined()
      expect(toolEnd!.params.toolCallId).toBe('call_1')
      expect(toolEnd!.params.toolName).toBe('bash')

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Unknown method returns error
  // -------------------------------------------------------------------
  describe('unknown method returns error', () => {
    test('unregistered method returns -32601', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('nonexistent/method')
      expect(handler).toBeUndefined()

      // The server would produce a METHOD_NOT_FOUND error for this case.
      // We verify the error code constant is correct.
      expect(JSON_RPC_ERRORS.METHOD_NOT_FOUND.code).toBe(-32601)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Invalid JSON returns parse error
  // -------------------------------------------------------------------
  describe('invalid JSON handling', () => {
    test('parse error code is -32700', () => {
      expect(JSON_RPC_ERRORS.PARSE_ERROR.code).toBe(-32700)
    })

    test('makeErrorResponse with parse error produces correct shape', () => {
      const resp = makeErrorResponse(
        null,
        JSON_RPC_ERRORS.PARSE_ERROR.code,
        JSON_RPC_ERRORS.PARSE_ERROR.message,
      )
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBeNull()
      expect(resp.error!.code).toBe(-32700)
      expect(resp.error!.message).toBe('Parse error')
    })
  })

  // -------------------------------------------------------------------
  // Test: Config get/set round-trip
  // -------------------------------------------------------------------
  describe('config get/set round-trip', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = join(tmpdir(), `ouroboros-test-${crypto.randomUUID()}`)
      mkdirSync(tempDir, { recursive: true })
    })

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    })

    test('config/get returns current config', async () => {
      const config = makeTestConfig()
      const ctx = createTestContext({ config, configDir: tempDir })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('config/get')!({})) as OuroborosConfig
      expect(result.model.provider).toBe('anthropic')
      expect(result.model.name).toBe('claude-sonnet-4-20250514')

      ctx.transcriptStore.close()
    })

    test('config/set updates and persists config', async () => {
      // Write an initial config file
      const config = makeTestConfig()
      writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(config, null, 2), 'utf-8')

      const ctx = createTestContext({ config, configDir: tempDir })
      const handlers = createHandlers(ctx)

      // Set a new model name
      const setResult = (await handlers.get('config/set')!({
        path: 'model.name',
        value: 'test-model',
      })) as OuroborosConfig
      expect(setResult.model.name).toBe('test-model')

      // Get should reflect the change
      const getResult = (await handlers.get('config/get')!({})) as OuroborosConfig
      expect(getResult.model.name).toBe('test-model')

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Session CRUD operations
  // -------------------------------------------------------------------
  describe('session operations', () => {
    test('session/list returns sessions', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session first
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      expect(newResult.sessionId).toBeDefined()

      // List should include it
      const listResult = (await handlers.get('session/list')!({})) as {
        sessions: Array<{ id: string }>
      }
      expect(listResult.sessions.length).toBeGreaterThanOrEqual(1)
      expect(listResult.sessions.some((s) => s.id === newResult.sessionId)).toBe(true)

      ctx.transcriptStore.close()
    })

    test('session/load returns a session by ID', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }

      // Load it
      const loadResult = (await handlers.get('session/load')!({
        id: newResult.sessionId,
      })) as { id: string; messages: unknown[] }
      expect(loadResult.id).toBe(newResult.sessionId)
      expect(loadResult.messages).toBeInstanceOf(Array)

      ctx.transcriptStore.close()
    })

    test('session/delete removes a session', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }

      // Delete it
      const deleteResult = (await handlers.get('session/delete')!({
        id: newResult.sessionId,
      })) as { deleted: boolean }
      expect(deleteResult.deleted).toBe(true)

      // Load should fail
      try {
        await handlers.get('session/load')!({ id: newResult.sessionId })
        expect(true).toBe(false) // Should not reach here
      } catch (e) {
        expect((e as Error).message).toContain('not found')
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Skills operations
  // -------------------------------------------------------------------
  describe('skills operations', () => {
    test('skills/list returns skill array', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('skills/list')!({})) as {
        skills: unknown[]
      }
      expect(result.skills).toBeInstanceOf(Array)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Evolution operations (stubs)
  // -------------------------------------------------------------------
  describe('evolution operations', () => {
    test('evolution/list returns empty entries', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('evolution/list')!({})) as {
        entries: unknown[]
      }
      expect(result.entries).toEqual([])

      ctx.transcriptStore.close()
    })

    test('evolution/stats returns empty stats', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('evolution/stats')!({})) as {
        stats: Record<string, unknown>
      }
      expect(result.stats).toEqual({})

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Approval operations (stubs)
  // -------------------------------------------------------------------
  describe('approval operations', () => {
    test('approval/list returns empty array', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('approval/list')!({})) as {
        approvals: unknown[]
      }
      expect(result.approvals).toEqual([])

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Event bridge
  // -------------------------------------------------------------------
  describe('event-to-notification bridge', () => {
    test('text event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({ type: 'text', text: 'Hello world' })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as { method: string; params: { text: string } }
      expect(notif.method).toBe('agent/text')
      expect(notif.params.text).toBe('Hello world')
    })

    test('tool-call-start event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'tool-call-start',
          toolCallId: 'tc1',
          toolName: 'bash',
          input: { command: 'ls' },
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { toolCallId: string; toolName: string; input: unknown }
      }
      expect(notif.method).toBe('agent/toolCallStart')
      expect(notif.params.toolCallId).toBe('tc1')
      expect(notif.params.toolName).toBe('bash')
    })

    test('tool-call-end event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'tool-call-end',
          toolCallId: 'tc1',
          toolName: 'bash',
          result: 'success',
          isError: false,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { toolCallId: string; isError: boolean }
      }
      expect(notif.method).toBe('agent/toolCallEnd')
      expect(notif.params.toolCallId).toBe('tc1')
      expect(notif.params.isError).toBe(false)
    })

    test('turn-complete event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'turn-complete',
          text: 'Done!',
          iterations: 2,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { text: string; iterations: number }
      }
      expect(notif.method).toBe('agent/turnComplete')
      expect(notif.params.text).toBe('Done!')
      expect(notif.params.iterations).toBe(2)
    })

    test('error event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'error',
          error: new Error('Something broke'),
          recoverable: true,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { message: string; recoverable: boolean }
      }
      expect(notif.method).toBe('agent/error')
      expect(notif.params.message).toBe('Something broke')
      expect(notif.params.recoverable).toBe(true)
    })
  })

  // -------------------------------------------------------------------
  // Test: Transport writeMessage
  // -------------------------------------------------------------------
  describe('transport', () => {
    test('writeMessage writes NDJSON to stdout', async () => {
      const output = await captureStdout(async () => {
        writeMessage(makeResponse(42, { result: 'ok' }))
      })

      expect(output.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(output.trim())
      expect(parsed.jsonrpc).toBe('2.0')
      expect(parsed.id).toBe(42)
      expect(parsed.result).toEqual({ result: 'ok' })
    })
  })

  // -------------------------------------------------------------------
  // Test: Handler registration coverage
  // -------------------------------------------------------------------
  describe('handler registration', () => {
    test('all required methods are registered', () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const expectedMethods = [
        'agent/run',
        'agent/cancel',
        'session/list',
        'session/load',
        'session/new',
        'session/delete',
        'config/get',
        'config/set',
        'config/testConnection',
        'skills/list',
        'skills/get',
        'rsi/dream',
        'rsi/status',
        'evolution/list',
        'evolution/stats',
        'approval/list',
        'approval/respond',
        'workspace/set',
      ]

      for (const method of expectedMethods) {
        expect(handlers.has(method)).toBe(true)
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: agent/cancel with no active run
  // -------------------------------------------------------------------
  describe('agent/cancel', () => {
    test('returns not-in-progress when no run is active', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('agent/cancel')!({})) as {
        cancelled: boolean
        message?: string
      }
      expect(result.cancelled).toBe(false)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Invalid params handling
  // -------------------------------------------------------------------
  describe('invalid params handling', () => {
    test('agent/run rejects missing message', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('agent/run')!({})
        expect(true).toBe(false) // Should not reach here
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })

    test('session/load rejects missing id', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('session/load')!({})
        expect(true).toBe(false)
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })

    test('session/delete rejects missing id', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('session/delete')!({})
        expect(true).toBe(false)
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: writeMessage outputs valid NDJSON
  // -------------------------------------------------------------------
  describe('NDJSON output format', () => {
    test('multiple messages produce valid NDJSON', async () => {
      const output = await captureStdout(async () => {
        writeMessage(makeResponse(1, 'first'))
        writeMessage(makeNotification('agent/text', { text: 'delta' }))
        writeMessage(makeResponse(2, 'second'))
      })

      const lines = output.split('\n').filter((l) => l.length > 0)
      expect(lines).toHaveLength(3)

      // Each line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })
  })
})
