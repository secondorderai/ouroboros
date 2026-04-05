import { describe, test, expect } from 'bun:test'
import {
  ReflectionRecordSchema,
  reflect,
  shouldCrystallize,
  type ReflectionRecord,
} from '@src/rsi/crystallize'
import type { SkillCatalogEntry } from '@src/tools/skill-manager'
import type { LanguageModel } from 'ai'

// ── Mock LLM helpers ─────────────────────────────────────────────────

/**
 * Create a mock LanguageModelV3 that returns a predefined text response.
 * Uses the V3 specification format that the AI SDK expects.
 */
function createMockLLM(responseText: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: responseText }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: { inputTokens: 10, outputTokens: 20 },
      warnings: [],
    }),

    doStream: async () => {
      throw new Error('Streaming not implemented in mock')
    },
  } as unknown as LanguageModel
}

/**
 * Create a mock LLM that throws an error.
 */
function createErrorLLM(errorMessage: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error(errorMessage)
    },

    doStream: async () => {
      throw new Error(errorMessage)
    },
  } as unknown as LanguageModel
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ReflectionRecordSchema', () => {
  test('validates a complete well-formed record', () => {
    const record = {
      taskSummary: 'Built a CLI tool',
      novelty: 0.8,
      generalizability: 0.9,
      proposedSkillName: 'cli-builder',
      proposedSkillDescription: 'Generates CLI tools from spec',
      keySteps: ['Parse spec', 'Generate commands', 'Wire up args'],
      reasoning: 'Novel approach to CLI generation',
      shouldCrystallize: true,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(true)
  })

  test('validates a minimal record (without optional fields)', () => {
    const record = {
      taskSummary: 'Fixed a bug',
      novelty: 0.2,
      generalizability: 0.3,
      reasoning: 'Standard debugging approach',
      shouldCrystallize: false,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(true)
  })

  test('rejects record with out-of-range novelty', () => {
    const record = {
      taskSummary: 'Did a thing',
      novelty: 1.5,
      generalizability: 0.5,
      reasoning: 'Some reasoning',
      shouldCrystallize: false,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
  })

  test('rejects record with missing required fields', () => {
    const record = {
      taskSummary: 'Did a thing',
      // missing novelty, generalizability, reasoning, shouldCrystallize
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
  })
})

describe('reflect()', () => {
  // -----------------------------------------------------------------------
  // Feature test: Reflection produces valid record
  // -----------------------------------------------------------------------
  test('produces a valid ReflectionRecord from well-formed LLM response', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Implemented a caching layer for API responses',
      novelty: 0.75,
      generalizability: 0.8,
      proposedSkillName: 'api-cache',
      proposedSkillDescription: 'Implements caching for external API calls with TTL support',
      keySteps: ['Identify cacheable endpoints', 'Add cache middleware', 'Set TTL policies'],
      reasoning: 'This caching pattern is broadly applicable and not covered by existing skills.',
      shouldCrystallize: true,
    })

    const llm = createMockLLM(mockResponse)
    const result = await reflect('Implemented a caching layer for API responses', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Validate against schema
    const schemaResult = ReflectionRecordSchema.safeParse(result.value)
    expect(schemaResult.success).toBe(true)

    expect(result.value.novelty).toBe(0.75)
    expect(result.value.generalizability).toBe(0.8)
    expect(result.value.proposedSkillName).toBe('api-cache')
    expect(result.value.shouldCrystallize).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Feature test: Existing skills reduce novelty (prompt contains skills)
  // -----------------------------------------------------------------------
  test('includes existing skill names and descriptions in the reflection prompt', async () => {
    let capturedPrompt = ''

    const existingSkills: SkillCatalogEntry[] = [
      {
        name: 'file-summarizer',
        description: 'Reads files and produces summaries',
        status: 'core',
      },
      {
        name: 'code-reviewer',
        description: 'Reviews code for common issues',
        status: 'generated',
      },
    ]

    const mockResponse = JSON.stringify({
      taskSummary: 'Summarized a file',
      novelty: 0.1,
      generalizability: 0.6,
      reasoning: 'The file-summarizer skill already handles this.',
      shouldCrystallize: false,
    })

    // Create a mock that captures the prompt
    const llm = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},

      doGenerate: async (options: { prompt: unknown }) => {
        // Capture the prompt for inspection
        capturedPrompt = JSON.stringify(options.prompt)
        return {
          content: [{ type: 'text' as const, text: mockResponse }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: 10, outputTokens: 20 },
          warnings: [],
        }
      },

      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as LanguageModel

    await reflect('Summarized a file', existingSkills, llm)

    // The prompt should contain both skill names and descriptions
    expect(capturedPrompt).toContain('file-summarizer')
    expect(capturedPrompt).toContain('Reads files and produces summaries')
    expect(capturedPrompt).toContain('code-reviewer')
    expect(capturedPrompt).toContain('Reviews code for common issues')
  })

  // -----------------------------------------------------------------------
  // Feature test: Malformed LLM response handled gracefully
  // -----------------------------------------------------------------------
  test('returns Result.err for invalid JSON response', async () => {
    const llm = createMockLLM('This is not JSON at all')
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Failed to parse reflection response as JSON')
  })

  test('returns Result.err for JSON missing required fields', async () => {
    const llm = createMockLLM(JSON.stringify({ taskSummary: 'only this field' }))
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('failed schema validation')
  })

  test('returns Result.err when LLM call fails', async () => {
    const llm = createErrorLLM('API key expired')
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Reflection LLM call failed')
  })

  test('handles JSON wrapped in markdown fences', async () => {
    const jsonBody = JSON.stringify({
      taskSummary: 'Built a parser',
      novelty: 0.6,
      generalizability: 0.5,
      reasoning: 'Decent but not groundbreaking',
      shouldCrystallize: false,
    })

    const llm = createMockLLM('```json\n' + jsonBody + '\n```')
    const result = await reflect('Built a parser', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.novelty).toBe(0.6)
  })

  test('works with empty skill catalog', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Created a new feature',
      novelty: 0.9,
      generalizability: 0.85,
      proposedSkillName: 'feature-creator',
      proposedSkillDescription: 'Generates new features from specs',
      keySteps: ['Analyze spec', 'Generate code', 'Write tests'],
      reasoning: 'Completely new approach with no existing skills to compare.',
      shouldCrystallize: true,
    })

    const llm = createMockLLM(mockResponse)
    const result = await reflect('Created a new feature', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.novelty).toBe(0.9)
    expect(result.value.shouldCrystallize).toBe(true)
  })
})

describe('shouldCrystallize()', () => {
  const baseRecord: ReflectionRecord = {
    taskSummary: 'Test task',
    novelty: 0,
    generalizability: 0,
    reasoning: 'Test reasoning',
    shouldCrystallize: false,
  }

  // -----------------------------------------------------------------------
  // Feature test: High novelty triggers crystallization
  // -----------------------------------------------------------------------
  test('returns true when both scores exceed threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.9,
      generalizability: 0.85,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Feature test: Low novelty does not trigger crystallization
  // -----------------------------------------------------------------------
  test('returns false when novelty is below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.3,
      generalizability: 0.9,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when generalizability is below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.9,
      generalizability: 0.3,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when both scores are below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.5,
      generalizability: 0.5,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when scores exactly equal threshold (strict >)', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.7,
      generalizability: 0.7,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns true with custom lower threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.5,
      generalizability: 0.5,
    }

    expect(shouldCrystallize(record, 0.4)).toBe(true)
  })
})
