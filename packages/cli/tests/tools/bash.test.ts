import { describe, test, expect } from 'bun:test'
import { execute, schema } from '@src/tools/bash'

describe('BashTool', () => {
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
})
