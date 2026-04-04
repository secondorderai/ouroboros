import { z } from 'zod'
import { spawn } from 'node:child_process'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'bash'

export const description =
  'Execute a shell command and return its stdout, stderr, and exit code. ' +
  'Commands are run in a child process with an optional timeout (default 30 s).'

export const schema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z
    .number()
    .positive()
    .optional()
    .default(30)
    .describe('Timeout in seconds (default 30)'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the command (defaults to process.cwd())'),
})

export interface BashResult {
  stdout: string
  stderr: string
  exitCode: number
}

export const execute: TypedToolExecute<typeof schema, BashResult> = async (
  args,
): Promise<Result<BashResult>> => {
  const { command, timeout, cwd } = args
  const timeoutMs = timeout * 1000

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    const child = spawn('sh', ['-c', command], {
      cwd: cwd ?? process.cwd(),
      env: process.env,
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
        resolve(err(new Error(`Failed to spawn command: ${error.message}`)))
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        if (killed) {
          resolve(
            err(
              new Error(
                `Command timed out after ${timeout}s and was killed`,
              ),
            ),
          )
        } else {
          resolve(ok({ stdout, stderr, exitCode: code ?? 1 }))
        }
      }
    })
  })
}
