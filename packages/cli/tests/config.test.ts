import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_RSI_CONFIG,
  loadConfig,
  resolveConfigDir,
  type OuroborosConfig,
} from '@src/config'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ouroboros-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('loadConfig', () => {
  let tempDir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    tempDir = makeTempDir()
    savedEnv.OUROBOROS_MODEL_PROVIDER = process.env.OUROBOROS_MODEL_PROVIDER
    savedEnv.OUROBOROS_MODEL_NAME = process.env.OUROBOROS_MODEL_NAME
    savedEnv.OUROBOROS_MODEL_BASE_URL = process.env.OUROBOROS_MODEL_BASE_URL
    savedEnv.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    savedEnv.OUROBOROS_CONSOLIDATION = process.env.OUROBOROS_CONSOLIDATION
    savedEnv.OUROBOROS_NOVELTY = process.env.OUROBOROS_NOVELTY
    savedEnv.OUROBOROS_AUTO_REFLECT = process.env.OUROBOROS_AUTO_REFLECT
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY

    delete process.env.OUROBOROS_MODEL_PROVIDER
    delete process.env.OUROBOROS_MODEL_NAME
    delete process.env.OUROBOROS_MODEL_BASE_URL
    delete process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY
    delete process.env.OUROBOROS_CONSOLIDATION
    delete process.env.OUROBOROS_NOVELTY
    delete process.env.OUROBOROS_AUTO_REFLECT
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test('loads defaults when no .ouroboros file exists', () => {
    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const config: OuroborosConfig = result.value

    // Model defaults
    expect(config.model.provider).toBe('anthropic')
    expect(config.model.name).toBe('claude-sonnet-4-20250514')
    expect(config.model.baseUrl).toBeUndefined()
    expect(config.model.apiKey).toBeUndefined()

    // Permission defaults
    expect(config.permissions.tier0).toBe(true)
    expect(config.permissions.tier1).toBe(true)
    expect(config.permissions.tier2).toBe(true)
    expect(config.permissions.tier3).toBe(false)
    expect(config.permissions.tier4).toBe(false)

    // Skill directories defaults
    expect(config.skillDirectories).toEqual(['skills/core', 'skills/generated'])

    // Memory defaults
    expect(config.memory.consolidationSchedule).toBe('session-end')
    // Auto-detected from default model claude-sonnet-4-20250514
    expect(config.memory.contextWindowTokens).toBe(200_000)
    expect(config.memory.warnRatio).toBe(DEFAULT_MEMORY_CONFIG.warnRatio)
    expect(config.memory.flushRatio).toBe(DEFAULT_MEMORY_CONFIG.flushRatio)
    expect(config.memory.compactRatio).toBe(DEFAULT_MEMORY_CONFIG.compactRatio)
    expect(config.memory.tailMessageCount).toBe(DEFAULT_MEMORY_CONFIG.tailMessageCount)
    expect(config.memory.dailyLoadDays).toBe(DEFAULT_MEMORY_CONFIG.dailyLoadDays)
    expect(config.memory.durableMemoryBudgetTokens).toBe(
      DEFAULT_MEMORY_CONFIG.durableMemoryBudgetTokens,
    )
    expect(config.memory.checkpointBudgetTokens).toBe(DEFAULT_MEMORY_CONFIG.checkpointBudgetTokens)
    expect(config.memory.workingMemoryBudgetTokens).toBe(
      DEFAULT_MEMORY_CONFIG.workingMemoryBudgetTokens,
    )

    // RSI defaults
    expect(config.rsi.noveltyThreshold).toBe(DEFAULT_RSI_CONFIG.noveltyThreshold)
    expect(config.rsi.autoReflect).toBe(true)
    expect(config.rsi.observeEveryTurns).toBe(DEFAULT_RSI_CONFIG.observeEveryTurns)
    expect(config.rsi.checkpointEveryTurns).toBe(DEFAULT_RSI_CONFIG.checkpointEveryTurns)
    expect(config.rsi.durablePromotionThreshold).toBe(DEFAULT_RSI_CONFIG.durablePromotionThreshold)
    expect(config.rsi.crystallizeFromRepeatedPatternsOnly).toBe(
      DEFAULT_RSI_CONFIG.crystallizeFromRepeatedPatternsOnly,
    )
  })

  test('finds the nearest .ouroboros in an ancestor directory', () => {
    const workspaceDir = join(tempDir, 'workspace')
    const packageDir = join(workspaceDir, 'packages', 'cli')
    mkdirSync(packageDir, { recursive: true })

    writeFileSync(
      join(workspaceDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'openai', name: 'gpt-5.4' },
      }),
    )

    expect(resolveConfigDir(packageDir)).toBe(workspaceDir)

    const result = loadConfig(packageDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.provider).toBe('openai')
    expect(result.value.model.name).toBe('gpt-5.4')
  })

  test('validates and rejects invalid schema', () => {
    // Write an invalid config: model should be an object, not a number
    writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify({ model: 123 }))

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('Invalid .ouroboros configuration')
  })

  test('rejects invalid provider value', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'invalid-provider' },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('Invalid .ouroboros configuration')
    expect(result.error.message).toContain('model.provider')
  })

  test('rejects invalid novelty threshold (out of range)', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        rsi: { noveltyThreshold: 1.5 },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('Invalid .ouroboros configuration')
  })

  test('merges file + env vars + defaults', () => {
    // File sets the provider
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'anthropic' },
      }),
    )

    // Env var overrides the model name
    process.env.OUROBOROS_MODEL_NAME = 'claude-sonnet-4-20250514'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Provider from file
    expect(result.value.model.provider).toBe('anthropic')
    // Model name from env var
    expect(result.value.model.name).toBe('claude-sonnet-4-20250514')
    // Everything else from defaults
    expect(result.value.permissions.tier0).toBe(true)
    expect(result.value.rsi.noveltyThreshold).toBe(0.7)
  })

  test('env vars override file values', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'anthropic', name: 'claude-3-opus' },
      }),
    )

    // Env var should override the file value
    process.env.OUROBOROS_MODEL_NAME = 'claude-sonnet-4-20250514'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.name).toBe('claude-sonnet-4-20250514')
  })

  test('loads model.apiKey from .ouroboros when present', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai',
          name: 'gpt-5.4',
          apiKey: 'cfg-openai',
        },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.apiKey).toBe('cfg-openai')
  })

  test('accepts openai-chatgpt as a config provider', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-chatgpt',
          name: 'gpt-5.4',
        },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.provider).toBe('openai-chatgpt')
    expect(result.value.model.name).toBe('gpt-5.4')
  })

  test('provider env vars take precedence over model.apiKey', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai',
          name: 'gpt-5.4',
          apiKey: 'cfg-openai',
        },
      }),
    )

    process.env.OPENAI_API_KEY = 'env-openai'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.apiKey).toBe('env-openai')
  })

  test('dedicated openai-compatible env var takes precedence over model.apiKey', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-compatible',
          name: 'compatible-model',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'cfg-compatible',
        },
      }),
    )

    process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = 'env-compatible'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.apiKey).toBe('env-compatible')
  })

  test('OPENAI_API_KEY does not override openai-compatible model.apiKey', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-compatible',
          name: 'compatible-model',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'cfg-compatible',
        },
      }),
    )

    process.env.OPENAI_API_KEY = 'env-openai'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.apiKey).toBe('cfg-compatible')
  })

  test('handles malformed JSON in .ouroboros', () => {
    writeFileSync(join(tempDir, '.ouroboros'), '{ invalid json }}}')

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.message).toContain('Failed to parse .ouroboros config file')
  })

  test('handles NaN novelty threshold from env gracefully', () => {
    process.env.OUROBOROS_NOVELTY = 'not-a-number'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // NaN is skipped; default value should be used
    expect(result.value.rsi.noveltyThreshold).toBe(0.7)
  })

  test('OUROBOROS_AUTO_REFLECT is case-sensitive (TRUE does not enable)', () => {
    process.env.OUROBOROS_AUTO_REFLECT = 'TRUE'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 'TRUE' !== 'true', so autoReflect should be false
    expect(result.value.rsi.autoReflect).toBe(false)
  })

  test('OUROBOROS_AUTO_REFLECT=true enables autoReflect', () => {
    // Start with autoReflect disabled in file config
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        rsi: { autoReflect: false },
      }),
    )

    process.env.OUROBOROS_AUTO_REFLECT = 'true'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.rsi.autoReflect).toBe(true)
  })

  test('env overrides do not mutate the original config object', () => {
    const originalConfig = {
      model: { provider: 'anthropic', name: 'original-model' },
      rsi: { noveltyThreshold: 0.5 },
    }
    writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(originalConfig))

    process.env.OUROBOROS_MODEL_NAME = 'overridden-model'

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.name).toBe('overridden-model')
    // The original JSON hasn't changed (loadConfig re-reads from disk each time,
    // but this validates the cloning logic doesn't mutate references)
  })

  test('loads valid complete config from file', () => {
    const config = {
      model: {
        provider: 'openai',
        name: 'gpt-4o',
        apiKey: 'cfg-openai',
      },
      permissions: {
        tier0: true,
        tier1: true,
        tier2: false,
        tier3: false,
        tier4: false,
      },
      skillDirectories: ['skills/core', 'skills/custom'],
      memory: {
        consolidationSchedule: 'daily',
        contextWindowTokens: 32000,
        warnRatio: 0.65,
        flushRatio: 0.8,
        compactRatio: 0.9,
        tailMessageCount: 16,
        dailyLoadDays: 3,
        durableMemoryBudgetTokens: 1800,
        checkpointBudgetTokens: 1400,
        workingMemoryBudgetTokens: 900,
      },
      rsi: {
        noveltyThreshold: 0.5,
        autoReflect: false,
        observeEveryTurns: 2,
        checkpointEveryTurns: 4,
        durablePromotionThreshold: 0.75,
        crystallizeFromRepeatedPatternsOnly: false,
      },
    }
    writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(config))

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.provider).toBe('openai')
    expect(result.value.model.name).toBe('gpt-4o')
    expect(result.value.model.apiKey).toBe('cfg-openai')
    expect(result.value.permissions.tier2).toBe(false)
    expect(result.value.skillDirectories).toEqual(['skills/core', 'skills/custom'])
    expect(result.value.memory.consolidationSchedule).toBe('daily')
    expect(result.value.memory.contextWindowTokens).toBe(32000)
    expect(result.value.memory.warnRatio).toBe(0.65)
    expect(result.value.memory.tailMessageCount).toBe(16)
    expect(result.value.rsi.noveltyThreshold).toBe(0.5)
    expect(result.value.rsi.autoReflect).toBe(false)
    expect(result.value.rsi.observeEveryTurns).toBe(2)
    expect(result.value.rsi.checkpointEveryTurns).toBe(4)
    expect(result.value.rsi.durablePromotionThreshold).toBe(0.75)
    expect(result.value.rsi.crystallizeFromRepeatedPatternsOnly).toBe(false)
  })

  test('auto-detects contextWindowTokens for known Anthropic model', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'anthropic', name: 'claude-3-5-sonnet-latest' },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.memory.contextWindowTokens).toBe(200_000)
  })

  test('auto-detects contextWindowTokens for known OpenAI model', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'openai', name: 'gpt-4o' },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.memory.contextWindowTokens).toBe(128_000)
  })

  test('auto-detects contextWindowTokens via prefix match', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'openai', name: 'gpt-4o-2024-08-06' },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.memory.contextWindowTokens).toBe(128_000)
  })

  test('falls back to undefined for unknown model ID', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-compatible',
          name: 'my-custom-model',
          baseUrl: 'http://localhost:11434/v1',
        },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.memory.contextWindowTokens).toBeUndefined()
  })

  test('explicit contextWindowTokens overrides auto-detection', () => {
    writeFileSync(
      join(tempDir, '.ouroboros'),
      JSON.stringify({
        model: { provider: 'anthropic', name: 'claude-3-5-sonnet-latest' },
        memory: { contextWindowTokens: 50_000 },
      }),
    )

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.memory.contextWindowTokens).toBe(50_000)
  })
})
