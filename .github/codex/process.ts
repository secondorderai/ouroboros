import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import { z as schema } from 'zod'
import { retryAt } from './model'

export class Interrupted extends Error {
  constructor(
    readonly kind: 'time' | 'quota' | 'cancelled' | 'auth',
    message: string,
    readonly notBefore = 0,
  ) {
    super(message)
  }
}

// Explicit inheritance prevents Actions/PAT/artifact credentials from reaching
// repository build scripts, Codex, and its shell tools.
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XAUTHORITY',
    'CI',
    'TERM',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ]
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  )
}

export async function command(
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    onLine?: (line: string) => void
    limit?: number
    input?: string
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw new Interrupted('time', 'Execution window ended.')
  return new Promise((resolve, reject) => {
    const process = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd,
      env: options.env ?? childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    process.stdin.on('error', () => {
      /* an early-exiting command can close stdin */
    })
    process.stdin.end(options.input ?? '')
    let stdout = '',
      stderr = '',
      pending = ''
    const limit = options.limit ?? 2_000_000
    const kill = (signal: NodeJS.Signals) => {
      if (process.pid) {
        try {
          globalThis.process.kill(-process.pid, signal)
        } catch {
          /* already exited */
        }
      }
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      kill('SIGINT')
      killTimer = setTimeout(() => kill('SIGKILL'), 20_000)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    process.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-limit)
      pending += text
      for (;;) {
        const index = pending.indexOf('\n')
        if (index === -1) break
        options.onLine?.(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
    })
    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-limit)
    })
    process.on('error', reject)
    process.on('close', (code) => {
      if (pending) options.onLine?.(pending)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      // Child shell servers must not survive a completed stage.
      kill('SIGTERM')
      resolve({ code: code ?? 130, stdout, stderr })
    })
  })
}

export function classifyFailure(message: string, now = Date.now()): Interrupted | null {
  if (
    /refresh_token_reused|refresh token.*(?:expired|revoked)|authentication.*(?:failed|expired)|unauthorized|\b401\b/i.test(
      message,
    )
  ) {
    return new Interrupted('auth', 'Codex authentication requires reseeding the Actions secret.')
  }
  if (/usage_limit_reached|usage limit|rate_limit_exceeded|rate limit|\b429\b/i.test(message)) {
    return new Interrupted(
      'quota',
      'Waiting for Codex subscription allowance.',
      retryAt(message, now),
    )
  }
  return null
}

export async function availableSession(home: string, id?: string): Promise<string | undefined> {
  if (!id) return undefined
  for (const directory of ['sessions', 'archived_sessions']) {
    try {
      const files = await readdir(join(home, directory), { recursive: true })
      if (files.some((file) => file.endsWith(`-${id}.jsonl`))) return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

export async function runCodex<T>(options: {
  cwd: string
  home: string
  workDir: string
  prompt: string
  resultSchema: z.ZodType<T>
  model: string
  effort: string
  sessionId?: string
  extraDirs?: string[]
  readOnly?: boolean
  signal: AbortSignal
  onSession: (id: string) => void
  workerIds?: (result: T) => string[]
  binary?: string
}): Promise<T> {
  await mkdir(options.workDir, { recursive: true })
  const schemaPath = join(options.workDir, 'schema.json')
  const outputPath = join(options.workDir, 'result.json')
  await writeFile(schemaPath, JSON.stringify(schema.toJSONSchema(options.resultSchema)))
  // A prior output must never make a failed/resumed process appear successful.
  const { rm } = await import('node:fs/promises')
  await rm(outputPath, { force: true })
  const policy = [
    '-c',
    'approval_policy="never"',
    '-c',
    `sandbox_mode="${options.readOnly ? 'read-only' : 'workspace-write'}"`,
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([options.cwd, ...(options.extraDirs ?? [])])}`,
    '-c',
    'features.multi_agent=true',
    '-c',
    'agents.max_threads=4',
    '-c',
    'agents.max_depth=1',
    '-c',
    `model_reasoning_effort=${JSON.stringify(options.effort)}`,
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'cli_auth_credentials_store="file"',
  ]
  const sessionId = await availableSession(options.home, options.sessionId)
  await writeFile(
    join(options.workDir, 'session-recovery.json'),
    JSON.stringify({
      requested: options.sessionId ?? null,
      resumed: sessionId ?? null,
      reconstructed: !!options.sessionId && !sessionId,
    }),
  )
  const args = [
    options.binary ?? 'codex',
    ...policy,
    'exec',
    ...(sessionId ? ['resume', sessionId] : []),
    '--model',
    options.model,
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '-',
  ]
  let eventError = ''
  const pending = new Set<string>()
  const workers = new Map<string, string>()
  const completed = new Set<string>()
  const result = await command(args, {
    cwd: options.cwd,
    env: { ...childEnvironment(), CODEX_HOME: options.home },
    signal: options.signal,
    input: options.prompt,
    onLine(line) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'thread.started' && typeof event.thread_id === 'string')
          options.onSession(event.thread_id)
        if (event.type === 'error' || event.type === 'turn.failed')
          eventError += JSON.stringify(event)
        const item = event.item
        if (['command_execution', 'collab_tool_call'].includes(item?.type)) {
          if (event.type === 'item.started' || item.status === 'in_progress') pending.add(item.id)
          else if (event.type === 'item.completed') pending.delete(item.id)
        }
        if (item?.type === 'collab_tool_call') {
          for (const id of item.receiver_thread_ids ?? []) {
            if (!workers.has(id)) workers.set(id, 'pending_init')
          }
          for (const [id, state] of Object.entries(item.agents_states ?? {})) {
            const status = (state as { status: string }).status
            workers.set(id, status)
            if (status === 'completed') completed.add(id)
            else if (status !== 'shutdown') completed.delete(id)
          }
        }
      } catch {
        /* non-JSON diagnostics are not workflow results */
      }
    },
  })
  // Raw transcripts remain only in the encrypted checkpoint, never stdout.
  await writeFile(join(options.workDir, 'execution.jsonl'), result.stdout)
  await writeFile(join(options.workDir, 'stderr.txt'), result.stderr)
  if (options.signal.aborted) throw new Interrupted('time', 'Execution window ended.')
  const failure = classifyFailure(`${eventError}\n${result.stderr}`)
  if (failure) throw failure
  if (
    /model_not_found|model[^\n]*(?:not available|not supported|does not exist)|unsupported[^\n]*(?:model|reasoning)/i.test(
      `${eventError}\n${result.stderr}`,
    )
  )
    throw new Error(
      `Configured Codex model ${options.model} or reasoning effort ${options.effort} is unavailable; check repository variables and subscription access.`,
    )
  if (result.code !== 0 || eventError)
    throw new Error(`Codex stage failed (exit ${result.code}); see encrypted execution records.`)
  if (
    pending.size ||
    [...workers.values()].some((status) =>
      ['pending_init', 'running', 'interrupted'].includes(status),
    )
  )
    throw new Error('Codex returned with unfinished commands or native workers.')
  let report: T
  try {
    report = options.resultSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
  } catch {
    throw new Error('Codex did not produce a valid, complete structured report.')
  }
  if (options.workerIds) {
    const ids = options.workerIds(report)
    if (new Set(ids).size !== ids.length || ids.some((id) => !completed.has(id)))
      throw new Error('Worker reports lack matching native Codex completion events.')
  }
  return report
}
