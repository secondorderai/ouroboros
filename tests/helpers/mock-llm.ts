/**
 * Mock LLM Provider for Integration Tests
 *
 * Returns scripted LanguageModelV2StreamPart sequences for each turn.
 * Supports multi-turn conversations, tool calls, and error simulation.
 * Reusable across all integration test files.
 */
import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

/**
 * Create a mock LanguageModelV2 that yields predetermined stream parts
 * across multiple turns. Each call to doStream() consumes the next entry
 * from the `turns` array.
 *
 * If all turns are consumed, additional calls return an empty stream
 * with a stop finish.
 */
export function createMockModel(turns: LanguageModelV2StreamPart[][]): LanguageModel {
  let turnIndex = 0

  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent -- use doStream')
    },

    doStream: async () => {
      const parts = turns[turnIndex] ?? [
        {
          type: 'text-delta' as const,
          id: 'fallback',
          delta: '[No more scripted turns]',
        },
        {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]
      turnIndex++

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
  }

  return model as LanguageModel
}

/**
 * Create a mock model that inspects the prompt on each call.
 * The `handler` receives the prompt and returns the stream parts for that turn.
 * Useful for tests that need to verify prompt contents.
 */
export function createInspectingMockModel(
  handler: (prompt: unknown, callIndex: number) => LanguageModelV2StreamPart[],
): LanguageModel {
  let callIndex = 0

  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
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
  }

  return model as LanguageModel
}

// ── Stream part helpers ────────────────────────────────────���────────

let _partId = 0
function nextId(): string {
  return `part_${++_partId}`
}

/** Create a text-delta stream part. */
export function textDelta(text: string): LanguageModelV2StreamPart {
  return { type: 'text-delta', id: nextId(), delta: text }
}

/** Create a tool-call stream part. */
export function toolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): LanguageModelV2StreamPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    input: JSON.stringify(args),
  }
}

/** Create a finish stream part with stop reason. */
export function finishStop(inputTokens = 10, outputTokens = 5): LanguageModelV2StreamPart {
  return {
    type: 'finish',
    finishReason: 'stop',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  }
}

/** Create a finish stream part with tool-calls reason. */
export function finishToolCalls(inputTokens = 10, outputTokens = 5): LanguageModelV2StreamPart {
  return {
    type: 'finish',
    finishReason: 'tool-calls',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  }
}
