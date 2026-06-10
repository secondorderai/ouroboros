/**
 * OS sandbox facade — process-wide singleton.
 *
 * bash/code-exec call `wrapCommand()` inside their `execute()` after registry
 * tier enforcement, so sandboxing tier-0/1 spawns adds zero new approval
 * prompts. The singleton is (re)initialized by the JSON-RPC server on
 * startup, config changes, and workspace switches, and by the REPL at boot
 * (mirroring the `setTierApprovalHandler` singleton pattern).
 *
 * Behavior is fail-open by design (a locked user decision): when the
 * platform/primitives are unavailable the facade reports
 * `mode: 'unavailable'` and `wrapCommand` passes commands through
 * unsandboxed; the tools surface a warn-once note via
 * `consumeUnavailableWarning()`.
 */

import { type Result, ok } from '@src/types'
import type { OuroborosConfig } from '@src/config'
import { hasTierApprovalHandler } from '@src/tier-approval'
import { buildSandboxPolicy, type SandboxPolicy } from './policy'

/** Backend-agnostic spawn shape (library backend: `sh -c <wrapped>`). */
export interface SpawnSpec {
  command: string
  args: string[]
}

export type SandboxMode = 'enforcing' | 'disabled' | 'unavailable' | 'uninitialized'

export interface SandboxStatus {
  mode: SandboxMode
  /** Populated when mode === 'unavailable'. */
  reason?: string
  platform: NodeJS.Platform
}

export interface SandboxInitOptions {
  configDir: string
  cwd: string
  extraWriteRoots?: string[]
}

/**
 * Pluggable backend boundary. The production implementation lives in
 * `srt-backend.ts`; tests install fakes via `setSandboxBackendForTesting`.
 */
export interface SandboxBackend {
  checkDependencies(): { errors: string[]; warnings: string[] }
  initialize(policy: SandboxPolicy): Promise<void>
  wrapCommand(command: string): Promise<SpawnSpec>
  annotateStderr(command: string, stderr: string): string
  /**
   * Per-command cleanup hook (srt's `cleanupAfterCommand` contract): called
   * after each sandboxed child exits. On Linux, bwrap creates empty
   * placeholder files on the host for non-existent deny paths and srt tracks
   * an active-sandbox count per wrap — without this hook both persist/grow
   * for the whole session.
   */
  completeCommand(): void
  reset(): Promise<void>
}

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'linux'])

let status: SandboxStatus = { mode: 'uninitialized', platform: process.platform }
let activeBackend: SandboxBackend | null = null
let testBackend: SandboxBackend | null = null
let lastConfig: OuroborosConfig | null = null
let lastOptions: SandboxInitOptions | null = null
let accumulatedWriteRoots: string[] = []
let unavailableWarningConsumed = false

/**
 * Promise mutex serializing every facade state transition (initialize /
 * re-initialize / write-root widening / reset) AND command wrapping.
 * This guarantees:
 *
 * - **No silent unsandboxed window during re-init**: `wrapCommand` queues
 *   behind an in-flight (re)initialization instead of observing the
 *   torn-down intermediate state (`activeBackend === null` while `status`
 *   still says 'enforcing') and passing commands through with no OS sandbox
 *   and no warning. Re-init is fail-closed: concurrent commands wait for
 *   the new backend.
 * - **Write roots cannot be lost**: concurrent `addSandboxWriteRoot` calls
 *   read `accumulatedWriteRoots` inside the lock, so each sees the other's
 *   root instead of racing to re-initialize from the same stale array.
 * - **srt's process-global initialize/reset never overlap** (it manages
 *   singleton proxy servers and config).
 */
let stateChain: Promise<unknown> = Promise.resolve()

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateChain.then(fn)
  stateChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function resolveBackend(): Promise<SandboxBackend> {
  if (testBackend) return testBackend
  // Dynamic import keeps srt out of test/module-load paths that never
  // initialize the sandbox; `bun build --compile` still bundles it.
  const { createSrtBackend } = await import('./srt-backend')
  return createSrtBackend()
}

/** Callers must hold the state lock. */
async function teardownActiveBackend(): Promise<void> {
  const backend = activeBackend
  activeBackend = null
  if (!backend) return
  try {
    await backend.reset()
  } catch {
    // Teardown is best-effort; a half-dead backend must not block re-init.
  }
}

/**
 * Locked core of (re)initialization. Callers must hold the state lock.
 * Never throws — any failure degrades to `mode: 'unavailable'` with a reason.
 */
async function initializeSandboxLocked(
  config: OuroborosConfig,
  options: SandboxInitOptions,
): Promise<SandboxStatus> {
  // Leave 'enforcing' BEFORE tearing anything down so no observer ever sees
  // an enforcing facade with no backend. Commands queue behind the state
  // lock for the duration of the (re)initialize, so this transitional state
  // is visible only to getSandboxStatus() readers.
  status = { mode: 'uninitialized', platform: process.platform }
  await teardownActiveBackend()
  lastConfig = config
  lastOptions = options
  accumulatedWriteRoots = [...(options.extraWriteRoots ?? [])]

  if (!config.sandbox.enabled) {
    status = { mode: 'disabled', platform: process.platform }
    return status
  }

  // Real platform gate only applies to the real backend — fakes installed by
  // tests decide availability via checkDependencies().
  if (!testBackend && !SUPPORTED_PLATFORMS.has(process.platform)) {
    status = {
      mode: 'unavailable',
      reason: `OS sandbox is not supported on platform "${process.platform}"`,
      platform: process.platform,
    }
    return status
  }

  try {
    const backend = await resolveBackend()
    const dependencies = backend.checkDependencies()
    if (dependencies.errors.length > 0) {
      status = {
        mode: 'unavailable',
        reason: dependencies.errors.join('; '),
        platform: process.platform,
      }
      return status
    }

    const policy = buildSandboxPolicy(config, {
      configDir: options.configDir,
      cwd: options.cwd,
      writeRoots: accumulatedWriteRoots,
    })
    await backend.initialize(policy)
    activeBackend = backend
    status = { mode: 'enforcing', platform: process.platform }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    status = {
      mode: 'unavailable',
      reason: `sandbox initialization failed: ${message}`,
      platform: process.platform,
    }
  }
  return status
}

/**
 * Probe availability, build the policy, and initialize the backend from a
 * clean slate — runtime write roots accumulated via `addSandboxWriteRoot`
 * are discarded. Use `reinitializeSandbox` for live re-anchoring.
 * Never throws — any failure degrades to `mode: 'unavailable'` with a reason.
 */
export async function initializeSandbox(
  config: OuroborosConfig,
  options: SandboxInitOptions,
): Promise<SandboxStatus> {
  return withStateLock(() => initializeSandboxLocked(config, options))
}

/**
 * Reset + initialize with fresh config/anchors. srt's policy is fixed at
 * initialize time, so any config or cwd change requires a full re-init.
 *
 * Runtime write roots accumulated via `addSandboxWriteRoot` (worker
 * worktrees) are PRESERVED: the server's re-init hooks (`config/set`,
 * `workspace/set`, `workspace/clear`) fire while long-lived workers may
 * still be running, and dropping their roots would kernel-deny every write
 * inside their worktrees for the rest of the run.
 */
export async function reinitializeSandbox(
  config: OuroborosConfig,
  options: SandboxInitOptions,
): Promise<SandboxStatus> {
  return withStateLock(() => {
    const mergedRoots = Array.from(
      new Set([...(options.extraWriteRoots ?? []), ...accumulatedWriteRoots]),
    )
    return initializeSandboxLocked(config, { ...options, extraWriteRoots: mergedRoots })
  })
}

/**
 * Widen the write policy with a runtime root (worker worktrees). No-op until
 * the sandbox has been initialized at least once. Serialized through the
 * state lock so concurrent calls (e.g. two spawn-agent tool calls in one
 * Promise.all step) each see the other's root.
 */
export async function addSandboxWriteRoot(path: string): Promise<SandboxStatus> {
  return withStateLock(async () => {
    if (!lastConfig || !lastOptions) {
      return getSandboxStatus()
    }
    if (accumulatedWriteRoots.includes(path)) {
      return getSandboxStatus()
    }
    const nextRoots = [...accumulatedWriteRoots, path]
    return initializeSandboxLocked(lastConfig, { ...lastOptions, extraWriteRoots: nextRoots })
  })
}

/**
 * Wrap a shell command for sandboxed execution. Passthrough (`sandboxed:
 * false`, plain `sh -c`) when the sandbox is disabled, unavailable, or not
 * yet initialized — existing call sites and tests behave unchanged by
 * default. A backend wrap failure degrades the status to 'unavailable'
 * (firing the warn-once note) rather than blocking the command.
 *
 * Queues behind any in-flight (re)initialization via the state lock —
 * fail-closed: during a re-init window commands wait for the new backend
 * instead of silently running unsandboxed. The wrap itself is a fast
 * command-string transformation, so serializing it is cheap.
 */
export async function wrapCommand(
  command: string,
): Promise<Result<{ spec: SpawnSpec; sandboxed: boolean }>> {
  return withStateLock(() => wrapCommandLocked(command))
}

async function wrapCommandLocked(
  command: string,
): Promise<Result<{ spec: SpawnSpec; sandboxed: boolean }>> {
  if (status.mode !== 'enforcing' || !activeBackend) {
    return ok({ spec: { command: 'sh', args: ['-c', command] }, sandboxed: false })
  }
  try {
    const spec = await activeBackend.wrapCommand(command)
    return ok({ spec, sandboxed: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    status = {
      mode: 'unavailable',
      reason: `sandbox wrap failed: ${message}`,
      platform: process.platform,
    }
    await teardownActiveBackend()
    return ok({ spec: { command: 'sh', args: ['-c', command] }, sandboxed: false })
  }
}

/**
 * Notify the backend that a sandboxed child process has exited — srt's
 * documented per-command contract (`cleanupAfterCommand`). Without it,
 * Linux bwrap placeholder files persist on the host and srt's
 * active-sandbox count grows monotonically until process exit. Tools call
 * this only for spawns that actually ran sandboxed. Best-effort and
 * synchronous; never throws.
 */
export function notifySandboxedCommandComplete(): void {
  if (!activeBackend) return
  try {
    activeBackend.completeCommand()
  } catch {
    // Per-command cleanup is best-effort; reset() remains the safety net.
  }
}

export function getSandboxStatus(): SandboxStatus {
  return { ...status }
}

/**
 * Returns true exactly once per process while the sandbox is unavailable —
 * powers the warn-once fallback note in tool output.
 */
export function consumeUnavailableWarning(): boolean {
  if (status.mode !== 'unavailable' || unavailableWarningConsumed) {
    return false
  }
  unavailableWarningConsumed = true
  return true
}

/**
 * Run captured stderr through the backend's violation-log corroboration
 * (appends a `<sandbox_violations>` block on macOS). Identity passthrough
 * when not enforcing.
 */
export function annotateSandboxStderr(command: string, stderr: string): string {
  if (status.mode !== 'enforcing' || !activeBackend) return stderr
  try {
    return activeBackend.annotateStderr(command, stderr)
  } catch {
    return stderr
  }
}

export interface SandboxFailureClassification {
  likelyViolation: boolean
  /** Human-readable indicator of which signature matched. */
  indicator?: string
}

/**
 * Heuristic classifier for "this failure looks like a sandbox denial",
 * seeded from the PR0 spike's captured signatures. Callers must only consult
 * it for commands that actually ran sandboxed — ordinary permission errors
 * outside the sandbox would otherwise false-positive.
 */
export function classifySandboxFailure(input: {
  exitCode: number
  stderr: string
  platform?: NodeJS.Platform
}): SandboxFailureClassification {
  const platform = input.platform ?? process.platform
  const { stderr } = input

  // Seatbelt log-monitor corroboration block appended by
  // annotateStderrWithSandboxFailures. sysctl-read / mach-lookup denials
  // appear even for fully successful commands — only file-write*/network
  // denial lines count as violations.
  const violationBlock = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/.exec(stderr)
  if (violationBlock?.[1]) {
    for (const line of violationBlock[1].split('\n')) {
      if (!/deny\(\d+\)/.test(line)) continue
      if (line.includes('sysctl-read') || line.includes('mach-lookup')) continue
      if (/deny\(\d+\)\s+file-write/.test(line)) {
        return { likelyViolation: true, indicator: 'file-write denial reported by the OS sandbox' }
      }
      if (/deny\(\d+\)\s+network/.test(line)) {
        return { likelyViolation: true, indicator: 'network denial reported by the OS sandbox' }
      }
    }
  }

  if (input.exitCode === 0) {
    return { likelyViolation: false }
  }

  if (platform === 'darwin') {
    // e.g. `touch: /Users/x/file: Operation not permitted` (also the
    // /bin/bash-prefixed redirection and mkdir variants).
    if (stderr.includes(': Operation not permitted')) {
      return { likelyViolation: true, indicator: '"Operation not permitted" filesystem denial' }
    }
  }

  if (platform === 'linux') {
    if (/\bbwrap[:\s]/.test(stderr)) {
      return { likelyViolation: true, indicator: 'bubblewrap sandbox error' }
    }
    if (stderr.includes('EACCES')) {
      return { likelyViolation: true, indicator: 'EACCES permission denial' }
    }
    if (stderr.includes('Read-only file system')) {
      return { likelyViolation: true, indicator: 'read-only filesystem denial' }
    }
    if (stderr.includes('Permission denied')) {
      return { likelyViolation: true, indicator: 'permission denial' }
    }
  }

  // Proxy-shaped network denials (srt rejects disallowed domains with 403).
  if (stderr.includes('CONNECT tunnel failed, response 403')) {
    return { likelyViolation: true, indicator: 'HTTPS CONNECT rejected by the sandbox proxy' }
  }
  if (stderr.includes('The requested URL returned error: 403')) {
    return { likelyViolation: true, indicator: 'HTTP 403 returned by the sandbox proxy' }
  }

  return { likelyViolation: false }
}

const COMMAND_SUMMARY_MAX_LENGTH = 200

/**
 * Truncated, single-line command text for sandbox-violation events and
 * notifications. Whitespace runs are collapsed; output is bounded so payloads
 * stay small. Callers must pass the command text only — never env values.
 */
export function summarizeSandboxCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= COMMAND_SUMMARY_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, COMMAND_SUMMARY_MAX_LENGTH - 1)}…`
}

/**
 * Stable, model-facing guidance appended to stderr when a sandboxed command
 * fails with a denial-shaped error. The `[sandbox]` prefix and the
 * `bypassSandbox: true` escalation hint are a tested contract
 * (see tests/safety/sandbox.test.ts "escalation guidance contract").
 *
 * The escalation hint branches on whether a tier-approval handler is
 * registered: only the JSON-RPC server registers one (desktop mode), so in
 * REPL mode the guidance says approval requires the desktop app instead of
 * promising an approval prompt that can never appear.
 */
export function buildSandboxBlockedMessage(indicator: string | undefined): string {
  const blocked =
    `[sandbox] This command appears to have been blocked by the OS sandbox` +
    `${indicator ? ` (${indicator})` : ''}. `
  if (hasTierApprovalHandler()) {
    return (
      blocked +
      `If this operation is legitimately needed, retry with bypassSandbox: true ` +
      `to request human approval for an unsandboxed run.`
    )
  }
  return (
    blocked +
    `If this operation is legitimately needed, retry with bypassSandbox: true — ` +
    `note that the required tier-4 human approval is only available in the desktop app, ` +
    `so the retry will be denied in this session.`
  )
}

/**
 * Warn-once fallback note appended to tool stderr the first time a command
 * runs unsandboxed because the sandbox is unavailable.
 */
export function buildSandboxUnavailableMessage(reason: string | undefined): string {
  return (
    `[sandbox] OS sandbox unavailable` +
    `${reason ? ` (${reason})` : ''}; commands run unsandboxed this session.`
  )
}

/** Tear down the backend and return to the uninitialized state. */
export async function resetSandbox(): Promise<void> {
  return withStateLock(async () => {
    await teardownActiveBackend()
    status = { mode: 'uninitialized', platform: process.platform }
    lastConfig = null
    lastOptions = null
    accumulatedWriteRoots = []
    unavailableWarningConsumed = false
  })
}

/** Install a fake backend for tests (pass null to restore the real one). */
export function setSandboxBackendForTesting(backend: SandboxBackend | null): void {
  testBackend = backend
}
