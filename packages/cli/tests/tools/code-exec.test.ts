import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { schema, execute } from '@src/tools/code-exec'

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
