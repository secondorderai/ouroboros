import { describe, test, expect } from 'bun:test'
import type { LanguageModel } from 'ai'
import { buildReasoningProviderOptions } from '@src/llm/reasoning'

function fakeModel(provider: string, modelId: string): LanguageModel {
  return { provider, modelId } as unknown as LanguageModel
}

describe('buildReasoningProviderOptions', () => {
  test('no-op when reasoningEffort undefined', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      undefined,
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('no-op when model has no reasoning support, even if effort is set', () => {
    const result = buildReasoningProviderOptions(fakeModel('openai.chat', 'gpt-4o'), 'high')
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('no-op for older Claude models (pre-adaptive)', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-sonnet-4-5'),
      'high',
    )
    expect(result.providerOptions).toBeUndefined()
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('Anthropic adaptive: medium passes through and forces temperature=1', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      'medium',
    )
    expect(result.providerOptions).toEqual({
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'medium',
      },
    })
    expect(result.forceTemperatureOne).toBe(true)
  })

  test('Anthropic adaptive: max passes through unchanged', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-sonnet-4-6'),
      'max',
    )
    expect(result.providerOptions?.anthropic).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'max',
    })
    expect(result.forceTemperatureOne).toBe(true)
  })

  test('Anthropic adaptive clamp: minimal becomes low', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('anthropic.messages', 'claude-opus-4-7'),
      'minimal',
    )
    expect(result.providerOptions?.anthropic).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'low',
    })
  })

  test('OpenAI reasoning: medium passes through, no forced temperature', () => {
    const result = buildReasoningProviderOptions(fakeModel('openai.responses', 'o3'), 'medium')
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } })
    expect(result.forceTemperatureOne).toBe(false)
  })

  test('OpenAI reasoning: minimal passes through for gpt-5 family', () => {
    const result = buildReasoningProviderOptions(
      fakeModel('openai.responses', 'gpt-5.4-medium'),
      'minimal',
    )
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'minimal' } })
  })

  test('OpenAI reasoning clamp: max becomes high', () => {
    const result = buildReasoningProviderOptions(fakeModel('openai.responses', 'o3'), 'max')
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
    expect(result.forceTemperatureOne).toBe(false)
  })
})
