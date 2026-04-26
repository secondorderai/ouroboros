/**
 * Dist CLI Subprocess Tests
 *
 * Spawns the compiled ./dist/ouroboros binary and verifies that every
 * CLI flag is correctly routed past Commander.js into application logic.
 *
 * Core invariant: stdout/stderr must NOT contain "Usage:" unless --help
 * was explicitly passed.  This catches Commander.js parsing regressions
 * (auto-help when subcommands exist, argv prefix mis-detection, etc.).
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { join } from 'path'

const BINARY = join(import.meta.dir, '..', 'dist', 'ouroboros')
const TIMEOUT_MS = 10_000

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
  const proc = Bun.spawn(
    ['bun', 'build', '--compile', '--minify', './src/cli.ts', '--outfile', 'dist/ouroboros'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Build failed (exit ${exitCode}): ${stderr}`)
  }
})

// ── Helpers ──────────────────────────────────────────────────────────

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
  killed: boolean
}

/**
 * Spawn the compiled binary with the given args and optional stdin.
 * If `stdinData` is provided, it is written to stdin then stdin is closed.
 * If `leaveStdinOpen` is true, stdin stays open and the process is killed
 * after `killAfterMs`.
 */
async function spawnBinary(
  args: string[],
  opts?: { stdinData?: string; leaveStdinOpen?: boolean; killAfterMs?: number },
): Promise<SpawnResult> {
  const proc = Bun.spawn([BINARY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })

  if (opts?.stdinData !== undefined) {
    proc.stdin.write(opts.stdinData)
    proc.stdin.end()
  } else if (!opts?.leaveStdinOpen) {
    proc.stdin.end()
  }

  let killed = false

  const killDelay = opts?.leaveStdinOpen ? (opts.killAfterMs ?? 2000) : TIMEOUT_MS
  const timer = setTimeout(() => {
    killed = true
    proc.kill()
  }, killDelay)

  const exitCode = await proc.exited
  clearTimeout(timer)

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  return { stdout, stderr, exitCode, killed }
}

function assertNoUsageText(result: SpawnResult): void {
  const combined = result.stdout + result.stderr
  expect(combined).not.toContain('Usage:')
}

// ── Tests ────────────────────────────────────────────────────────────

describe('dist/ouroboros binary', () => {
  test('--help shows usage', async () => {
    const result = await spawnBinary(['--help'])
    expect(result.stdout).toContain('Usage:')
    expect(result.exitCode).toBe(0)
  })

  test('--version shows version', async () => {
    const result = await spawnBinary(['--version'])
    expect(result.stdout).toContain('0.1.0')
    expect(result.exitCode).toBe(0)
  })

  test('--debug-tools lists tools', async () => {
    const result = await spawnBinary(['--debug-tools'])
    expect(result.stdout).toContain('tools registered')
    assertNoUsageText(result)
    expect(result.exitCode).toBe(0)
  })

  test('dream --help shows subcommand help', async () => {
    const result = await spawnBinary(['dream', '--help'])
    expect(result.stdout).toContain('dream')
    expect(result.stdout).toContain('consolidate')
    expect(result.exitCode).toBe(0)
  })

  test('-m flag accepted', async () => {
    const result = await spawnBinary(['-m', 'hello'])
    assertNoUsageText(result)
  })

  test('--message flag accepted', async () => {
    const result = await spawnBinary(['--message', 'hello'])
    assertNoUsageText(result)
  })

  test('piped stdin accepted', async () => {
    const result = await spawnBinary([], { stdinData: 'hello' })
    assertNoUsageText(result)
  })

  test('no args, no stdin (REPL path) does not show help', async () => {
    const result = await spawnBinary([], { leaveStdinOpen: true, killAfterMs: 2000 })
    assertNoUsageText(result)
    expect(result.killed).toBe(true)
  })

  test('--model flag accepted', async () => {
    const result = await spawnBinary([
      '--model',
      'anthropic/claude-sonnet-4-20250514',
      '-m',
      'hello',
    ])
    assertNoUsageText(result)
  })

  test('combined flags accepted', async () => {
    const result = await spawnBinary(['-v', '--no-stream', '--no-rsi', '--debug-tools'])
    expect(result.stdout).toContain('tools registered')
    assertNoUsageText(result)
    expect(result.exitCode).toBe(0)
  })

  test('--reasoning-effort flag accepts valid values without complaint', async () => {
    // Drop into REPL and kill after a beat — by then Commander and our own
    // validators have either rejected the flag (visible in stderr) or accepted it.
    const result = await spawnBinary(['--reasoning-effort', 'medium'], {
      leaveStdinOpen: true,
      killAfterMs: 2000,
    })
    assertNoUsageText(result)
    expect(result.stderr).not.toContain('Invalid --reasoning-effort')
    expect(result.stderr).not.toContain('unknown option')
  })

  test('--reasoning-effort flag rejects unknown values with non-zero exit', async () => {
    const result = await spawnBinary(['--reasoning-effort', 'bogus', '-m', 'hello'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Invalid --reasoning-effort')
    // Error message should list the full enum including the new "max" level.
    expect(result.stderr).toContain('minimal')
    expect(result.stderr).toContain('max')
  })

  test('--reasoning-effort accepts the new "max" level', async () => {
    const result = await spawnBinary(['--reasoning-effort', 'max'], {
      leaveStdinOpen: true,
      killAfterMs: 2000,
    })
    assertNoUsageText(result)
    expect(result.stderr).not.toContain('Invalid --reasoning-effort')
    expect(result.stderr).not.toContain('unknown option')
  })

  test('--thinking-budget-tokens flag is no longer recognised (removed)', async () => {
    const result = await spawnBinary(['--thinking-budget-tokens', '4096', '-m', 'hello'])
    // Commander rejects unknown options with a non-zero exit and an
    // "unknown option" message — confirms the flag is fully removed.
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('unknown option')
  })
})
