import { afterEach, beforeEach, describe, test, expect } from 'bun:test'
import { classifyBashCommand, execute, resolveTier, schema } from '@src/tools/bash'
import { initializeSandbox, resetSandbox, setSandboxBackendForTesting } from '@src/safety/sandbox'
import { configSchema } from '@src/config'
import { makeFakeBackend } from '../safety/fake-sandbox-backend'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  test('bypassSandbox: true escalates to Tier 4 regardless of the command', () => {
    expect(resolveTier({ command: 'echo hi', bypassSandbox: true })).toBe(4)
    expect(resolveTier({ command: 'ls', bypassSandbox: true })).toBe(4)
    // Absent or false keeps the command classification.
    expect(resolveTier({ command: 'echo hi' })).toBe(0)
    expect(resolveTier({ command: 'echo hi', bypassSandbox: false })).toBe(0)
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

describe('BashTool — OS sandbox integration (fake backend)', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ouroboros-bash-sandbox-'))
  })

  afterEach(async () => {
    setSandboxBackendForTesting(null)
    await resetSandbox()
    rmSync(workDir, { recursive: true, force: true })
  })

  async function initWithFakeBackend(backend: ReturnType<typeof makeFakeBackend>) {
    setSandboxBackendForTesting(backend)
    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workDir,
      cwd: workDir,
    })
    expect(status.mode).toBe('enforcing')
  }

  test('appends the [sandbox] marker to denial-shaped sandboxed failures', async () => {
    // The fake wrap simulates a kernel denial; the fake annotate appends the
    // platform-independent seatbelt corroboration block the classifier reads.
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo "denied" >&2; exit 1'] }),
      annotate: (_command, stderr) =>
        `${stderr}\n<sandbox_violations>\ntouch(1) deny(1) file-write-create /denied/x\n</sandbox_violations>`,
    })
    await initWithFakeBackend(backend)

    const args = schema.parse({ command: 'touch /denied/x' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(1)
    expect(result.value.stderr).toContain('[sandbox]')
    expect(result.value.stderr).toContain('blocked by the OS sandbox')
    expect(result.value.stderr).toContain('bypassSandbox: true')
    expect(backend.wrappedCommands).toEqual(['touch /denied/x'])
  })

  test('does not append the marker for ordinary sandboxed failures', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo "plain failure" >&2; exit 3'] }),
    })
    await initWithFakeBackend(backend)

    const result = await execute(schema.parse({ command: 'exit 3' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(3)
    expect(result.value.stderr).not.toContain('[sandbox]')
  })

  test('bypassSandbox: true skips wrapping entirely', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo should-not-run; exit 9'] }),
    })
    await initWithFakeBackend(backend)

    const result = await execute(schema.parse({ command: 'echo unwrapped', bypassSandbox: true }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.stdout).toBe('unwrapped\n')
    expect(result.value.exitCode).toBe(0)
    expect(backend.wrappedCommands).toEqual([])
  })

  test('tier-4 commands run unwrapped (human already approved at execute time)', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo should-not-run; exit 9'] }),
    })
    await initWithFakeBackend(backend)

    // `sudo` makes this tier 4; `-n true || true` keeps it harmless and exit 0.
    const result = await execute(schema.parse({ command: 'sudo -n true || true' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(0)
    expect(backend.wrappedCommands).toEqual([])
  })

  test('notifies the backend after each sandboxed command completes', async () => {
    // srt's per-command cleanup contract: every sandboxed child exit must
    // trigger exactly one completeCommand() on the backend.
    const backend = makeFakeBackend()
    await initWithFakeBackend(backend)

    const first = await execute(schema.parse({ command: 'echo cleanup' }))
    expect(first.ok).toBe(true)
    expect(backend.completedCommands).toBe(1)

    const second = await execute(schema.parse({ command: 'exit 3' }))
    expect(second.ok).toBe(true)
    expect(backend.completedCommands).toBe(2)

    // Unsandboxed runs (bypass) must NOT notify.
    const bypassed = await execute(schema.parse({ command: 'echo unwrapped', bypassSandbox: true }))
    expect(bypassed.ok).toBe(true)
    expect(backend.completedCommands).toBe(2)
  })

  test('warn-once fallback note appears in stderr when the sandbox is unavailable', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['ripgrep missing'] }))
    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workDir,
      cwd: workDir,
    })
    expect(status.mode).toBe('unavailable')

    const first = await execute(schema.parse({ command: 'echo one' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.stderr).toContain('[sandbox] OS sandbox unavailable')
    expect(first.value.stderr).toContain('ripgrep missing')

    const second = await execute(schema.parse({ command: 'echo two' }))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.stderr).not.toContain('[sandbox]')
  })
})
