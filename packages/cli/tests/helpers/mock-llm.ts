/**
 * Mock LLM Provider for Integration Tests
 *
 * Returns scripted LanguageModelV3StreamPart sequences for each turn.
 * Supports multi-turn conversations, tool calls, and error simulation.
 * Reusable across all integration test files.
 */
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

/**
 * Create a mock LanguageModelV3 that yields predetermined stream parts
 * across multiple turns. Each call to doStream() consumes the next entry
 * from the `turns` array.
 *
 * If all turns are consumed, additional calls return an empty stream
 * with a stop finish.
 */
export function createMockModel(turns: LanguageModelV3StreamPart[][]): LanguageModel {
  let turnIndex = 0

  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent -- use doStream')
    },

    doStream: async () => {
      const parts = turns[turnIndex] ?? [
        { type: 'text-start' as const, id: 'fallback' },
        {
          type: 'text-delta' as const,
          id: 'fallback',
          delta: '[No more scripted turns]',
        },
        { type: 'text-end' as const, id: 'fallback' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: {
              total: 0,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 0, text: undefined, reasoning: undefined },
          },
        },
      ]
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
  }

  return model as LanguageModel
}

/**
 * Create a mock model that inspects the prompt on each call.
 * The `handler` receives the prompt and returns the stream parts for that turn.
 * Useful for tests that need to verify prompt contents.
 */
export function createInspectingMockModel(
  handler: (prompt: unknown, callIndex: number) => LanguageModelV3StreamPart[],
): LanguageModel {
  let callIndex = 0

  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-inspecting-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent -- use doStream')
    },

    doStream: async ({ prompt }: { prompt: unknown }) => {
      const parts = handler(prompt, callIndex)
      callIndex++

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
  }

  return model as LanguageModel
}

// ── V3 usage & finish helpers ──────────────────────────────────────

function v3Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  }
}

// ── Stream part helpers ────────────────────────────────────────────

let _partId = 0
function nextId(): string {
  return `part_${++_partId}`
}

/** Create a text-start stream part. Must precede text-delta events. */
export function textStart(id?: string): LanguageModelV3StreamPart {
  return { type: 'text-start', id: id ?? nextId() }
}

/** Create a text-delta stream part. Must share the same id as its text-start. */
export function textDelta(text: string, id?: string): LanguageModelV3StreamPart {
  return { type: 'text-delta', id: id ?? nextId(), delta: text }
}

/** Create a text-end stream part. Must share the same id as its text-start. */
export function textEnd(id?: string): LanguageModelV3StreamPart {
  return { type: 'text-end', id: id ?? nextId() }
}

/**
 * Create a complete text block: text-start, text-deltas, text-end.
 * All parts share the same id.
 */
export function textBlock(...texts: string[]): LanguageModelV3StreamPart[] {
  const id = nextId()
  return [
    { type: 'text-start', id },
    ...texts.map((t) => ({ type: 'text-delta' as const, id, delta: t })),
    { type: 'text-end', id },
  ]
}

/** Create a tool-call stream part. */
export function toolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): LanguageModelV3StreamPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    input: JSON.stringify(args),
  }
}

/** Create tool-input-start + tool-call stream parts for a complete tool call. */
export function toolCallBlock(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-end', id: toolCallId },
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(args),
    },
  ]
}

/** Create a finish stream part with stop reason. */
export function finishStop(inputTokens = 10, outputTokens = 5): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: v3Usage(inputTokens, outputTokens),
  }
}

/** Create a finish stream part with tool-calls reason. */
export function finishToolCalls(inputTokens = 10, outputTokens = 5): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: v3Usage(inputTokens, outputTokens),
  }
}
