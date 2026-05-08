import { getContextWindowTokens, getReasoningSupport } from '@src/llm/model-capabilities'
import { describe, expect, test } from 'bun:test'

describe('getContextWindowTokens', () => {
  test('exact match for claude-sonnet-4-20250514', () => {
    expect(getContextWindowTokens('claude-sonnet-4-20250514')).toBe(200_000)
  })

  test('exact match for provider-prefixed model ids', () => {
    expect(getContextWindowTokens('qwen/qwen3.6-plus')).toBe(1_000_000)
  })

  test('prefix match for provider-prefixed model ids', () => {
    expect(getContextWindowTokens('openai/gpt-5.5-2026-01-01')).toBe(1_050_000)
  })

  test('returns null for unknown model', () => {
    expect(getContextWindowTokens('unknown-model-xyz')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getContextWindowTokens('')).toBeNull()
  })

  test('removed legacy OpenAI models are unknown', () => {
    expect(getContextWindowTokens('gpt-4o')).toBeNull()
    expect(getContextWindowTokens('gpt-4o-2024-05-13')).toBeNull()
    expect(getContextWindowTokens('gpt-4-turbo')).toBeNull()
    expect(getContextWindowTokens('gpt-4')).toBeNull()
    expect(getContextWindowTokens('gpt-3.5-turbo')).toBeNull()
  })

  test('removed OpenAI o-series models are unknown', () => {
    expect(getContextWindowTokens('o3')).toBeNull()
    expect(getContextWindowTokens('o4-mini')).toBeNull()
    expect(getContextWindowTokens('o1-mini-2024-09-12')).toBeNull()
  })

  test('removed Claude 3 series models are unknown', () => {
    expect(getContextWindowTokens('claude-3-5-sonnet')).toBeNull()
    expect(getContextWindowTokens('claude-3-5-sonnet-latest')).toBeNull()
  })

  test('exact match for gpt-5.5 returns 1.05M context', () => {
    expect(getContextWindowTokens('gpt-5.5')).toBe(1_050_000)
  })

  test('prefix match for openai-namespaced gpt-5.5', () => {
    expect(getContextWindowTokens('openai/gpt-5.5')).toBe(1_050_000)
  })

  test('OpenAI model capabilities apply to ChatGPT subscription provider', () => {
    expect(getContextWindowTokens('gpt-5.5', 'openai-chatgpt')).toBe(1_050_000)
    expect(getContextWindowTokens('openai-chatgpt/gpt-5.5')).toBe(1_050_000)
  })

  test('model capabilities apply provider-agnostically to namespaced non-OpenAI ids', () => {
    expect(getContextWindowTokens('anthropic/claude-opus-4-7')).toBe(1_000_000)
  })
})

describe('getReasoningSupport', () => {
  test('gpt-5.4-medium supports openai-reasoning', () => {
    expect(getReasoningSupport('gpt-5.4-medium')).toEqual({ kind: 'openai-reasoning' })
  })

  test('gpt-5.5 supports openai-reasoning', () => {
    expect(getReasoningSupport('gpt-5.5')).toEqual({ kind: 'openai-reasoning' })
  })

  test('claude-opus-4-7 supports anthropic-adaptive', () => {
    expect(getReasoningSupport('claude-opus-4-7')).toEqual({ kind: 'anthropic-adaptive' })
  })

  test('claude-opus-4-6 supports anthropic-adaptive', () => {
    expect(getReasoningSupport('claude-opus-4-6')).toEqual({ kind: 'anthropic-adaptive' })
  })

  test('claude-sonnet-4-6 supports anthropic-adaptive', () => {
    expect(getReasoningSupport('claude-sonnet-4-6')).toEqual({ kind: 'anthropic-adaptive' })
  })

  test('claude-opus-4-7 snapshot resolves via prefix', () => {
    expect(getReasoningSupport('claude-opus-4-7-20260101')).toEqual({ kind: 'anthropic-adaptive' })
  })

  test('namespaced openai/gpt-5.4-medium resolves to openai-reasoning', () => {
    expect(getReasoningSupport('openai/gpt-5.4-medium', 'openai')).toEqual({
      kind: 'openai-reasoning',
    })
  })

  test('OpenAI reasoning capabilities apply to ChatGPT subscription provider', () => {
    expect(getReasoningSupport('gpt-5.5', 'openai-chatgpt')).toEqual({
      kind: 'openai-reasoning',
    })
    expect(getReasoningSupport('openai-chatgpt/gpt-5.5')).toEqual({
      kind: 'openai-reasoning',
    })
  })

  test('reasoning capabilities apply provider-agnostically to namespaced non-OpenAI ids', () => {
    expect(getReasoningSupport('anthropic/claude-opus-4-7')).toEqual({
      kind: 'anthropic-adaptive',
    })
  })

  // Pre-4.6 Claude models don't support adaptive thinking. The deprecated
  // `thinking.type: 'enabled'` path is no longer wired up, so reasoning is null.
  test('claude-sonnet-4-5 has no reasoning support (pre-adaptive)', () => {
    expect(getReasoningSupport('claude-sonnet-4-5')).toBeNull()
  })

  test('claude-opus-4-1 has no reasoning support (pre-adaptive)', () => {
    expect(getReasoningSupport('claude-opus-4-1')).toBeNull()
  })

  test('claude-haiku-4-5 has no reasoning support (pre-adaptive)', () => {
    expect(getReasoningSupport('claude-haiku-4-5')).toBeNull()
  })

  test('claude-3-5-sonnet has no reasoning support', () => {
    expect(getReasoningSupport('claude-3-5-sonnet')).toBeNull()
  })

  test('o-series models have no reasoning support after removal', () => {
    expect(getReasoningSupport('o3')).toBeNull()
    expect(getReasoningSupport('o4-mini')).toBeNull()
    expect(getReasoningSupport('o1-mini-2024-09-12')).toBeNull()
  })

  test('gpt-4o has no reasoning support', () => {
    expect(getReasoningSupport('gpt-4o')).toBeNull()
  })

  test('unknown model has no reasoning support', () => {
    expect(getReasoningSupport('unknown-xyz')).toBeNull()
  })

  test('empty string has no reasoning support', () => {
    expect(getReasoningSupport('')).toBeNull()
  })
})
