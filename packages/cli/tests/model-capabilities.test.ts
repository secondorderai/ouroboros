import { describe, test, expect } from 'bun:test'
import { getContextWindowTokens, getReasoningSupport } from '@src/llm/model-capabilities'

describe('getContextWindowTokens', () => {
  test('exact match for claude-sonnet-4-20250514', () => {
    expect(getContextWindowTokens('claude-sonnet-4-20250514')).toBe(200_000)
  })

  test('exact match for gpt-4o', () => {
    expect(getContextWindowTokens('gpt-4o')).toBe(128_000)
  })

  test('exact match for gpt-4-turbo', () => {
    expect(getContextWindowTokens('gpt-4-turbo')).toBe(128_000)
  })

  test('prefix match for claude-3-5-sonnet-latest', () => {
    expect(getContextWindowTokens('claude-3-5-sonnet-latest')).toBe(200_000)
  })

  test('prefix match for gpt-4o-2024-05-13', () => {
    expect(getContextWindowTokens('gpt-4o-2024-05-13')).toBe(128_000)
  })

  test('prefix match for o1-mini with longer key', () => {
    expect(getContextWindowTokens('o1-mini-2024-09-12')).toBe(128_000)
  })

  test('exact match for provider-prefixed model ids', () => {
    expect(getContextWindowTokens('qwen/qwen3.6-plus')).toBe(1_000_000)
  })

  test('prefix match for provider-prefixed model ids', () => {
    expect(getContextWindowTokens('openai/gpt-4o-2024-05-13')).toBe(128_000)
  })

  test('returns null for unknown model', () => {
    expect(getContextWindowTokens('unknown-model-xyz')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getContextWindowTokens('')).toBeNull()
  })

  test('gpt-4 has smaller context than gpt-4-turbo (no false prefix match)', () => {
    expect(getContextWindowTokens('gpt-4')).toBe(8_192)
  })

  test('exact match for gpt-5.5 returns 1.05M context', () => {
    expect(getContextWindowTokens('gpt-5.5')).toBe(1_050_000)
  })

  test('exact match for gpt-5.5-mini returns 1.1M context', () => {
    expect(getContextWindowTokens('gpt-5.5-mini')).toBe(1_100_000)
  })

  test('exact match for gpt-5.5-codex returns 400K context', () => {
    expect(getContextWindowTokens('gpt-5.5-codex')).toBe(400_000)
  })

  test('prefix match for gpt-5.5-pro snapshot variants', () => {
    expect(getContextWindowTokens('gpt-5.5-pro-2026-04-15')).toBe(1_050_000)
  })

  test('prefix match for openai-namespaced gpt-5.5', () => {
    expect(getContextWindowTokens('openai/gpt-5.5')).toBe(1_050_000)
  })
})

describe('getReasoningSupport', () => {
  test('o3 supports openai-reasoning', () => {
    expect(getReasoningSupport('o3')).toEqual({ kind: 'openai-reasoning' })
  })

  test('o4-mini supports openai-reasoning', () => {
    expect(getReasoningSupport('o4-mini')).toEqual({ kind: 'openai-reasoning' })
  })

  test('o1-mini snapshot supports openai-reasoning via prefix', () => {
    expect(getReasoningSupport('o1-mini-2024-09-12')).toEqual({ kind: 'openai-reasoning' })
  })

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
