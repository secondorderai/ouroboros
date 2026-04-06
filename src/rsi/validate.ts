/**
 * Skill Test Runner
 *
 * Discovers and runs test files for generated skills.
 * Each skill can have test scripts in its `scripts/` directory.
 * Tests are executed via `bun run` and results are collected.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { type Result, ok, err } from '@src/types'

// ── Types ─────────────────────────────────────────────────────────────

/** Result of running a single test file. */
export interface SingleTestResult {
  file: string
  passed: boolean
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

/** Aggregated result of running all tests for a skill. */
export interface SkillTestResult {
  skillName: string
  passed: boolean
  results: SingleTestResult[]
  totalDurationMs: number
}

// ── Discovery ─────────────────────────────────────────────────────────

/**
 * Discover test files in a skill's `scripts/` directory.
 * Looks for files matching `test*` or `*test.ts` or `*test.sh` patterns.
 */
export function discoverTestFiles(skillDir: string): string[] {
  const scriptsDir = join(skillDir, 'scripts')

  if (!existsSync(scriptsDir)) {
    return []
  }

  let files: string[]
  try {
    files = readdirSync(scriptsDir)
  } catch {
    return []
  }

  return files
    .filter((f) => {
      const lower = f.toLowerCase()
      return (
        lower.startsWith('test') ||
        lower.endsWith('.test.ts') ||
        lower.endsWith('.test.sh') ||
        lower.endsWith('.test.js')
      )
    })
    .map((f) => join(scriptsDir, f))
}

// ── Test execution ────────────────────────────────────────────────────

/**
 * Run a single test file and capture its output.
 */
function runSingleTest(testFile: string, timeoutMs: number = 30_000): Promise<SingleTestResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    const ext = testFile.split('.').pop()?.toLowerCase()
    const cmd = ext === 'sh' ? 'sh' : 'bun'
    const args = ext === 'sh' ? [testFile] : ['run', testFile]

    const child = spawn(cmd, args, {
      cwd: join(testFile, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({
          file: testFile,
          passed: false,
          stdout,
          stderr: `Failed to spawn: ${error.message}`,
          exitCode: 1,
          durationMs: Date.now() - start,
        })
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        if (killed) {
          resolve({
            file: testFile,
            passed: false,
            stdout,
            stderr: stderr + '\n[Test timed out]',
            exitCode: 124,
            durationMs: Date.now() - start,
          })
        } else {
          resolve({
            file: testFile,
            passed: code === 0,
            stdout,
            stderr,
            exitCode: code ?? 1,
            durationMs: Date.now() - start,
          })
        }
      }
    })
  })
}

/**
 * Run all test files for a skill.
 * Tests are run sequentially to avoid resource contention.
 */
export async function runSkillTests(
  skillName: string,
  skillDir: string,
  timeoutMs: number = 30_000,
): Promise<Result<SkillTestResult>> {
  const testFiles = discoverTestFiles(skillDir)

  if (testFiles.length === 0) {
    return err(new Error(`No test files found in ${join(skillDir, 'scripts/')}`))
  }

  const start = Date.now()
  const results: SingleTestResult[] = []

  for (const testFile of testFiles) {
    const result = await runSingleTest(testFile, timeoutMs)
    results.push(result)
  }

  const allPassed = results.every((r) => r.passed)

  return ok({
    skillName,
    passed: allPassed,
    results,
    totalDurationMs: Date.now() - start,
  })
}
