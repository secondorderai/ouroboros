import { describe, test, expect } from 'bun:test'
import type { LanguageModel } from 'ai'
import { buildReasoningProviderOptions } from '@src/llm/reasoning'

function fakeModel(provider: string, modelId: string): LanguageModel {
  return { provider, modelId } as unknown as LanguageModel
}

describe('buildReasoningProviderOptions', () => {
  test('no-op when both knobs undefined', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      undefined,
      undefined,
      undefined,
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('no-op when model has no reasoning support, even if knobs are set', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('openai.chat', 'gpt-4o'),
      8192,
      'high',
      undefined,
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('Anthropic mapping: thinkingBudgetTokens passes through and forces temperature=1', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      4096,
      undefined,
      undefined,
    )
    expect(result.providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    })
    expect(result.forceTemperatureOne).toBe(true)
  })

  test('Anthropic clamp: budget >= maxOutputTokens clamps to max-1024', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      16384,
      undefined,
      4096,
    )
    expect(result.providerOptions?.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 3072 },
    })
    expect(result.forceTemperatureOne).toBe(true)
  })

  test('Anthropic floor: clamp falls back to 1024 minimum', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      16384,
      undefined,
      1500,
    )
    expect(result.providerOptions?.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 1024 },
    })
  })

  test('Anthropic ignores non-positive or non-integer thinkingBudgetTokens', () => {
    expect(
      buildReasoningProviderOptions(
        fakeModel('anthropic.messages', 'claude-opus-4-7'),
        0,
        undefined,
        undefined,
      ).providerOptions,
    ).toBeUndefined()

    expect(
      buildReasoningProviderOptions(
        fakeModel('anthropic.messages', 'claude-opus-4-7'),
        -10,
        undefined,
        undefined,
      ).providerOptions,
    ).toBeUndefined()

    expect(
      buildReasoningProviderOptions(
        fakeModel('anthropic.messages', 'claude-opus-4-7'),
        4096.5,
        undefined,
        undefined,
      ).providerOptions,
    ).toBeUndefined()
  })

  test('OpenAI mapping: reasoningEffort passes through, no forced temperature', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('openai.responses', 'o3'),
      undefined,
      'medium',
      undefined,
    )
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } })
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('OpenAI mapping accepts minimal for gpt-5 family', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('openai.responses', 'gpt-5.4-medium'),
      undefined,
      'minimal',
      undefined,
    )
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'minimal' } })
  })

  test('cross-knob: thinkingBudgetTokens on OpenAI reasoning model is ignored', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('openai.responses', 'o3'),
      8192,
      undefined,
      undefined,
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('cross-knob: reasoningEffort on Anthropic thinking model is ignored', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      undefined,
      'high',
      undefined,
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })
})
