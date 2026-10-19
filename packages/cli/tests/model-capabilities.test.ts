import { getContextWindowTokens, getReasoningSupport } from '@src/llm/model-capabilities'
import { getModelDescriptor, getReasoningEfforts } from '@ouroboros/shared'
import { describe, expect, test } from 'bun:test'

describe('current model families', () => {
  test('recognises GPT-6.1 Sol with separate API and subscription budgets', () => {
    expect(getContextWindowTokens('gpt-6.1-sol', 'openai')).toBe(1_050_000)
    expect(getContextWindowTokens('gpt-6.1-sol', 'openai-chatgpt')).toBe(500_000)
    expect(getContextWindowTokens('gpt-6-astra', 'openai-chatgpt')).toBe(272_000)
    expect(getReasoningSupport('gpt-6-astra')?.kind).toBe('openai-reasoning')
  })

  test('recognises new families and exact case-sensitive provider IDs', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'glm-5.3',
      'kimi-k3',
      'MiniMax-M3',
      'qwen3.8-max',
      'deepseek-flash',
      'mistral-large-4',
    ]) {
      expect(getContextWindowTokens(id)).toBe(1_000_000)
    }
    expect(getContextWindowTokens('gemini-4-argon')).toBe(1_048_576)
    expect(getContextWindowTokens('grok-4.7')).toBe(500_000)
  })
  test('retains exact current IDs, restrictions, lifecycle and supported efforts', () => {
    for (const id of [
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-daybreak-blue-latest',
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'grok-4.7',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash-Preview',
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
      'deepseek-flash',
      'deepseek-v4-pro',
      'mistral-large-4',
      'mistral-medium-3-5',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3.5-super-vl-120b-a12b',
    ]) {
      const descriptor = getModelDescriptor(id)
      expect(descriptor?.id).toBe(id)
      expect(descriptor?.lifecycle).toBe('current')
      expect(descriptor?.verifiedAt).toBe('2026-10-19')
      expect(descriptor?.sourceUrl).toStartWith('https://')
    }
    expect(getModelDescriptor('devstral-2')?.lifecycle).toBe('deprecated')
    expect(getModelDescriptor('nemotron-3-ultra-550b-a55b')?.id).toBe(
      'nvidia/nemotron-3-ultra-550b-a55b',
    )
    expect(getModelDescriptor('MiniMax-M3.1-Flash-Preview')?.accessRestriction).toContain('M Plan')
    expect(getModelDescriptor('nemotron-3.5-super-vl-120b-a12b')?.accessRestriction).toContain(
      'Early access',
    )
    expect(getReasoningEfforts('glm-5.3')).toEqual(['low', 'high', 'max'])
    expect(getReasoningEfforts('grok-4.7')).not.toContain('max')
    expect(getReasoningEfforts('claude-opus-5-5')).toContain('xhigh')
  })
})

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
