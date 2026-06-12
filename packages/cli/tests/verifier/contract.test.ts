/**
 * Tests for done-contract extraction and its prompt builder.
 */
import { describe, test, expect } from 'bun:test'
import type { LanguageModel } from 'ai'
import {
  buildDoneContractPrompt,
  doneContractSchema,
  extractDoneContract,
  type ExtractDoneContractInput,
} from '@src/verifier/contract'

/** Non-streaming mock model that records the prompt it received. */
function createMockLLM(responseText: string): { model: LanguageModel; prompts: string[] } {
  const prompts: string[] = []
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async (options: {
      prompt: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    }) => {
      const userMessage = options.prompt.find((message) => message.role === 'user')
      prompts.push(
        userMessage?.content.map((part) => ('text' in part ? (part.text ?? '') : '')).join('') ??
          '',
      )
      return {
        content: [{ type: 'text' as const, text: responseText }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: { inputTokens: 10, outputTokens: 20 },
        warnings: [],
      }
    },

    doStream: async () => {
      throw new Error('Streaming not used by extractDoneContract')
    },
  } as unknown as LanguageModel
  return { model, prompts }
}

function makeInput(overrides: Partial<ExtractDoneContractInput> = {}): ExtractDoneContractInput {
  return {
    model: createMockLLM('{"criteria":["Tests pass"]}').model,
    task: 'Add a verifier module and tests',
    steerTexts: [],
    standingCriteria: [],
    ...overrides,
  }
}

describe('buildDoneContractPrompt', () => {
  test('includes the task and the no-invented-requirements rules', () => {
    const prompt = buildDoneContractPrompt({
      task: 'Refactor the parser and keep behavior identical',
      steerTexts: [],
    })

    expect(prompt).toContain('done contract')
    expect(prompt).toContain('Do not invent requirements')
    expect(prompt).toContain('independently')
    expect(prompt).toContain('## Task')
    expect(prompt).toContain('Refactor the parser and keep behavior identical')
    expect(prompt).toContain('ONLY a JSON object')
  })

  test('instructs the extractor to keep conditional requirements explicit', () => {
    const prompt = buildDoneContractPrompt({ task: 'do it', steerTexts: [] })

    expect(prompt).toContain('Include a criterion only when it applies to this task')
    expect(prompt).toContain('state the condition explicitly')
    expect(prompt).toContain('satisfied when the condition does not apply')
  })

  test('includes mid-run steering section only when steers exist', () => {
    const withSteers = buildDoneContractPrompt({
      task: 'do it',
      steerTexts: ['Also update the README', 'Skip the changelog'],
    })
    expect(withSteers).toContain('## Mid-run User Steering')
    expect(withSteers).toContain('1. Also update the README')
    expect(withSteers).toContain('2. Skip the changelog')

    const withoutSteers = buildDoneContractPrompt({ task: 'do it', steerTexts: [] })
    expect(withoutSteers).not.toContain('## Mid-run User Steering')
  })

  test('standing criteria are never sent to the model for rewriting', async () => {
    const { model, prompts } = createMockLLM('{"criteria":["Tests pass"]}')

    await extractDoneContract(
      makeInput({ model, standingCriteria: ['No existing test was deleted.'] }),
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('No existing test was deleted.')
  })
})

describe('doneContractSchema', () => {
  test('rejects an empty criteria list and lists longer than 12', () => {
    expect(doneContractSchema.safeParse({ criteria: [] }).success).toBe(false)
    expect(
      doneContractSchema.safeParse({ criteria: Array.from({ length: 13 }, (_, i) => `c${i}`) })
        .success,
    ).toBe(false)
    expect(doneContractSchema.safeParse({ criteria: ['one'] }).success).toBe(true)
  })
})

describe('extractDoneContract', () => {
  test('happy path: extracted criteria come first, standing criteria appended verbatim', async () => {
    const { model } = createMockLLM('{"criteria":["Parser refactored","Tests pass"]}')

    const result = await extractDoneContract(
      makeInput({
        model,
        standingCriteria: ['No existing test was deleted, skipped, or weakened.'],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([
      'Parser refactored',
      'Tests pass',
      'No existing test was deleted, skipped, or weakened.',
    ])
  })

  test('handles fenced JSON output', async () => {
    const { model } = createMockLLM('```json\n{"criteria":["Tests pass"]}\n```')

    const result = await extractDoneContract(makeInput({ model }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(['Tests pass'])
  })

  test('dedupes case-insensitively with first occurrence winning', async () => {
    const { model } = createMockLLM('{"criteria":["Tests Pass","tests pass","  Docs   updated  "]}')

    const result = await extractDoneContract(
      makeInput({ model, standingCriteria: ['docs updated', 'Lint is clean'] }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(['Tests Pass', 'Docs   updated', 'Lint is clean'])
  })

  test('drops empty/whitespace criteria', async () => {
    const { model } = createMockLLM('{"criteria":["Tests pass","   "]}')

    const result = await extractDoneContract(makeInput({ model, standingCriteria: ['', '  '] }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(['Tests pass'])
  })

  test('malformed response returns err', async () => {
    const { model } = createMockLLM('Sure! The criteria are: tests pass.')

    const result = await extractDoneContract(makeInput({ model }))

    expect(result.ok).toBe(false)
  })

  test('schema-violating response returns err', async () => {
    const { model } = createMockLLM('{"criteria":[]}')

    const result = await extractDoneContract(makeInput({ model }))

    expect(result.ok).toBe(false)
  })

  test('LLM error returns err instead of throwing', async () => {
    const model = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('model exploded')
      },
      doStream: async () => {
        throw new Error('Streaming not used')
      },
    } as unknown as LanguageModel

    const result = await extractDoneContract(makeInput({ model }))

    expect(result.ok).toBe(false)
  })
})
