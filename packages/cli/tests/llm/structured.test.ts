/**
 * Tests for the shared non-streaming structured LLM call helper.
 *
 * Covers: JSON parsing (plain, fenced, garbage, schema-violating), the
 * retryable-400 fallback (sampling options dropped on retry), and the
 * reasoning-model temperature guard.
 */
import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { extractJsonText, generateStructured } from '@src/llm/structured'

const verdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  score: z.number(),
})

interface CapturedCall {
  temperature: number | undefined
}

/**
 * Create a mock LanguageModelV3 whose doGenerate returns the queued responses
 * in order. A response can be a string (returned as text) or an Error (thrown).
 * Captures the call options passed to doGenerate for assertion.
 */
function createMockModel(
  responses: Array<string | Error>,
  options: { modelId?: string; provider?: string } = {},
): { model: LanguageModel; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  let index = 0

  const model = {
    specificationVersion: 'v3',
    provider: options.provider ?? 'mock',
    modelId: options.modelId ?? 'mock-model',
    supportedUrls: {},

    doGenerate: async (callOptions: { temperature?: number }) => {
      calls.push({ temperature: callOptions.temperature })
      const response = responses[Math.min(index, responses.length - 1)]
      index++
      if (response instanceof Error) {
        throw response
      }
      return {
        content: [{ type: 'text' as const, text: response }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: { inputTokens: 10, outputTokens: 20 },
        warnings: [],
      }
    },

    doStream: async () => {
      throw new Error('Streaming not used by generateStructured')
    },
  } as unknown as LanguageModel

  return { model, calls }
}

describe('extractJsonText', () => {
  test('returns plain text unchanged (trimmed)', () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}')
  })

  test('strips a ```json fence', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('strips a bare ``` fence', () => {
    expect(extractJsonText('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
})

describe('generateStructured', () => {
  test('parses a valid JSON response against the schema', async () => {
    const { model } = createMockModel(['{"verdict":"pass","score":0.9}'])

    const result = await generateStructured(model, 'judge this', verdictSchema)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toBe('pass')
    expect(result.value.score).toBe(0.9)
  })

  test('parses a markdown-fenced JSON response', async () => {
    const { model } = createMockModel(['```json\n{"verdict":"fail","score":0.1}\n```'])

    const result = await generateStructured(model, 'judge this', verdictSchema)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toBe('fail')
  })

  test('returns err for garbage (non-JSON) output', async () => {
    const { model } = createMockModel(['I think the task is probably done, yes.'])

    const result = await generateStructured(model, 'judge this', verdictSchema)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Failed to parse structured response as JSON')
  })

  test('returns err for schema-violating JSON', async () => {
    const { model } = createMockModel(['{"verdict":"maybe","score":"high"}'])

    const result = await generateStructured(model, 'judge this', verdictSchema)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('schema validation')
  })

  test('returns err when the LLM call fails with a non-retryable error', async () => {
    const { model, calls } = createMockModel([new Error('connection reset by peer')])

    const result = await generateStructured(model, 'judge this', verdictSchema)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Structured LLM call failed')
    expect(calls).toHaveLength(1)
  })

  test('retries once without sampling options on a retryable 400', async () => {
    const { model, calls } = createMockModel([
      new Error('400 Bad Request: temperature is not supported'),
      '{"verdict":"pass","score":1}',
    ])

    const result = await generateStructured(model, 'judge this', verdictSchema, {
      temperature: 0.1,
      maxTokens: 256,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toBe('pass')
    expect(calls).toHaveLength(2)
    // First call carries the sampling temperature; the fallback drops it.
    expect(calls[0].temperature).toBe(0.1)
    expect(calls[1].temperature).toBeUndefined()
  })

  test('does not retry twice when the 400 persists', async () => {
    const { model, calls } = createMockModel([
      new Error('400 Bad Request'),
      new Error('400 Bad Request'),
      new Error('400 Bad Request'),
    ])

    const result = await generateStructured(model, 'judge this', verdictSchema, {
      temperature: 0.1,
    })

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test('passes temperature through for non-reasoning models', async () => {
    const { model, calls } = createMockModel(['{"verdict":"pass","score":1}'])

    const result = await generateStructured(model, 'judge this', verdictSchema, {
      temperature: 0.1,
    })

    expect(result.ok).toBe(true)
    expect(calls[0].temperature).toBe(0.1)
  })

  test('withholds temperature for OpenAI reasoning models', async () => {
    const { model, calls } = createMockModel(['{"verdict":"pass","score":1}'], {
      modelId: 'gpt-5.2',
      provider: 'openai',
    })

    const result = await generateStructured(model, 'judge this', verdictSchema, {
      temperature: 0.1,
    })

    expect(result.ok).toBe(true)
    expect(calls[0].temperature).toBeUndefined()
  })
})
