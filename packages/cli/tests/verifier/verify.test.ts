/**
 * Tests for the completion-gate verifier call and prompt builder.
 */
import { describe, test, expect } from 'bun:test'
import type { LanguageModel } from 'ai'
import { buildVerifierPrompt, verify, type VerifyInput } from '@src/verifier/verify'
import { failureSignature, type VerifierEvidenceItem } from '@src/verifier/types'

/** Non-streaming mock model (doGenerate shape mirrors tests/rsi/crystallize.test.ts). */
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
      throw new Error('Streaming not used by verify')
    },
  } as unknown as LanguageModel
}

function makeInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    model: createMockLLM('{"verdict":"pass"}'),
    task: 'Add a verifier module and tests',
    steerTexts: [],
    doneCriteria: [],
    evidence: [
      { toolName: 'bash', isError: false, summary: 'bun test: 12 pass, 0 fail' },
      { toolName: 'write-file', isError: true, summary: 'EACCES: permission denied' },
    ],
    toolCallCount: 2,
    candidateAnswer: 'All done — module added and tests pass.',
    ...overrides,
  }
}

describe('buildVerifierPrompt', () => {
  test('includes the task, evidence, candidate answer, and strict-verifier rules', () => {
    const prompt = buildVerifierPrompt(makeInput())

    expect(prompt).toContain('strict completion verifier')
    expect(prompt).toContain("The agent's claims are NOT evidence")
    expect(prompt).toContain('## Original Task')
    expect(prompt).toContain('Add a verifier module and tests')
    expect(prompt).toContain('## Tool-Call Evidence')
    expect(prompt).toContain('bun test: 12 pass, 0 fail')
    expect(prompt).toContain('[write-file — ERROR] EACCES: permission denied')
    expect(prompt).toContain('## Candidate Answer')
    expect(prompt).toContain('All done — module added and tests pass.')
    expect(prompt).toContain('ONLY a JSON object')
  })

  test('instructs that non-applicable conditional criteria count as satisfied', () => {
    const prompt = buildVerifierPrompt(makeInput())

    expect(prompt).toContain('Some criteria are conditional')
    expect(prompt).toContain(
      'A criterion whose condition does not apply is satisfied by definition',
    )
    expect(prompt).toContain('do not mark it failed or unknown')
    expect(prompt).toContain(
      'Use "pass" only when the evidence supports every applicable criterion',
    )
  })

  test('instructs that prohibition criteria need no positive proof', () => {
    const prompt = buildVerifierPrompt(makeInput())

    expect(prompt).toContain('phrased as a prohibition')
    expect(prompt).toContain('it does not require positive proof')
  })

  test('falls back to derive-criteria instruction when doneCriteria is empty', () => {
    const prompt = buildVerifierPrompt(makeInput({ doneCriteria: [] }))

    expect(prompt).toContain('## Done Criteria')
    expect(prompt).toContain('Derive the concrete completion criteria from the task')
  })

  test('numbers explicit done criteria when provided', () => {
    const prompt = buildVerifierPrompt(
      makeInput({ doneCriteria: ['Tests pass', 'No lint errors'] }),
    )

    expect(prompt).toContain('1. Tests pass')
    expect(prompt).toContain('2. No lint errors')
    expect(prompt).toContain('every applicable criterion holds')
    expect(prompt).toContain(
      'A conditional criterion whose condition this task does not trigger counts as satisfied',
    )
    expect(prompt).not.toContain('Derive the concrete completion criteria')
  })

  test('includes mid-run steering section only when steers exist', () => {
    const withSteers = buildVerifierPrompt(makeInput({ steerTexts: ['Also update the README'] }))
    expect(withSteers).toContain('## Mid-run User Steering')
    expect(withSteers).toContain('1. Also update the README')

    const withoutSteers = buildVerifierPrompt(makeInput({ steerTexts: [] }))
    expect(withoutSteers).not.toContain('## Mid-run User Steering')
  })

  test('notes elided evidence entries when toolCallCount exceeds the ledger', () => {
    const evidence: VerifierEvidenceItem[] = [
      { toolName: 'bash', isError: false, summary: 'recent result' },
    ]
    const prompt = buildVerifierPrompt(makeInput({ evidence, toolCallCount: 75 }))

    expect(prompt).toContain('75 tool call(s) were executed')
    expect(prompt).toContain('[... 74 earlier tool call(s) elided ...]')
    // The surviving entry keeps its absolute index.
    expect(prompt).toContain('75. [bash] recent result')
  })

  test('omits the elision marker when nothing was elided', () => {
    const prompt = buildVerifierPrompt(makeInput())
    expect(prompt).not.toContain('elided')
  })

  test('handles an empty evidence ledger', () => {
    const prompt = buildVerifierPrompt(makeInput({ evidence: [], toolCallCount: 0 }))
    expect(prompt).toContain('(no tool results recorded)')
  })
})

describe('verify', () => {
  test('happy path: parses a pass verdict', async () => {
    const model = createMockLLM(
      JSON.stringify({ verdict: 'pass', failures: [], reason: 'All criteria supported.' }),
    )

    const result = await verify(makeInput({ model }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toBe('pass')
    expect(result.value.failures).toEqual([])
    expect(result.value.reason).toBe('All criteria supported.')
  })

  test('parses a fail verdict with defaulted failure fields', async () => {
    const model = createMockLLM(
      JSON.stringify({
        verdict: 'fail',
        failures: [{ criterion: 'Tests pass' }],
        reason: 'No test run found in the evidence.',
      }),
    )

    const result = await verify(makeInput({ model }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verdict).toBe('fail')
    expect(result.value.failures).toHaveLength(1)
    expect(result.value.failures[0].criterion).toBe('Tests pass')
    // Unspecified string fields default to '' instead of failing validation.
    expect(result.value.failures[0].evidence).toBe('')
    expect(result.value.failures[0].suggestion).toBe('')
  })

  test('malformed response returns err', async () => {
    const model = createMockLLM('The task looks complete to me!')

    const result = await verify(makeInput({ model }))

    expect(result.ok).toBe(false)
  })

  test('schema-violating verdict returns err', async () => {
    const model = createMockLLM('{"verdict":"definitely"}')

    const result = await verify(makeInput({ model }))

    expect(result.ok).toBe(false)
  })
})

describe('failureSignature', () => {
  test('is order-independent', () => {
    const a = failureSignature([
      { criterion: 'Tests pass', evidence: 'x', suggestion: 'y' },
      { criterion: 'Docs updated', evidence: '', suggestion: '' },
    ])
    const b = failureSignature([
      { criterion: 'Docs updated', evidence: 'different', suggestion: 'fields' },
      { criterion: 'Tests pass', evidence: '', suggestion: '' },
    ])

    expect(a).toBe(b)
  })

  test('normalizes case and whitespace, ignores empty criteria', () => {
    const a = failureSignature([
      { criterion: '  Tests Pass ', evidence: '', suggestion: '' },
      { criterion: '', evidence: 'noise', suggestion: '' },
    ])
    const b = failureSignature([{ criterion: 'tests pass', evidence: '', suggestion: '' }])

    expect(a).toBe(b)
  })

  test('distinguishes different failure sets', () => {
    const a = failureSignature([{ criterion: 'Tests pass', evidence: '', suggestion: '' }])
    const b = failureSignature([{ criterion: 'Docs updated', evidence: '', suggestion: '' }])

    expect(a).not.toBe(b)
  })
})
