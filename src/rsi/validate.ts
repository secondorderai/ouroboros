/**
 * RSI Validate — Skill Test Runner
 *
 * Executes test scripts found in a skill's `scripts/` directory and reports
 * pass/fail results. This is the quality gate that prevents broken or
 * hallucinated skills from entering the agent's active skill catalog.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { type Result, ok, err } from '@src/types'

// ── Types ─────────────────────────────────────────────────────────────

export interface SkillTestFileResult {
  file: string
  status: 'pass' | 'fail' | 'error'
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface SkillTestResult {
  skillName: string
  skillPath: string
  overall: 'pass' | 'fail'
  testFiles: SkillTestFileResult[]
}

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum bytes to capture from stdout/stderr per test file. */
const MAX_OUTPUT_BYTES = 10 * 1024

/** Default timeout for each test file in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Supported test file patterns — exact names and glob-like suffixes. */
const EXACT_TEST_NAMES = new Set(['test.ts', 'test.py', 'test.sh'])
const TEST_SUFFIXES = ['.test.ts', '.test.py', '.test.sh']

// ── Runner mapping ────────────────────────────────────────────────────

interface RunnerSpec {
  command: string
  args: (file: string) => string[]
}

function getRunner(file: string): RunnerSpec | undefined {
  const ext = extname(file)
  switch (ext) {
    case '.ts':
      // bun test requires a `./` prefix to treat the argument as a file path
      // rather than a test name filter. The path is relative to cwd (skill dir).
      return { command: 'bun', args: (f) => ['test', `./${f}`] }
    case '.py':
      return { command: 'python3', args: (f) => [f] }
    case '.sh':
      return { command: 'bash', args: (f) => [f] }
    default:
      return undefined
  }
}

// ── Discovery ─────────────────────────────────────────────────────────

/**
 * Discover test files in a skill's `scripts/` directory.
 *
 * Supported patterns:
 * - Exact names: `test.ts`, `test.py`, `test.sh`
 * - Suffix patterns: `*.test.ts`, `*.test.py`, `*.test.sh`
 */
export async function discoverTestFiles(scriptsDir: string): Promise<string[]> {
  if (!existsSync(scriptsDir)) {
    return []
  }

  let entries: string[]
  try {
    entries = readdirSync(scriptsDir)
  } catch {
    return []
  }

  return entries
    .filter((f) => {
      if (EXACT_TEST_NAMES.has(f)) return true
      return TEST_SUFFIXES.some((suffix) => f.endsWith(suffix))
    })
    .sort()
}

// ── Test execution ────────────────────────────────────────────────────

/**
 * Truncate a string to at most `maxBytes` bytes, appending a truncation
 * notice if the output was clipped.
 */
function truncateOutput(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output, 'utf-8') <= maxBytes) {
    return output
  }
  // Slice by byte length — find the character boundary
  const buf = Buffer.from(output, 'utf-8')
  const truncated = buf.subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n... [output truncated]'
}

/**
 * Execute a single test file in a subprocess and capture its result.
 *
 * @param displayName - The filename shown in results (e.g. `test.ts`)
 * @param filePath - The path passed to the runner, relative to cwd (e.g. `scripts/test.ts`)
 * @param runner - The runner specification (command + args builder)
 * @param cwd - Working directory for the subprocess (the skill directory)
 * @param timeoutMs - Maximum execution time before the process is killed
 */
function executeTestFile(
  displayName: string,
  filePath: string,
  runner: RunnerSpec,
  cwd: string,
  timeoutMs: number,
): Promise<SkillTestFileResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    const child = spawn(runner.command, runner.args(filePath), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      killed = true
      // Kill the entire process group (negative PID) so child processes
      // spawned by the test script (e.g. `sleep`) are also terminated.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        // Process may have already exited — ignore.
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({
          file: displayName,
          status: 'error',
          exitCode: -1,
          stdout: truncateOutput(stdout, MAX_OUTPUT_BYTES),
          stderr: truncateOutput(`Failed to spawn: ${error.message}\n${stderr}`, MAX_OUTPUT_BYTES),
          durationMs: Date.now() - startTime,
        })
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        const durationMs = Date.now() - startTime
        const exitCode = code ?? 1

        if (killed) {
          resolve({
            file: displayName,
            status: 'error',
            exitCode: exitCode,
            stdout: truncateOutput(stdout, MAX_OUTPUT_BYTES),
            stderr: truncateOutput(
              `${stderr}\nTest timed out after ${timeoutMs}ms and was killed`,
              MAX_OUTPUT_BYTES,
            ),
            durationMs,
          })
        } else {
          resolve({
            file: displayName,
            status: exitCode === 0 ? 'pass' : 'fail',
            exitCode,
            stdout: truncateOutput(stdout, MAX_OUTPUT_BYTES),
            stderr: truncateOutput(stderr, MAX_OUTPUT_BYTES),
            durationMs,
          })
        }
      }
    })
  })
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run all test scripts in a skill directory and return structured results.
 *
 * - Validates the skill directory exists and contains a SKILL.md
 * - Discovers test files in `scripts/`
 * - Executes each with the appropriate runner
 * - Returns `Result.err` if the directory is missing, has no SKILL.md, or has no test files
 * - Never throws
 */
export async function runSkillTests(skillPath: string): Promise<Result<SkillTestResult>> {
  // Validate skill directory exists
  if (!existsSync(skillPath)) {
    return err(new Error(`Skill directory does not exist: ${skillPath}`))
  }

  // Validate SKILL.md exists
  const skillMdPath = join(skillPath, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    return err(new Error(`Skill directory is missing SKILL.md: ${skillPath}`))
  }

  // Extract skill name from directory path
  const skillName = skillPath.split('/').filter(Boolean).pop() ?? 'unknown'

  // Discover test files
  const scriptsDir = join(skillPath, 'scripts')
  const testFiles = await discoverTestFiles(scriptsDir)

  if (testFiles.length === 0) {
    return err(new Error(`No test files found in ${scriptsDir}`))
  }

  // Execute each test file
  const results: SkillTestFileResult[] = []

  for (const file of testFiles) {
    const runner = getRunner(file)
    if (!runner) {
      results.push({
        file,
        status: 'error',
        exitCode: -1,
        stdout: '',
        stderr: `No runner available for file: ${file}`,
        durationMs: 0,
      })
      continue
    }

    const filePath = join('scripts', file)
    const result = await executeTestFile(file, filePath, runner, skillPath, DEFAULT_TIMEOUT_MS)
    results.push(result)
  }

  // Determine overall pass/fail
  const overall = results.every((r) => r.status === 'pass') ? 'pass' : 'fail'

  return ok({
    skillName,
    skillPath,
    overall,
    testFiles: results,
  })
}
