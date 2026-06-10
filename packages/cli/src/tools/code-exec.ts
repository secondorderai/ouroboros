import { z } from 'zod'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Result, ok, err } from '@src/types'
import type { ToolExecutionContext, ToolTier, TypedToolExecute } from './types'
import { scrubToolEnv } from './env'
import {
  buildSandboxBlockedMessage,
  buildSandboxDeniedMessage,
  buildSandboxUnavailableMessage,
  classifySandboxFailure,
  consumeUnavailableWarning,
  getSandboxStatus,
  notifySandboxedCommandComplete,
  requestSandboxEscalation,
  SANDBOX_ESCALATION_RETRY_NOTE,
  summarizeSandboxCommand,
  wrapCommand,
  type SandboxFailureClassification,
} from '@src/safety/sandbox'

export const name = 'code-exec'

export const description =
  'Generate and execute a TypeScript snippet with Bun in an isolated temp ' +
  'workspace. Use this when the answer is naturally a computation (parse ' +
  'data, hash a string, run a small algorithm, transform JSON) rather than ' +
  'a shell pipeline. Snippet runs with no inherited API keys and cwd set to ' +
  'a fresh temp dir which is deleted on completion. Optional `packages` are ' +
  'installed via `bun install` before execution. Execution runs under the ' +
  'OS sandbox when available: filesystem writes are confined to the temp ' +
  'workspace and network access is limited to allowed domains. If the ' +
  'sandbox blocks a legitimate operation, retry with bypassSandbox: true to ' +
  'request human approval for an unsandboxed run.'

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
  bypassSandbox: z
    .boolean()
    .optional()
    .describe(
      'Re-run a sandbox-blocked execution without the OS sandbox. Requires tier-4 human approval.',
    ),
})

export function resolveTier(args: unknown): ToolTier {
  const record =
    typeof args === 'object' && args !== null ? (args as { bypassSandbox?: unknown }) : undefined
  // Opting out of the OS sandbox is a system-level action: route it through
  // the tier-4 human-approval flow.
  return record?.bypassSandbox === true ? 4 : 1
}

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

const SAFE_SHELL_ARG = /^[A-Za-z0-9_\-./:=@%+,]+$/

/** Quote a single argument for safe inclusion in a `sh -c` command string. */
function shellQuoteArg(arg: string): string {
  if (arg.length > 0 && SAFE_SHELL_ARG.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** Render an argv as a properly-quoted shell command string for wrapping. */
export function shellQuoteCommand(argv: string[]): string {
  return argv.map(shellQuoteArg).join(' ')
}

interface ResolvedSpawn {
  cmd: string
  cmdArgs: string[]
  sandboxed: boolean
  /**
   * Warn-once "sandbox unavailable" note, set on the process's first
   * unsandboxed fallback. The caller MUST surface it in the tool's returned
   * stderr: consuming the process-wide warn-once token without showing the
   * note would silently suppress the model-facing warning for the rest of
   * the session (bash gates its own note on the same token).
   */
  fallbackNote?: string
}

/**
 * Route a spawn through the OS sandbox. Falls back to the direct argv spawn
 * (today's behavior) when bypassed or when the sandbox is not enforcing —
 * preserving direct-child kill/ENOENT semantics in the passthrough path.
 *
 * The first unsandboxed fallback in the process (sandbox unavailable, not
 * bypassed) emits a `sandbox-unavailable` event for the desktop notice and
 * returns the warn-once `fallbackNote` for the tool's own stderr output.
 */
async function resolveSpawn(
  argv: [string, ...string[]],
  bypass: boolean,
  context?: ToolExecutionContext,
): Promise<ResolvedSpawn> {
  if (!bypass) {
    const wrapped = await wrapCommand(shellQuoteCommand(argv))
    if (wrapped.ok && wrapped.value.sandboxed) {
      return {
        cmd: wrapped.value.spec.command,
        cmdArgs: wrapped.value.spec.args,
        sandboxed: true,
      }
    }
    const status = getSandboxStatus()
    if (status.mode === 'unavailable' && consumeUnavailableWarning()) {
      context?.emitEvent?.({
        type: 'sandbox-unavailable',
        reason: status.reason ?? 'unknown reason',
        platform: status.platform,
      })
      return {
        cmd: argv[0],
        cmdArgs: argv.slice(1),
        sandboxed: false,
        fallbackNote: buildSandboxUnavailableMessage(status.reason),
      }
    }
  }
  return { cmd: argv[0], cmdArgs: argv.slice(1), sandboxed: false }
}

/**
 * Classify a sandboxed run's failure and emit a `sandbox-violation` event
 * for the desktop notification bridge (truncated command, no env values).
 * Guidance appending and escalation are handled at the call sites.
 */
function detectSandboxViolation(
  stderr: string,
  exitCode: number,
  sandboxed: boolean,
  argv: string[],
  workDir: string,
  context?: ToolExecutionContext,
): SandboxFailureClassification {
  if (!sandboxed || exitCode === 0) return { likelyViolation: false }
  const classification = classifySandboxFailure({ exitCode, stderr })
  if (!classification.likelyViolation) return classification
  context?.emitEvent?.({
    type: 'sandbox-violation',
    toolName: name,
    commandSummary: summarizeSandboxCommand(shellQuoteCommand(argv)),
    indicator: classification.indicator,
    cwd: workDir,
    platform: process.platform,
  })
  return classification
}

const CODE_PREVIEW_MAX_LENGTH = 300

type EscalationAttempt =
  | { kind: 'retried'; result: Result<CodeExecResult> }
  | { kind: 'denied' }
  | { kind: 'skipped' }

/**
 * Tool-initiated escalation after a sandbox violation: ask the human to
 * approve an unsandboxed re-run (standard tier-4 approval toast; blocks
 * until answered). On approval the WHOLE execution re-runs with
 * `bypassSandbox: true` in a fresh temp workspace — install and run both
 * unwrapped — since the sandboxed attempt may have partially executed and
 * the approval covers a full repeat.
 */
async function escalateAndRetry(
  args: z.infer<typeof schema>,
  context: ToolExecutionContext | undefined,
  indicator: string | undefined,
): Promise<EscalationAttempt> {
  const outcome = await requestSandboxEscalation(name, {
    bypassSandbox: true,
    packages: args.packages,
    codePreview:
      args.code.length > CODE_PREVIEW_MAX_LENGTH
        ? `${args.code.slice(0, CODE_PREVIEW_MAX_LENGTH)}…`
        : args.code,
    reason:
      `OS sandbox blocked this code execution` +
      `${indicator ? ` (${indicator})` : ''}; approve to re-run it without the sandbox.`,
  })
  if (outcome === 'approved') {
    if (context?.abortSignal?.aborted) {
      return { kind: 'retried', result: err(new Error('Code execution cancelled by user')) }
    }
    const retry = await execute({ ...args, bypassSandbox: true }, context)
    if (!retry.ok) return { kind: 'retried', result: retry }
    return {
      kind: 'retried',
      result: ok({
        ...retry.value,
        stderr: `${retry.value.stderr}\n${SANDBOX_ESCALATION_RETRY_NOTE}`,
      }),
    }
  }
  return outcome === 'denied' ? { kind: 'denied' } : { kind: 'skipped' }
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
  context?: ToolExecutionContext,
): Promise<Result<CodeExecResult>> => {
  const start = Date.now()
  const workDir = await mkdtemp(join(tmpdir(), 'ouroboros-code-exec-'))
  const filteredEnv = scrubToolEnv()
  // bypassSandbox only reaches execute() after tier-4 human approval
  // (resolveTier escalates it); honoring it here runs the spawns unwrapped.
  const bypass = args.bypassSandbox === true
  // Warn-once unavailable note from whichever spawn consumed the token —
  // appended to the returned stderr so the model still learns it is running
  // unsandboxed (mirrors bash's fallback note).
  let fallbackNote = ''

  try {
    if (args.packages && args.packages.length > 0) {
      await writeFile(join(workDir, 'package.json'), '{"private":true}')
      const installTimeoutMs = Math.min(args.timeout * 1000, 60_000)
      const installArgv: [string, ...string[]] = [
        'bun',
        'install',
        '--no-summary',
        ...args.packages,
      ]
      const installSpawn = await resolveSpawn(installArgv, bypass, context)
      if (installSpawn.fallbackNote) fallbackNote = `\n${installSpawn.fallbackNote}`
      const installResult = await runChild(
        installSpawn.cmd,
        installSpawn.cmdArgs,
        workDir,
        filteredEnv,
        installTimeoutMs,
        args.maxOutputBytes,
      )
      // srt's per-command contract: clean up after each sandboxed child
      // exits (including spawn-error and timeout-kill paths).
      if (installSpawn.sandboxed) notifySandboxedCommandComplete()
      if (!installResult.ok) {
        return installResult
      }
      if (installResult.value.exitCode !== 0) {
        let installStderr = installResult.value.stderr
        const violation = detectSandboxViolation(
          installStderr,
          installResult.value.exitCode,
          installSpawn.sandboxed,
          installArgv,
          workDir,
          context,
        )
        if (violation.likelyViolation) {
          const attempt = await escalateAndRetry(args, context, violation.indicator)
          if (attempt.kind === 'retried') return attempt.result
          installStderr =
            attempt.kind === 'denied'
              ? `${installStderr}\n${buildSandboxDeniedMessage(violation.indicator)}`
              : `${installStderr}\n${buildSandboxBlockedMessage(violation.indicator)}`
        }
        return ok({
          stdout: installResult.value.stdout,
          stderr: `bun install failed:\n${installStderr}${fallbackNote}`,
          exitCode: installResult.value.exitCode,
          durationMs: Date.now() - start,
          truncated: installResult.value.truncated || undefined,
          installedPackages: args.packages,
        })
      }
    }

    const codeFile = join(workDir, 'main.ts')
    await writeFile(codeFile, args.code)

    const runArgv: [string, ...string[]] = ['bun', 'run', codeFile]
    const runSpawn = await resolveSpawn(runArgv, bypass, context)
    if (runSpawn.fallbackNote) fallbackNote = `\n${runSpawn.fallbackNote}`
    const runResult = await runChild(
      runSpawn.cmd,
      runSpawn.cmdArgs,
      workDir,
      filteredEnv,
      args.timeout * 1000,
      args.maxOutputBytes,
    )
    if (runSpawn.sandboxed) notifySandboxedCommandComplete()
    if (!runResult.ok) {
      return runResult
    }

    let runStderr = runResult.value.stderr
    const violation = detectSandboxViolation(
      runStderr,
      runResult.value.exitCode,
      runSpawn.sandboxed,
      runArgv,
      workDir,
      context,
    )
    if (violation.likelyViolation) {
      const attempt = await escalateAndRetry(args, context, violation.indicator)
      if (attempt.kind === 'retried') return attempt.result
      runStderr =
        attempt.kind === 'denied'
          ? `${runStderr}\n${buildSandboxDeniedMessage(violation.indicator)}`
          : `${runStderr}\n${buildSandboxBlockedMessage(violation.indicator)}`
    }

    return ok({
      stdout: runResult.value.stdout,
      stderr: `${runStderr}${fallbackNote}`,
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
