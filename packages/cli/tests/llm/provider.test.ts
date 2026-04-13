import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createProvider, patchMalformedToolCallTypes } from '@src/llm/provider'
import type { ModelConfig } from '@src/llm/provider'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_CHATGPT_PROVIDER } from '@src/auth/openai-chatgpt'
import { setAuth } from '@src/auth'

describe('createProvider', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tempAuthDir: string

  beforeEach(() => {
    // Save and clear relevant env vars
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    savedEnv.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    savedEnv.OUROBOROS_AUTH_FILE = process.env.OUROBOROS_AUTH_FILE
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    tempAuthDir = mkdtempSync(join(tmpdir(), 'ouroboros-provider-auth-'))
    process.env.OUROBOROS_AUTH_FILE = join(tempAuthDir, 'auth.json')
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
    if (savedEnv.OUROBOROS_OPENAI_COMPATIBLE_API_KEY !== undefined) {
      process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = savedEnv.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    } else {
      delete process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    }
    if (savedEnv.OUROBOROS_AUTH_FILE !== undefined) {
      process.env.OUROBOROS_AUTH_FILE = savedEnv.OUROBOROS_AUTH_FILE
    } else {
      delete process.env.OUROBOROS_AUTH_FILE
    }
    rmSync(tempAuthDir, { recursive: true, force: true })
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

  test('uses model.apiKey for Anthropic when env var is absent', () => {
    const config: ModelConfig = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      apiKey: 'config-anthropic-key',
      baseUrl: undefined,
    }

    const result = createProvider(config)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('claude-sonnet-4-20250514')
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

  test('uses OPENAI_API_KEY env var before model.apiKey for OpenAI', () => {
    process.env.OPENAI_API_KEY = 'env-openai-key'

    const result = createProvider({
      provider: 'openai',
      name: 'gpt-4o',
      baseUrl: undefined,
      apiKey: 'config-openai-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('gpt-4o')
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
    expect(model.provider).toBe('openai-compatible.chat')
    expect(typeof model.doGenerate).toBe('function')
    expect(typeof model.doStream).toBe('function')
  })

  test('uses model.apiKey for OpenAI-compatible when env var is absent', () => {
    const result = createProvider({
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'config-compatible-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('llama-3.1-8b')
  })

  test('uses dedicated env var before model.apiKey for OpenAI-compatible', () => {
    process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = 'env-compatible-key'

    const result = createProvider({
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'config-compatible-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('llama-3.1-8b')
  })

  test('does not reuse OPENAI_API_KEY for OpenAI-compatible', () => {
    process.env.OPENAI_API_KEY = 'wrong-openai-key'

    const result = createProvider({
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'config-compatible-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('llama-3.1-8b')
  })

  test('supports explicit OpenAI-compatible completion apiMode', () => {
    const result = createProvider({
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
      apiMode: 'completion',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('llama-3.1-8b')
    expect(model.provider).toBe('openai-compatible.completion')
  })

  test('supports explicit OpenAI-compatible responses apiMode', () => {
    const result = createProvider({
      provider: 'openai-compatible',
      name: 'llama-3.1-8b',
      baseUrl: 'http://localhost:11434/v1',
      apiMode: 'responses',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('llama-3.1-8b')
    expect(model.provider).toBe('openai-compatible.responses')
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

  test('returns remediation error when openai-chatgpt auth is missing', () => {
    const result = createProvider({
      provider: 'openai-chatgpt',
      name: 'gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('ouroboros auth login --provider openai-chatgpt')
  })

  test('rejects unsupported openai-chatgpt model ids', () => {
    const authResult = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
    })
    expect(authResult.ok).toBe(true)

    const result = createProvider({
      provider: 'openai-chatgpt',
      name: 'gpt-4o',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('Unsupported ChatGPT subscription model')
  })

  test('creates openai-chatgpt responses model when oauth auth exists', () => {
    const authResult = setAuth(OPENAI_CHATGPT_PROVIDER, {
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
      accountId: 'acct_test',
    })
    expect(authResult.ok).toBe(true)

    const result = createProvider({
      provider: 'openai-chatgpt',
      name: 'gpt-5.4',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const model = result.value as Record<string, unknown>
    expect(model.modelId).toBe('gpt-5.4')
    expect(model.provider).toBe('openai-chatgpt.responses')
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

describe('patchMalformedToolCallTypes', () => {
  test('fills in missing function tool-call type for streamed deltas', () => {
    const payload: Record<string, unknown> = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: '',
                function: {
                  arguments: ' Brisbane',
                },
              },
            ],
          },
        },
      ],
    }

    const changed = patchMalformedToolCallTypes(payload)

    expect(changed).toBe(true)
    expect(
      (payload.choices as Array<{ delta: { tool_calls: Array<{ type: string }> } }>)[0].delta
        .tool_calls[0].type,
    ).toBe('function')
  })

  test('leaves valid tool-call chunks unchanged', () => {
    const payload: Record<string, unknown> = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: 'function',
                function: {
                  arguments: '{}',
                },
              },
            ],
          },
        },
      ],
    }

    const changed = patchMalformedToolCallTypes(payload)

    expect(changed).toBe(false)
  })
})
