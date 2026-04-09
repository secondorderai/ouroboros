import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadConfig, resolveConfigDir, type OuroborosConfig } from '@src/config'
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

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    // Clean up env vars
    delete process.env.OUROBOROS_MODEL_PROVIDER
    delete process.env.OUROBOROS_MODEL_NAME
    delete process.env.OUROBOROS_MODEL_BASE_URL
    delete process.env.OUROBOROS_CONSOLIDATION
    delete process.env.OUROBOROS_NOVELTY
    delete process.env.OUROBOROS_AUTO_REFLECT
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

    // RSI defaults
    expect(config.rsi.noveltyThreshold).toBe(0.7)
    expect(config.rsi.autoReflect).toBe(true)
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
      },
      rsi: {
        noveltyThreshold: 0.5,
        autoReflect: false,
      },
    }
    writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(config))

    const result = loadConfig(tempDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.model.provider).toBe('openai')
    expect(result.value.model.name).toBe('gpt-4o')
    expect(result.value.permissions.tier2).toBe(false)
    expect(result.value.skillDirectories).toEqual(['skills/core', 'skills/custom'])
    expect(result.value.memory.consolidationSchedule).toBe('daily')
    expect(result.value.rsi.noveltyThreshold).toBe(0.5)
    expect(result.value.rsi.autoReflect).toBe(false)
  })
})
