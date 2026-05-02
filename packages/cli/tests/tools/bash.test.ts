import { afterEach, beforeEach, describe, test, expect } from 'bun:test'
import { classifyBashCommand, execute, resolveTier, schema } from '@src/tools/bash'

const ENV_KEYS_UNDER_TEST = [
  'ANTHROPIC_API_KEY',
  'OUROBOROS_OPENAI_COMPATIBLE_API_KEY',
  'OUROBOROS_FUTURE_SERVICE_TOKEN',
  'OUROBOROS_SAFE_CONFIG',
] as const

const savedEnv: Partial<Record<(typeof ENV_KEYS_UNDER_TEST)[number], string>> = {}

describe('BashTool', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS_UNDER_TEST) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS_UNDER_TEST) {
      const value = savedEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: BashTool runs command
  // -----------------------------------------------------------------------
  test('runs a simple echo command', async () => {
    const args = schema.parse({ command: 'echo hello' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stdout).toBe('hello\n')
      expect(result.value.stderr).toBe('')
      expect(result.value.exitCode).toBe(0)
    }
  })

  test('captures stderr', async () => {
    const args = schema.parse({ command: 'echo error >&2' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stderr).toBe('error\n')
      expect(result.value.exitCode).toBe(0)
    }
  })

  test('returns non-zero exit code for failing commands', async () => {
    const args = schema.parse({ command: 'exit 42' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.exitCode).toBe(42)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: BashTool enforces timeout
  // -----------------------------------------------------------------------
  test('kills process that exceeds timeout', async () => {
    const args = schema.parse({ command: 'sleep 60', timeout: 1 })
    const start = Date.now()
    const result = await execute(args)
    const elapsed = Date.now() - start

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('timed out')
    }
    // Should have taken roughly 1 second, not 60.
    expect(elapsed).toBeLessThan(5000)
  })

  test('respects cwd parameter', async () => {
    const args = schema.parse({ command: 'pwd', cwd: '/tmp' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      // /tmp may resolve to /private/tmp on macOS
      expect(result.value.stdout.trim()).toMatch(/\/?tmp$/)
    }
  })

  test('default timeout is 30 seconds', () => {
    const args = schema.parse({ command: 'echo hi' })
    expect(args.timeout).toBe(30)
  })

  test('classifies pure inspection commands as Tier 0', () => {
    expect(resolveTier({ command: 'ls -la /Users/henry/workspace/ouroboros/skills/' })).toBe(0)
    expect(classifyBashCommand('pwd && rg -n "permission" packages/cli/src')).toBe(0)
    expect(classifyBashCommand('git status --short')).toBe(0)
    expect(classifyBashCommand('git diff -- packages/cli/src/tools/bash.ts')).toBe(0)
  })

  test('classifies mutating or general execution commands above Tier 0', () => {
    expect(classifyBashCommand('echo hello > output.txt')).toBe(1)
    expect(classifyBashCommand('sed -i s/old/new/g file.txt')).toBe(1)
    expect(classifyBashCommand('bun test packages/cli/tests/tools/bash.test.ts')).toBe(1)
    expect(classifyBashCommand('echo $(rm -rf tmp)')).toBe(1)
  })

  test('classifies system-level shell commands as Tier 4', () => {
    expect(classifyBashCommand('sudo rm -rf /tmp/example')).toBe(4)
    expect(classifyBashCommand('brew install ripgrep')).toBe(4)
    expect(classifyBashCommand('bun install')).toBe(4)
  })

  test('strips known and future secret-like env vars from the child', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
    process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = 'compatible-secret'
    process.env.OUROBOROS_FUTURE_SERVICE_TOKEN = 'future-secret'
    process.env.OUROBOROS_SAFE_CONFIG = 'safe-value'

    const args = schema.parse({
      command: [
        'printf "%s\\n"',
        '"${ANTHROPIC_API_KEY:-undefined}"',
        '"${OUROBOROS_OPENAI_COMPATIBLE_API_KEY:-undefined}"',
        '"${OUROBOROS_FUTURE_SERVICE_TOKEN:-undefined}"',
        '"${OUROBOROS_SAFE_CONFIG:-undefined}"',
      ].join(' '),
    })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stdout).toBe('undefined\nundefined\nundefined\nsafe-value\n')
    }
  })
})
