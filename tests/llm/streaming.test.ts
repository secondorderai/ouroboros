import { describe, test, expect } from 'bun:test'
import { streamResponse, generateResponse } from '@src/llm/streaming'
import type { LLMMessage, StreamChunk, LLMCallOptions } from '@src/llm/types'
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

/**
 * Create a mock LanguageModelV2 that returns predetermined responses.
 * This avoids making real API calls in tests.
 */
function createMockModel(options: {
  streamParts?: LanguageModelV2StreamPart[]
  generateText?: string
  generateToolCalls?: Array<{ toolCallId: string; toolName: string; input: string }>
  error?: Error
}): LanguageModel {
  return {
    specificationVersion: 'v2',
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
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
        warnings: [],
      }
    },

    doStream: async () => {
      if (options.error) throw options.error

      const parts = options.streamParts ?? []

      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
        warnings: [],
      }
    },
  } as LanguageModel
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
        { type: 'text-delta', id: 'td1', delta: 'Hello' },
        { type: 'text-delta', id: 'td2', delta: ' world' },
        { type: 'text-delta', id: 'td3', delta: '!' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        },
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
        {
          type: 'tool-call',
          toolCallId: 'call_123',
          toolName: 'read_file',
          input: '{"path":"/tmp/test.txt"}',
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        },
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

  test('yields finish event with usage information', async () => {
    const model = createMockModel({
      streamParts: [
        { type: 'text-delta', id: 'td4', delta: 'Done' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
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

  test('resolves text promise with full accumulated text', async () => {
    const model = createMockModel({
      streamParts: [
        { type: 'text-delta', id: 'td5', delta: 'Hello' },
        { type: 'text-delta', id: 'td6', delta: ' world' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
      ],
    })

    const result = streamResponse(model, testMessages)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Must consume the stream for promises to resolve
    for await (const _chunk of result.value.stream) {
      // consume
    }

    const text = await result.value.text
    expect(text).toBe('Hello world')
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

  test('handles mid-stream errors as error chunks', async () => {
    // When the underlying ReadableStream errors, the AI SDK throws during iteration.
    // Our createChunkStream catches these and yields error chunks.
    const failingModel = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},

      doGenerate: async () => {
        throw new Error('Not implemented')
      },

      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'td7', delta: 'Partial' })
            controller.error(new Error('fetch failed: ECONNRESET'))
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
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
})
