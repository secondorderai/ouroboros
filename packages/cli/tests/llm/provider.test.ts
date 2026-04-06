import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createProvider } from '@src/llm/provider'
import type { ModelConfig } from '@src/llm/provider'

describe('createProvider', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear relevant env vars
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    // Restore env vars
    if (savedEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (savedEnv.OPENAI_API_KEY !== undefined) {
      process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY
    } else {
      delete process.env.OPENAI_API_KEY
    }
  })

  test('creates Anthropic model when API key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

    const config: ModelConfig = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The model object should have the expected shape from AI SDK
    const model = result.value as Record<string, unknown>
    expect(model).toBeDefined()
    expect(model.modelId).toBe('claude-sonnet-4-20250514')
    expect(typeof model.doGenerate).toBe('function')
    expect(typeof model.doStream).toBe('function')
  })

  test('creates OpenAI model when API key is set', () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'

    const config: ModelConfig = {
      provider: 'openai',
      name: 'gpt-4o',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model).toBeDefined()
    expect(model.modelId).toBe('gpt-4o')
    expect(typeof model.doGenerate).toBe('function')
    expect(typeof model.doStream).toBe('function')
  })

  test('creates OpenAI-compatible model with baseUrl', () => {
    const config: ModelConfig = {
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
    }

    const result = createProvider(config)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model).toBeDefined()
    expect(model.modelId).toBe('llama-3.1-8b')
    expect(typeof model.doGenerate).toBe('function')
    expect(typeof model.doStream).toBe('function')
  })

  test('returns error when Anthropic API key is missing', () => {
    delete process.env.ANTHROPIC_API_KEY

    const config: ModelConfig = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('ANTHROPIC_API_KEY')
  })

  test('returns error when OpenAI API key is missing', () => {
    delete process.env.OPENAI_API_KEY

    const config: ModelConfig = {
      provider: 'openai',
      name: 'gpt-4o',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('OPENAI_API_KEY')
  })

  test('returns error when openai-compatible has no baseUrl', () => {
    const config: ModelConfig = {
      provider: 'openai-compatible',
      name: 'some-model',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('baseUrl')
  })

  test('rejects unknown provider', () => {
    // Force an unknown provider value to test the default branch
    const config = {
      provider: 'nonexistent' as 'anthropic',
      name: 'some-model',
      baseUrl: undefined,
    } as ModelConfig

    const result = createProvider(config)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Unsupported LLM provider')
    expect(result.error.message).toContain('Supported providers')
  })
})
