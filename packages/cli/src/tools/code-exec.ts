import { z } from 'zod'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'
import { scrubToolEnv } from './env'

export const name = 'code-exec'

export const description =
  'Generate and execute a TypeScript snippet with Bun in an isolated temp ' +
  'workspace. Use this when the answer is naturally a computation (parse ' +
  'data, hash a string, run a small algorithm, transform JSON) rather than ' +
  'a shell pipeline. Snippet runs with no inherited API keys and cwd set to ' +
  'a fresh temp dir which is deleted on completion. Optional `packages` are ' +
  'installed via `bun install` before execution. Network access is NOT ' +
  'sandboxed — do not run untrusted code that calls out.'

export const schema = z.object({
  code: z
    .string()
    .min(1)
    .describe('TypeScript source. Top-level await is allowed. Print results via console.log.'),
  packages: z
    .array(z.string())
    .optional()
    .describe('npm specs (e.g. "lodash", "zod@3"). Installed via `bun install` before run.'),
  timeout: z
    .number()
    .positive()
    .max(300)
    .optional()
    .default(30)
    .describe('Hard timeout in seconds. Max 300, default 30.'),
  maxOutputBytes: z
    .number()
    .positive()
    .max(10_000_000)
    .optional()
    .default(1_048_576)
    .describe('Per-stream cap on stdout/stderr. Excess is truncated. Default 1 MiB.'),
})

export interface CodeExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  truncated?: boolean
  installedPackages?: string[]
}

interface ChildRunResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

function runChild(
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number,
): Promise<Result<ChildRunResult>> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let killed = false
    let settled = false

    const child = spawn(cmd, cmdArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return
      const incoming = chunk.toString()
      const incomingBytes = chunk.length
      if (stdoutBytes + incomingBytes > maxBytes) {
        const remaining = Math.max(0, maxBytes - stdoutBytes)
        stdout += incoming.slice(0, remaining)
        stdout += `\n[output truncated at ${maxBytes} bytes]\n`
        stdoutBytes = maxBytes
        stdoutTruncated = true
      } else {
        stdout += incoming
        stdoutBytes += incomingBytes
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return
      const incoming = chunk.toString()
      const incomingBytes = chunk.length
      if (stderrBytes + incomingBytes > maxBytes) {
        const remaining = Math.max(0, maxBytes - stderrBytes)
        stderr += incoming.slice(0, remaining)
        stderr += `\n[output truncated at ${maxBytes} bytes]\n`
        stderrBytes = maxBytes
        stderrTruncated = true
      } else {
        stderr += incoming
        stderrBytes += incomingBytes
      }
    })

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error.code === 'ENOENT') {
        resolve(err(new Error(`${cmd} binary not found on PATH`)))
      } else {
        resolve(err(new Error(`Failed to spawn ${cmd}: ${error.message}`)))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killed) {
        resolve(
          err(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`)),
        )
      } else {
        resolve(
          ok({
            stdout,
            stderr,
            exitCode: code ?? 1,
            truncated: stdoutTruncated || stderrTruncated,
          }),
        )
      }
    })
  })
}

export const execute: TypedToolExecute<typeof schema, CodeExecResult> = async (
  args,
): Promise<Result<CodeExecResult>> => {
  const start = Date.now()
  const workDir = await mkdtemp(join(tmpdir(), 'ouroboros-code-exec-'))
  const filteredEnv = scrubToolEnv()

  try {
    if (args.packages && args.packages.length > 0) {
      await writeFile(join(workDir, 'package.json'), '{"private":true}')
      const installTimeoutMs = Math.min(args.timeout * 1000, 60_000)
      const installResult = await runChild(
        'bun',
        ['install', '--no-summary', ...args.packages],
        workDir,
        filteredEnv,
        installTimeoutMs,
        args.maxOutputBytes,
      )
      if (!installResult.ok) {
        return installResult
      }
      if (installResult.value.exitCode !== 0) {
        return ok({
          stdout: installResult.value.stdout,
          stderr: `bun install failed:\n${installResult.value.stderr}`,
          exitCode: installResult.value.exitCode,
          durationMs: Date.now() - start,
          truncated: installResult.value.truncated || undefined,
          installedPackages: args.packages,
        })
      }
    }

    const codeFile = join(workDir, 'main.ts')
    await writeFile(codeFile, args.code)

    const runResult = await runChild(
      'bun',
      ['run', codeFile],
      workDir,
      filteredEnv,
      args.timeout * 1000,
      args.maxOutputBytes,
    )
    if (!runResult.ok) {
      return runResult
    }

    return ok({
      stdout: runResult.value.stdout,
      stderr: runResult.value.stderr,
      exitCode: runResult.value.exitCode,
      durationMs: Date.now() - start,
      truncated: runResult.value.truncated || undefined,
      installedPackages: args.packages,
    })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
export const tier = 1
