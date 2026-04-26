import { describe, test, expect } from 'bun:test'
import { streamResponse, generateResponse, toModelMsgs } from '@src/llm/streaming'
import { OPENAI_CHATGPT_PROVIDER } from '@src/auth/openai-chatgpt'
import type { LLMMessage, StreamChunk, LLMCallOptions } from '@src/llm/types'
import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

/**
 * V3 finish event helper — builds the nested usage/finishReason structure.
 */
function v3Finish(
  finishReason: LanguageModelV3FinishReason['unified'],
  inputTokens: number,
  outputTokens: number,
) {
  return {
    type: 'finish' as const,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: {
        total: inputTokens,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
    },
  }
}

/**
 * Create a mock LanguageModelV3 that returns predetermined responses.
 * This avoids making real API calls in tests.
 */
function createMockModel(options: {
  streamParts?: LanguageModelV3StreamPart[]
  generateText?: string
  generateToolCalls?: Array<{ toolCallId: string; toolName: string; input: string }>
  error?: Error
  onDoStream?: (options: unknown) => void
}): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      if (options.error) throw options.error

      const content: Array<
        | { type: 'text'; id: string; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = []
      if (options.generateText) {
        content.push({ type: 'text', id: 'gen', text: options.generateText })
      }
      if (options.generateToolCalls) {
        for (const tc of options.generateToolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          })
        }
      }

      return {
        content,
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }
    },

    doStream: async (doStreamOptions: unknown) => {
      if (options.error) throw options.error
      options.onDoStream?.(doStreamOptions)

      const parts = options.streamParts ?? []

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
  } as unknown as LanguageModel
}

const testMessages: LLMMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' },
]

/** Tool definitions needed when the mock includes tool calls */
const testToolOptions: LLMCallOptions = {
  tools: {
    read_file: {
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    search: {
      description: 'Search for something',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    get_weather: {
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
}

describe('streamResponse', () => {
  test('yields text chunks incrementally', async () => {
    const model = createMockModel({
      streamParts: [
        { type: 'text-start', id: 'tx1' },
        { type: 'text-delta', id: 'tx1', delta: 'Hello' },
        { type: 'text-delta', id: 'tx1', delta: ' world' },
        { type: 'text-delta', id: 'tx1', delta: '!' },
        { type: 'text-end', id: 'tx1' },
        v3Finish('stop', 5, 3),
      ],
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    // Should receive all 3 text deltas
    const textChunks = chunks.filter((c) => c.type === 'text-delta')
    expect(textChunks).toHaveLength(3)
    expect(textChunks[0]).toEqual({ type: 'text-delta', textDelta: 'Hello' })
    expect(textChunks[1]).toEqual({ type: 'text-delta', textDelta: ' world' })
    expect(textChunks[2]).toEqual({ type: 'text-delta', textDelta: '!' })
  })

  test('parses tool calls from stream', async () => {
    const model = createMockModel({
      streamParts: [
        { type: 'tool-input-start', id: 'call_123', toolName: 'read_file' },
        { type: 'tool-input-delta', id: 'call_123', delta: '{"path":"/tmp/test.txt"}' },
        { type: 'tool-input-end', id: 'call_123' },
        {
          type: 'tool-call',
          toolCallId: 'call_123',
          toolName: 'read_file',
          input: '{"path":"/tmp/test.txt"}',
        },
        v3Finish('tool-calls', 10, 15),
      ],
    })

    // Tool calls require tool definitions to be registered with the AI SDK
    const result = streamResponse(model, testMessages, testToolOptions)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const toolCallChunks = chunks.filter((c) => c.type === 'tool-call')
    expect(toolCallChunks).toHaveLength(1)

    const toolCall = toolCallChunks[0]
    expect(toolCall.type).toBe('tool-call')
    if (toolCall.type !== 'tool-call') return

    expect(toolCall.toolCallId).toBe('call_123')
    expect(toolCall.toolName).toBe('read_file')
    expect(toolCall.input).toEqual({ path: '/tmp/test.txt' })
  })

  test('passes native tool definitions with schemas to the model', async () => {
    let capturedOptions: unknown
    const model = createMockModel({
      streamParts: [v3Finish('stop', 10, 1)],
      onDoStream: (options) => {
        capturedOptions = options
      },
    })

    const result = streamResponse(model, testMessages, testToolOptions)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    for await (const chunk of result.value.stream) {
      expect(chunk).toBeDefined()
      // Drain stream so the mock model receives the AI SDK call.
    }

    const options = capturedOptions as {
      tools?: Array<{ name: string; description: string; inputSchema: unknown }>
    }
    const readFileTool = options.tools?.find((tool) => tool.name === 'read_file')
    const searchTool = options.tools?.find((tool) => tool.name === 'search')
    expect(readFileTool?.description).toBe('Read a file from disk')
    expect(readFileTool?.inputSchema).toBeDefined()
    expect(searchTool?.description).toBe('Search for something')
  })

  test('yields finish event with usage information', async () => {
    const model = createMockModel({
      streamParts: [
        { type: 'text-start', id: 'tx2' },
        { type: 'text-delta', id: 'tx2', delta: 'Done' },
        { type: 'text-end', id: 'tx2' },
        v3Finish('stop', 100, 50),
      ],
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const finishChunks = chunks.filter((c) => c.type === 'finish')
    expect(finishChunks).toHaveLength(1)

    const finish = finishChunks[0]
    if (finish.type !== 'finish') return

    expect(finish.finishReason).toBe('stop')
    expect(finish.usage.promptTokens).toBe(100)
    expect(finish.usage.completionTokens).toBe(50)
  })

  test('handles stream errors from doStream as error chunks', async () => {
    // When doStream throws, the AI SDK emits an 'error' event in fullStream
    const model = createMockModel({
      error: new Error('401 Unauthorized: Invalid API key'),
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error).toBeInstanceOf(Error)
    expect(errorChunk.error.message).toContain('Authentication failed')
  })

  test('classifies sign-in provider failures as authentication errors', async () => {
    const model = createMockModel({
      error: new Error('You need to sign in to use this model.'),
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error.message).toContain('Authentication failed')
  })

  test('handles mid-stream errors as error chunks', async () => {
    // When the underlying ReadableStream errors, the AI SDK throws during iteration.
    // Our createChunkStream catches these and yields error chunks.
    const failingModel = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},

      doGenerate: async () => {
        throw new Error('Not implemented')
      },

      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'tx4' })
            controller.enqueue({ type: 'text-delta', id: 'tx4', delta: 'Partial' })
            controller.error(new Error('fetch failed: ECONNRESET'))
          },
        }),
        warnings: [],
      }),
    } as LanguageModel

    const result = streamResponse(failingModel, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    // Should have at least an error chunk (the text delta may or may not appear
    // depending on AI SDK internal buffering, but the error must be captured)
    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error).toBeInstanceOf(Error)
  })

  test('auth error is classified with actionable message', async () => {
    const model = createMockModel({
      error: new Error('401 Unauthorized: Invalid API key'),
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error.message).toContain('Authentication failed')
    expect(errorChunk.error.message).toContain('API key')
  })

  test('rate limit error is classified with actionable message', async () => {
    const model = createMockModel({
      error: new Error('429 Too Many Requests: rate limit exceeded'),
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error.message).toContain('Rate limited')
  })

  test('object-shaped quota errors are classified with readable text', async () => {
    const model = createMockModel({
      error: {
        type: 'error',
        error: {
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota.',
        },
      } as unknown as Error,
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks: StreamChunk[] = []
    for await (const chunk of result.value.stream) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type !== 'error') return
    expect(errorChunk.error.message).toContain('Rate limited or quota exceeded')
    expect(errorChunk.error.message).toContain('You exceeded your current quota.')
    expect(errorChunk.error.message).not.toContain('[object Object]')
  })

  test('maps chatgpt system prompts to openai instructions', async () => {
    let capturedSystem: unknown
    let capturedProviderOptions: unknown

    const model = {
      specificationVersion: 'v3',
      provider: `${OPENAI_CHATGPT_PROVIDER}.responses`,
      modelId: 'gpt-5.4',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedSystem = options.prompt
        capturedProviderOptions = options.providerOptions

        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, testMessages, { system: 'Be precise.' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    for await (const _chunk of result.value.stream) {
      // Exhaust stream to force the provider call.
    }

    expect(capturedSystem).toBeDefined()
    expect(capturedProviderOptions).toEqual({
      openai: {
        store: false,
        instructions: 'Be precise.',
      },
    })
  })

  test('forces chatgpt responses store off even without system prompt', async () => {
    let capturedProviderOptions: unknown

    const model = {
      specificationVersion: 'v3',
      provider: `${OPENAI_CHATGPT_PROVIDER}.responses`,
      modelId: 'gpt-5.4',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedProviderOptions = options.providerOptions

        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, [{ role: 'user', content: 'Hello' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    for await (const _chunk of result.value.stream) {
      // Exhaust stream to force the provider call.
    }

    expect(capturedProviderOptions).toEqual({
      openai: {
        store: false,
      },
    })
  })

  test('passes anthropic thinking provider options and forces temperature=1', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const model = {
      specificationVersion: 'v3',
      provider: 'anthropic.messages',
      modelId: 'claude-opus-4-7',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedOptions = options
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, testMessages, {
      thinkingBudgetTokens: 8192,
      temperature: 0.2, // should be overridden to 1
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for await (const _ of result.value.stream) void _

    expect(capturedOptions?.providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } },
    })
    expect(capturedOptions?.temperature).toBe(1)
  })

  test('passes openai reasoning effort through providerOptions for o-series', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const model = {
      specificationVersion: 'v3',
      provider: 'openai.responses',
      modelId: 'o3',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedOptions = options
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, testMessages, {
      reasoningEffort: 'high',
      temperature: 0.4,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for await (const _ of result.value.stream) void _

    expect(capturedOptions?.providerOptions).toEqual({
      openai: { reasoningEffort: 'high' },
    })
    expect(capturedOptions?.temperature).toBe(0.4)
  })

  test('merges chatgpt openai options with reasoning effort', async () => {
    let capturedProviderOptions: unknown

    const model = {
      specificationVersion: 'v3',
      provider: `${OPENAI_CHATGPT_PROVIDER}.responses`,
      modelId: 'gpt-5.4-medium',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedProviderOptions = options.providerOptions
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, testMessages, {
      system: 'Be precise.',
      reasoningEffort: 'medium',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for await (const _ of result.value.stream) void _

    expect(capturedProviderOptions).toEqual({
      openai: {
        store: false,
        instructions: 'Be precise.',
        reasoningEffort: 'medium',
      },
    })
  })

  test('does not inject providerOptions for models without reasoning support', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const model = {
      specificationVersion: 'v3',
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('Not implemented')
      },
      doStream: async (options: Record<string, unknown>) => {
        capturedOptions = options
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue(v3Finish('stop', 1, 1))
              controller.close()
            },
          }),
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = streamResponse(model, testMessages, { reasoningEffort: 'high' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for await (const _ of result.value.stream) void _

    expect(capturedOptions?.providerOptions).toBeUndefined()
  })
})

describe('generateResponse', () => {
  test('returns complete text response', async () => {
    const model = createMockModel({
      generateText: 'Hello, I am a helpful assistant!',
    })

    const result = await generateResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.text).toBe('Hello, I am a helpful assistant!')
    expect(result.value.finishReason).toBe('stop')
    expect(result.value.usage.promptTokens).toBe(10)
    expect(result.value.usage.completionTokens).toBe(20)
    expect(result.value.usage.totalTokens).toBe(30)
  })

  test('returns tool calls from generate', async () => {
    const model = createMockModel({
      generateText: '',
      generateToolCalls: [
        {
          toolCallId: 'call_abc',
          toolName: 'get_weather',
          input: '{"city":"London"}',
        },
      ],
    })

    // Tool calls require tool definitions
    const result = await generateResponse(model, testMessages, testToolOptions)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.toolCalls).toHaveLength(1)
    expect(result.value.toolCalls[0].toolCallId).toBe('call_abc')
    expect(result.value.toolCalls[0].toolName).toBe('get_weather')
    expect(result.value.toolCalls[0].input).toEqual({ city: 'London' })
  })

  test('auth error returns Result error', async () => {
    const model = createMockModel({
      error: new Error('401 Unauthorized: Invalid API key provided'),
    })

    const result = await generateResponse(model, testMessages)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Authentication failed')
  })

  test('network error returns Result error', async () => {
    const model = createMockModel({
      error: new Error('fetch failed: ECONNREFUSED'),
    })

    const result = await generateResponse(model, testMessages)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Network error')
  })

  test('rate limit error returns Result error', async () => {
    const model = createMockModel({
      error: new Error('429 Too Many Requests'),
    })

    const result = await generateResponse(model, testMessages)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Rate limited')
  })

  test('object-shaped provider errors return readable Result errors', async () => {
    const model = createMockModel({
      error: {
        type: 'error',
        error: {
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota.',
        },
      } as unknown as Error,
    })

    const result = await generateResponse(model, testMessages)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('Rate limited or quota exceeded')
    expect(result.error.message).toContain('You exceeded your current quota.')
    expect(result.error.message).not.toContain('[object Object]')
  })

  test('maps chatgpt system prompts to openai instructions', async () => {
    let capturedSystem: unknown
    let capturedProviderOptions: unknown

    const model = {
      specificationVersion: 'v3',
      provider: `${OPENAI_CHATGPT_PROVIDER}.responses`,
      modelId: 'gpt-5.4',
      supportedUrls: {},
      doGenerate: async (options: Record<string, unknown>) => {
        capturedSystem = options.prompt
        capturedProviderOptions = options.providerOptions

        return {
          content: [{ type: 'text', id: 'gen', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }
      },
      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as LanguageModel

    const result = await generateResponse(model, testMessages, { system: 'Be precise.' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(capturedSystem).toBeDefined()
    expect(capturedProviderOptions).toEqual({
      openai: {
        store: false,
        instructions: 'Be precise.',
      },
    })
  })

  test('forces chatgpt responses store off even without system prompt', async () => {
    let capturedProviderOptions: unknown

    const model = {
      specificationVersion: 'v3',
      provider: `${OPENAI_CHATGPT_PROVIDER}.responses`,
      modelId: 'gpt-5.4',
      supportedUrls: {},
      doGenerate: async (options: Record<string, unknown>) => {
        capturedProviderOptions = options.providerOptions

        return {
          content: [{ type: 'text', id: 'gen', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }
      },
      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as LanguageModel

    const result = await generateResponse(model, [{ role: 'user', content: 'Hello' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(capturedProviderOptions).toEqual({
      openai: {
        store: false,
      },
    })
  })

  test('passes anthropic thinking and forces temperature=1 in non-streaming path', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const model = {
      specificationVersion: 'v3',
      provider: 'anthropic.messages',
      modelId: 'claude-opus-4-7',
      supportedUrls: {},
      doStream: async () => {
        throw new Error('Not implemented')
      },
      doGenerate: async (options: Record<string, unknown>) => {
        capturedOptions = options
        return {
          content: [{ type: 'text', id: 'gen', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = await generateResponse(model, [{ role: 'user', content: 'hello' }], {
      thinkingBudgetTokens: 4096,
      temperature: 0.5,
    })
    expect(result.ok).toBe(true)
    expect(capturedOptions?.providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    })
    expect(capturedOptions?.temperature).toBe(1)
  })

  test('passes openai reasoning effort in non-streaming path', async () => {
    let capturedOptions: Record<string, unknown> | undefined

    const model = {
      specificationVersion: 'v3',
      provider: 'openai.responses',
      modelId: 'o3',
      supportedUrls: {},
      doStream: async () => {
        throw new Error('Not implemented')
      },
      doGenerate: async (options: Record<string, unknown>) => {
        capturedOptions = options
        return {
          content: [{ type: 'text', id: 'gen', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 1,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }
      },
    } as unknown as LanguageModel

    const result = await generateResponse(model, [{ role: 'user', content: 'hello' }], {
      reasoningEffort: 'low',
    })
    expect(result.ok).toBe(true)
    expect(capturedOptions?.providerOptions).toEqual({
      openai: { reasoningEffort: 'low' },
    })
  })
})

describe('toModelMsgs', () => {
  test('converts system message', () => {
    const msgs: LLMMessage[] = [{ role: 'system', content: 'Be helpful.' }]
    const result = toModelMsgs(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'system', content: 'Be helpful.' })
  })

  test('converts user message', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'Hello' }]
    const result = toModelMsgs(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' })
  })

  test('converts user message with multiple image file parts', () => {
    const firstImage = new Uint8Array([1, 2, 3])
    const secondImage = new Uint8Array([4, 5, 6])
    const msgs: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these screens' },
          { type: 'file', data: firstImage, mediaType: 'image/png', filename: 'a.png' },
          { type: 'file', data: secondImage, mediaType: 'image/webp', filename: 'b.webp' },
        ],
      },
    ]

    const result = toModelMsgs(msgs)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Compare these screens' },
        { type: 'file', data: firstImage, mediaType: 'image/png', filename: 'a.png' },
        { type: 'file', data: secondImage, mediaType: 'image/webp', filename: 'b.webp' },
      ],
    })
  })

  test('converts assistant message without toolCalls', () => {
    const msgs: LLMMessage[] = [{ role: 'assistant', content: 'Hi there' }]
    const result = toModelMsgs(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'assistant', content: 'Hi there' })
  })

  test('converts assistant message with toolCalls', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'read_file', input: { path: '/tmp/x' } }],
      },
    ]
    const result = toModelMsgs(msgs)
    expect(result).toHaveLength(1)
    const msg = result[0] as { role: 'assistant'; content: unknown[] }
    expect(msg.role).toBe('assistant')
    expect(Array.isArray(msg.content)).toBe(true)
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Let me check.' })
    expect(msg.content[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'read_file',
      input: { path: '/tmp/x' },
    })
  })

  test('converts tool message', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'tool',
        content: [{ toolCallId: 'tc1', toolName: 'read_file', result: 'file contents' }],
      },
    ]
    const result = toModelMsgs(msgs)
    expect(result).toHaveLength(1)
    const msg = result[0] as { role: 'tool'; content: unknown[] }
    expect(msg.role).toBe('tool')
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc1',
      toolName: 'read_file',
    })
  })
})
