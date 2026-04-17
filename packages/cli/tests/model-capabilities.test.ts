import { describe, test, expect } from 'bun:test'
import { getContextWindowTokens } from '@src/llm/model-capabilities'

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

  test('returns null for unknown model', () => {
    expect(getContextWindowTokens('unknown-model-xyz')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getContextWindowTokens('')).toBeNull()
  })

  test('gpt-4 has smaller context than gpt-4-turbo (no false prefix match)', () => {
    expect(getContextWindowTokens('gpt-4')).toBe(8_192)
  })
})
