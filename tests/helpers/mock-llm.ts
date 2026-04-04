/**
 * Mock LLM Provider for Integration Tests
 *
 * Returns scripted LanguageModelV1StreamPart sequences for each turn.
 * Supports multi-turn conversations, tool calls, and error simulation.
 * Reusable across all integration test files.
 */
import type { LanguageModelV1, LanguageModelV1StreamPart } from 'ai'

/**
 * Create a mock LanguageModelV1 that yields predetermined stream parts
 * across multiple turns. Each call to doStream() consumes the next entry
 * from the `turns` array.
 *
 * If all turns are consumed, additional calls return an empty stream
 * with a stop finish.
 */
export function createMockModel(turns: LanguageModelV1StreamPart[][]): LanguageModelV1 {
  let turnIndex = 0

  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-model',
    defaultObjectGenerationMode: undefined,

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent -- use doStream')
    },

    doStream: async () => {
      const parts = turns[turnIndex] ?? [
        {
          type: 'text-delta' as const,
          textDelta: '[No more scripted turns]'
        },
        {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { promptTokens: 0, completionTokens: 0 }
        }
      ]
      turnIndex++

      return {
        stream: new ReadableStream<LanguageModelV1StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
        warnings: []
      }
    }
  }
}

/**
 * Create a mock model that inspects the prompt on each call.
 * The `handler` receives the prompt and returns the stream parts for that turn.
 * Useful for tests that need to verify prompt contents.
 */
export function createInspectingMockModel(
  handler: (prompt: unknown, callIndex: number) => LanguageModelV1StreamPart[]
): LanguageModelV1 {
  let callIndex = 0

  return {
    specificationVersion: 'v1',
    provider: 'mock',
    modelId: 'mock-inspecting-model',
    defaultObjectGenerationMode: undefined,

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent -- use doStream')
    },

    doStream: async ({ prompt }) => {
      const parts = handler(prompt, callIndex)
      callIndex++

      return {
        stream: new ReadableStream<LanguageModelV1StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          }
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
        rawResponse: { headers: {} },
        warnings: []
      }
    }
  }
}

// ── Stream part helpers ─────────────────────────────────────────────

/** Create a text-delta stream part. */
export function textDelta(text: string): LanguageModelV1StreamPart {
  return { type: 'text-delta', textDelta: text }
}

/** Create a tool-call stream part. */
export function toolCall(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>
): LanguageModelV1StreamPart {
  return {
    type: 'tool-call',
    toolCallType: 'function',
    toolCallId,
    toolName,
    args: JSON.stringify(args)
  }
}

/** Create a finish stream part with stop reason. */
export function finishStop(promptTokens = 10, completionTokens = 5): LanguageModelV1StreamPart {
  return {
    type: 'finish',
    finishReason: 'stop',
    usage: { promptTokens, completionTokens }
  }
}

/** Create a finish stream part with tool-calls reason. */
export function finishToolCalls(promptTokens = 10, completionTokens = 5): LanguageModelV1StreamPart {
  return {
    type: 'finish',
    finishReason: 'tool-calls',
    usage: { promptTokens, completionTokens }
  }
}
