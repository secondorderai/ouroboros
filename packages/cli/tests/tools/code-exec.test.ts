import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { schema, execute, resolveTier, shellQuoteCommand } from '@src/tools/code-exec'
import { schema as bashSchema, execute as bashExecute } from '@src/tools/bash'
import { initializeSandbox, resetSandbox, setSandboxBackendForTesting } from '@src/safety/sandbox'
import { configSchema } from '@src/config'
import { makeFakeBackend } from '../safety/fake-sandbox-backend'
import type { AgentEvent } from '@src/agent'
import type { ToolExecutionContext } from '@src/tools/types'

function makeEventCapture(): { context: ToolExecutionContext; emitted: AgentEvent[] } {
  const emitted: AgentEvent[] = []
  const context = {
    emitEvent: (event: AgentEvent) => {
      emitted.push(event)
    },
  } as unknown as ToolExecutionContext
  return { context, emitted }
}

const RUN_NETWORK = process.env.SKIP_NETWORK_TESTS !== '1'

function tempEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('ouroboros-code-exec-'))
}

describe('CodeExecTool — schema', () => {
  test('rejects empty code', () => {
    expect(() => schema.parse({ code: '' })).toThrow()
  })

  test('parses defaults for timeout and maxOutputBytes', () => {
    const args = schema.parse({ code: 'console.log(1)' })
    expect(args.timeout).toBe(30)
    expect(args.maxOutputBytes).toBe(1_048_576)
    expect(args.packages).toBeUndefined()
  })

  test('rejects timeout above 300s', () => {
    expect(() => schema.parse({ code: 'x', timeout: 301 })).toThrow()
  })
})

describe('CodeExecTool — resolveTier', () => {
  test('defaults to Tier 1', () => {
    expect(resolveTier({ code: 'console.log(1)' })).toBe(1)
    expect(resolveTier({ code: 'console.log(1)', bypassSandbox: false })).toBe(1)
    expect(resolveTier(undefined)).toBe(1)
  })

  test('bypassSandbox: true escalates to Tier 4', () => {
    expect(resolveTier({ code: 'console.log(1)', bypassSandbox: true })).toBe(4)
  })
})

describe('CodeExecTool — shellQuoteCommand', () => {
  test('passes plain argv through unquoted', () => {
    expect(shellQuoteCommand(['bun', 'run', '/tmp/x/main.ts'])).toBe('bun run /tmp/x/main.ts')
  })

  test('quotes arguments containing shell metacharacters', () => {
    expect(shellQuoteCommand(['bun', 'add', 'left pad; rm -rf /'])).toBe(
      "bun add 'left pad; rm -rf /'",
    )
    expect(shellQuoteCommand(['echo', "it's"])).toBe("echo 'it'\\''s'")
  })
})

describe('CodeExecTool — OS sandbox integration (fake backend)', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ouroboros-code-exec-sandbox-'))
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

  test('routes the run spawn through wrapCommand when enforcing', async () => {
    // Identity wrap: the quoted command must execute correctly via `sh -c`,
    // which also validates shellQuoteCommand end to end.
    const backend = makeFakeBackend()
    await initWithFakeBackend(backend)

    const result = await execute(schema.parse({ code: 'console.log("sandbox-route")' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toBe('sandbox-route\n')

    expect(backend.wrappedCommands).toHaveLength(1)
    expect(backend.wrappedCommands[0]).toStartWith('bun run ')
    expect(backend.wrappedCommands[0]).toContain('main.ts')
  })

  test('appends the [sandbox] marker to denial-shaped sandboxed failures', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({
        command: 'sh',
        args: [
          '-c',
          'printf \'%s\\n%s\\n%s\\n\' "<sandbox_violations>" "bun(1) deny(1) file-write-create /denied/x" "</sandbox_violations>" >&2; exit 1',
        ],
      }),
    })
    await initWithFakeBackend(backend)

    const result = await execute(schema.parse({ code: 'console.log("never")' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(1)
    expect(result.value.stderr).toContain('[sandbox]')
    expect(result.value.stderr).toContain('bypassSandbox: true')
  })

  test('emits a sandbox-violation event through the execution context on denial', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({
        command: 'sh',
        args: [
          '-c',
          'printf \'%s\\n%s\\n%s\\n\' "<sandbox_violations>" "bun(1) deny(1) file-write-create /denied/x" "</sandbox_violations>" >&2; exit 1',
        ],
      }),
    })
    await initWithFakeBackend(backend)

    const { context, emitted } = makeEventCapture()
    const result = await execute(schema.parse({ code: 'console.log("never")' }), context)

    expect(result.ok).toBe(true)
    const violations = emitted.filter((event) => event.type === 'sandbox-violation')
    expect(violations).toHaveLength(1)
    const event = violations[0]!
    if (event.type !== 'sandbox-violation') return
    expect(event.toolName).toBe('code-exec')
    expect(event.commandSummary).toStartWith('bun run ')
    expect(event.commandSummary).not.toContain(' API_KEY')
    expect(event.indicator).toContain('file-write')
    expect(event.platform).toBe(process.platform)
  })

  test('does not emit a sandbox-violation event for ordinary sandboxed failures', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo "plain failure" >&2; exit 3'] }),
    })
    await initWithFakeBackend(backend)

    const { context, emitted } = makeEventCapture()
    const result = await execute(schema.parse({ code: 'console.log("never")' }), context)

    expect(result.ok).toBe(true)
    expect(emitted.filter((event) => event.type === 'sandbox-violation')).toHaveLength(0)
  })

  test('emits sandbox-unavailable exactly once when falling back unsandboxed', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['bwrap missing'] }))
    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workDir,
      cwd: workDir,
    })
    expect(status.mode).toBe('unavailable')

    const { context, emitted } = makeEventCapture()
    await execute(schema.parse({ code: 'console.log("one")' }), context)
    await execute(schema.parse({ code: 'console.log("two")' }), context)

    const events = emitted.filter((event) => event.type === 'sandbox-unavailable')
    expect(events).toHaveLength(1)
    const event = events[0]!
    if (event.type !== 'sandbox-unavailable') return
    expect(event.reason).toContain('bwrap missing')
    expect(event.platform).toBe(process.platform)
  })

  test('warn-once fallback note appears in stderr when the sandbox is unavailable', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['bwrap missing'] }))
    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workDir,
      cwd: workDir,
    })
    expect(status.mode).toBe('unavailable')

    const first = await execute(schema.parse({ code: 'console.log("one")' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.exitCode).toBe(0)
    expect(first.value.stderr).toContain('[sandbox] OS sandbox unavailable')
    expect(first.value.stderr).toContain('bwrap missing')

    const second = await execute(schema.parse({ code: 'console.log("two")' }))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.stderr).not.toContain('[sandbox]')
  })

  test('code-exec fallback consuming the warn-once token still surfaces the note (cross-tool)', async () => {
    // Regression: code-exec once consumed the process-wide warn-once token
    // (to gate the sandbox-unavailable event) WITHOUT appending the note to
    // its own stderr — silently suppressing bash's model-facing
    // "[sandbox] OS sandbox unavailable" note for the rest of the session.
    // The warning must surface in tool output exactly once, in whichever
    // tool falls back first.
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['bwrap missing'] }))
    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workDir,
      cwd: workDir,
    })
    expect(status.mode).toBe('unavailable')

    const codeExecResult = await execute(schema.parse({ code: 'console.log("first")' }))
    expect(codeExecResult.ok).toBe(true)
    if (!codeExecResult.ok) return
    expect(codeExecResult.value.stderr).toContain('[sandbox] OS sandbox unavailable')
    expect(codeExecResult.value.stderr).toContain('bwrap missing')

    // Token already consumed AND surfaced by code-exec — bash must not
    // repeat the note (warn once per session).
    const bashResult = await bashExecute(bashSchema.parse({ command: 'echo cross-tool' }))
    expect(bashResult.ok).toBe(true)
    if (!bashResult.ok) return
    expect(bashResult.value.stdout).toBe('cross-tool\n')
    expect(bashResult.value.stderr).not.toContain('[sandbox]')
  })

  test('notifies the backend after the sandboxed run completes', async () => {
    // srt's per-command cleanup contract: the sandboxed `bun run` child exit
    // must trigger completeCommand() on the backend.
    const backend = makeFakeBackend()
    await initWithFakeBackend(backend)

    const result = await execute(schema.parse({ code: 'console.log("done")' }))
    expect(result.ok).toBe(true)
    expect(backend.completedCommands).toBe(1)
  })

  test('bypassSandbox: true skips wrapping for both spawns', async () => {
    const backend = makeFakeBackend({
      wrap: () => ({ command: 'sh', args: ['-c', 'echo should-not-run; exit 9'] }),
    })
    await initWithFakeBackend(backend)

    const result = await execute(
      schema.parse({ code: 'console.log("direct")', bypassSandbox: true }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toBe('direct\n')
    expect(backend.wrappedCommands).toEqual([])
    expect(backend.completedCommands).toBe(0)
  })
})

describe('CodeExecTool — execute', () => {
  test('runs a simple snippet and returns stdout/exitCode 0', async () => {
    const args = schema.parse({ code: 'console.log("hello")' })
    const result = await execute(args)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stdout).toBe('hello\n')
      expect(result.value.exitCode).toBe(0)
      expect(result.value.durationMs).toBeGreaterThan(0)
      expect(result.value.truncated).toBeUndefined()
      expect(result.value.installedPackages).toBeUndefined()
    }
  })

  test('captures stderr and non-zero exit code', async () => {
    const args = schema.parse({
      code: 'console.error("boom"); process.exit(2)',
    })
    const result = await execute(args)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stderr).toContain('boom')
      expect(result.value.exitCode).toBe(2)
    }
  })

  test('returns err on timeout', async () => {
    const args = schema.parse({
      code: 'while(true){}',
      timeout: 1,
    })
    const result = await execute(args)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('timed out')
    }
  })

  test('reports a TypeScript syntax error via stderr (exitCode != 0)', async () => {
    const args = schema.parse({ code: 'const x: =' })
    const result = await execute(args)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.exitCode).not.toBe(0)
      expect(result.value.stderr.length).toBeGreaterThan(0)
    }
  })

  test('truncates oversized stdout and sets truncated=true', async () => {
    const args = schema.parse({
      code: 'for (let i = 0; i < 200_000; i++) console.log("x".repeat(100))',
      maxOutputBytes: 4096,
    })
    const result = await execute(args)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.truncated).toBe(true)
      // Cap is 4096 + the truncation marker line.
      expect(result.value.stdout.length).toBeLessThan(4096 + 200)
      expect(result.value.stdout).toContain('[output truncated at 4096 bytes]')
    }
  })

  describe('with environment isolation', () => {
    const ENV_KEYS_UNDER_TEST = [
      'ANTHROPIC_API_KEY',
      'OUROBOROS_OPENAI_COMPATIBLE_API_KEY',
      'OUROBOROS_FUTURE_SERVICE_TOKEN',
      'OUROBOROS_SAFE_CONFIG',
    ] as const
    const originalEnv: Partial<Record<(typeof ENV_KEYS_UNDER_TEST)[number], string>> = {}

    beforeEach(() => {
      for (const key of ENV_KEYS_UNDER_TEST) {
        originalEnv[key] = process.env[key]
        delete process.env[key]
      }
      process.env.ANTHROPIC_API_KEY = 'test-secret-value'
    })

    afterEach(() => {
      for (const key of ENV_KEYS_UNDER_TEST) {
        const value = originalEnv[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    })

    test('strips sensitive env vars from the child', async () => {
      const args = schema.parse({
        code: 'console.log(process.env.ANTHROPIC_API_KEY ?? "undefined")',
      })
      const result = await execute(args)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.stdout).toBe('undefined\n')
      }
    })

    test('strips the OpenAI-compatible key and future secret-like env vars from the child', async () => {
      process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY = 'compatible-secret'
      process.env.OUROBOROS_FUTURE_SERVICE_TOKEN = 'future-secret'
      process.env.OUROBOROS_SAFE_CONFIG = 'safe-value'

      const args = schema.parse({
        code: [
          'console.log(process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY ?? "undefined")',
          'console.log(process.env.OUROBOROS_FUTURE_SERVICE_TOKEN ?? "undefined")',
          'console.log(process.env.OUROBOROS_SAFE_CONFIG ?? "undefined")',
        ].join('\n'),
      })
      const result = await execute(args)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.stdout).toBe('undefined\nundefined\nsafe-value\n')
      }
    })
  })

  test('cleans up the temp directory after success', async () => {
    const before = new Set(tempEntries())
    const args = schema.parse({ code: 'console.log("ok")' })
    const result = await execute(args)
    expect(result.ok).toBe(true)
    const after = new Set(tempEntries())
    // No leaked dirs from this run.
    for (const name of after) {
      expect(before.has(name)).toBe(true)
    }
  })

  test('cleans up the temp directory after timeout', async () => {
    const before = new Set(tempEntries())
    const args = schema.parse({ code: 'while(true){}', timeout: 1 })
    const result = await execute(args)
    expect(result.ok).toBe(false)
    const after = new Set(tempEntries())
    for (const name of after) {
      expect(before.has(name)).toBe(true)
    }
  })
})

describe('CodeExecTool — packages (network-dependent)', () => {
  test.skipIf(!RUN_NETWORK)(
    'installs and uses an npm package',
    async () => {
      const args = schema.parse({
        code: `import isOdd from 'is-odd'; console.log(isOdd(3))`,
        packages: ['is-odd'],
        timeout: 60,
      })
      const result = await execute(args)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.exitCode).toBe(0)
        expect(result.value.stdout.trim()).toBe('true')
        expect(result.value.installedPackages).toEqual(['is-odd'])
      }
    },
    90_000,
  )

  test.skipIf(!RUN_NETWORK)(
    'returns failure result when bun install fails',
    async () => {
      const args = schema.parse({
        code: 'console.log("never reached")',
        packages: ['this-package-definitely-does-not-exist-xyz123-abc456'],
        timeout: 60,
      })
      const result = await execute(args)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.exitCode).not.toBe(0)
        expect(result.value.stderr).toContain('install')
        expect(result.value.installedPackages).toEqual([
          'this-package-definitely-does-not-exist-xyz123-abc456',
        ])
      }
    },
    90_000,
  )
})
