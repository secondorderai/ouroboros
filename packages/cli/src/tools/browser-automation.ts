import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { type Result, err, ok } from '@src/types'
import type { ToolExecutionContext, ToolTier, TypedToolExecute } from './types'
import { scrubToolEnv } from './env'

export const name = 'browser-automation'

export const description =
  'Automate a Chrome-compatible browser with the bundled Vercel Agent Browser CLI. ' +
  'Use this for web navigation, snapshots, clicking refs, form filling, keyboard input, ' +
  'tabs, and CDP auto-connect diagnostics without asking users to install npm packages.'

const actionSchema = z.enum([
  'help',
  'doctor',
  'connect',
  'open',
  'snapshot',
  'click',
  'fill',
  'press',
  'wait',
  'tab',
  'close',
])

export const schema = z
  .object({
    action: actionSchema.describe('Agent Browser action to run'),
    url: z.string().min(1).optional().describe('URL for open'),
    ref: z.string().min(1).optional().describe('Element ref such as @e1 for click/fill'),
    text: z.string().optional().describe('Text for fill'),
    key: z.string().min(1).optional().describe('Keyboard key or chord for press'),
    cdp: z
      .union([z.string().min(1), z.number().int().positive()])
      .optional()
      .describe('CDP port or WebSocket URL. Omit when using auto-connect.'),
    autoConnect: z
      .boolean()
      .optional()
      .default(true)
      .describe('Use Agent Browser CDP auto-connect when cdp is not provided. Defaults to true.'),
    json: z.boolean().optional().default(false).describe('Request JSON output where supported'),
    session: z.string().min(1).optional().describe('Agent Browser session name'),
    profile: z.string().min(1).optional().describe('Persistent browser profile path'),
    interactive: z
      .boolean()
      .optional()
      .default(true)
      .describe('For snapshot, include interactive element refs by default'),
    timeout: z.number().positive().optional().default(30).describe('Timeout in seconds'),
  })
  .refine((data) => data.action !== 'open' || data.url, {
    message: 'url is required for open',
    path: ['url'],
  })
  .refine((data) => !['click', 'fill'].includes(data.action) || data.ref, {
    message: 'ref is required for click and fill',
    path: ['ref'],
  })
  .refine((data) => data.action !== 'fill' || data.text !== undefined, {
    message: 'text is required for fill',
    path: ['text'],
  })
  .refine((data) => data.action !== 'press' || data.key, {
    message: 'key is required for press',
    path: ['key'],
  })

export interface BrowserAutomationResult {
  command: string[]
  stdout: string
  stderr: string
  exitCode: number
  remediation?: string
}

const READ_ONLY_ACTIONS = new Set<z.infer<typeof actionSchema>>([
  'help',
  'doctor',
  'snapshot',
  'tab',
])
const INTERACTIVE_ACTIONS = new Set<z.infer<typeof actionSchema>>([
  'open',
  'connect',
  'click',
  'fill',
  'press',
  'wait',
  'close',
])

export function resolveTier(args: unknown): ToolTier {
  const action =
    typeof args === 'object' && args !== null ? (args as { action?: unknown }).action : undefined
  if (typeof action !== 'string') return 1
  if (READ_ONLY_ACTIONS.has(action as z.infer<typeof actionSchema>)) return 0
  if (INTERACTIVE_ACTIONS.has(action as z.infer<typeof actionSchema>)) return 1
  return 1
}

export function resolveAgentBrowserBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.OUROBOROS_AGENT_BROWSER_BIN?.trim() || 'agent-browser'
}

function resolveManagedCdp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cdp = env.OUROBOROS_AGENT_BROWSER_CDP?.trim()
  if (cdp && cdp.length > 0) return cdp

  const cdpFile = env.OUROBOROS_AGENT_BROWSER_CDP_FILE?.trim()
  if (!cdpFile) return undefined

  try {
    const parsed = JSON.parse(readFileSync(cdpFile, 'utf8')) as { port?: unknown; cdp?: unknown }
    const fileCdp = parsed.cdp ?? parsed.port
    if (typeof fileCdp === 'string' && fileCdp.trim().length > 0) return fileCdp.trim()
    if (typeof fileCdp === 'number' && Number.isInteger(fileCdp) && fileCdp > 0) {
      return String(fileCdp)
    }
  } catch {
    return undefined
  }

  return undefined
}

function resolveRequestedCdp(
  args: z.infer<typeof schema>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (args.cdp !== undefined) return String(args.cdp)
  return resolveManagedCdp(env)
}

function getAgentBrowserDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.OUROBOROS_AGENT_BROWSER_DIR?.trim()
  return dir && dir.length > 0 ? dir : undefined
}

function isMissingBinary(binary: string): boolean {
  return binary.includes('/') && !existsSync(binary)
}

export function buildAgentBrowserArgs(
  args: z.infer<typeof schema>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (args.action === 'help') return ['--help']

  const commandArgs: string[] = []
  const requestedCdp = resolveRequestedCdp(args, env)

  if (requestedCdp) {
    commandArgs.push('--cdp', requestedCdp)
  } else if (args.autoConnect) {
    commandArgs.push('--auto-connect')
  }

  if (args.json) commandArgs.push('--json')
  if (args.session) commandArgs.push('--session', args.session)
  if (args.profile) commandArgs.push('--profile', args.profile)

  switch (args.action) {
    case 'doctor':
      return ['doctor', '--offline', '--quick']
    case 'connect':
      return ['connect', String(requestedCdp ?? 9222)]
    case 'open':
      return [...commandArgs, 'open', args.url ?? 'about:blank']
    case 'snapshot':
      return [...commandArgs, 'snapshot', ...(args.interactive ? ['-i'] : [])]
    case 'click':
      return [...commandArgs, 'click', args.ref ?? '']
    case 'fill':
      return [...commandArgs, 'fill', args.ref ?? '', args.text ?? '']
    case 'press':
      return [...commandArgs, 'press', args.key ?? '']
    case 'wait':
      return [...commandArgs, 'wait']
    case 'tab':
      return [...commandArgs, 'tab']
    case 'close':
      return [...commandArgs, 'close']
  }
}

export const CHROME_CDP_REMEDIATION = [
  'Agent Browser could not connect to a Chrome-compatible browser.',
  'Ask the user to open Settings -> Automation Browser -> Launch Automation Browser.',
  'If Chrome is not installed, ask them to install Google Chrome from https://www.google.com/chrome/ first.',
  'After the Automation Browser is running, retry the browser automation request.',
].join('\n')

function shouldAttachRemediation(stderr: string, stdout: string, exitCode: number): boolean {
  if (exitCode === 0) return false
  const output = `${stderr}\n${stdout}`.toLowerCase()
  return (
    output.includes('auto-connect') ||
    output.includes('cdp') ||
    output.includes('devtoolsactiveport') ||
    output.includes('connection refused') ||
    output.includes('could not connect') ||
    output.includes('chrome')
  )
}

function buildToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered = scrubToolEnv()
  const agentBrowserDir = getAgentBrowserDir(env)
  if (!agentBrowserDir) return filtered
  const agentBrowserBinDir = join(agentBrowserDir, 'bin')
  return {
    ...filtered,
    PATH: [agentBrowserBinDir, filtered.PATH].filter(Boolean).join(delimiter),
    OUROBOROS_AGENT_BROWSER_DIR: agentBrowserDir,
    ...(env.OUROBOROS_AGENT_BROWSER_BIN
      ? { OUROBOROS_AGENT_BROWSER_BIN: env.OUROBOROS_AGENT_BROWSER_BIN }
      : {}),
    ...(env.OUROBOROS_AGENT_BROWSER_CDP
      ? { OUROBOROS_AGENT_BROWSER_CDP: env.OUROBOROS_AGENT_BROWSER_CDP }
      : {}),
    ...(env.OUROBOROS_AGENT_BROWSER_CDP_FILE
      ? { OUROBOROS_AGENT_BROWSER_CDP_FILE: env.OUROBOROS_AGENT_BROWSER_CDP_FILE }
      : {}),
  }
}

function needsCdpPreconnect(args: z.infer<typeof schema>, cdp: string | undefined): cdp is string {
  return Boolean(cdp && !['help', 'doctor', 'connect'].includes(args.action))
}

function runAgentBrowserCommand(
  binary: string,
  commandArgs: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<Result<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let killed = false
    let aborted = false
    let settled = false

    const child = spawn(binary, commandArgs, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      child.kill('SIGKILL')
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      if ('code' in error && error.code === 'ENOENT') {
        resolve(
          ok({
            stdout: '',
            stderr: `Agent Browser executable was not found: ${binary}`,
            exitCode: 127,
            timedOut: false,
          }),
        )
        return
      }
      resolve(err(new Error(`Failed to spawn Agent Browser: ${error.message}`)))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      if (aborted) {
        resolve(err(new Error('Browser automation cancelled by user')))
        return
      }

      resolve(ok({ stdout, stderr, exitCode: code ?? 1, timedOut: killed }))
    })
  })
}

export const execute: TypedToolExecute<typeof schema, BrowserAutomationResult> = async (
  args,
  context?: ToolExecutionContext,
): Promise<Result<BrowserAutomationResult>> => {
  if (context?.abortSignal?.aborted) {
    return err(new Error('Browser automation cancelled by user before it could start'))
  }

  const binary = resolveAgentBrowserBinary()
  if (isMissingBinary(binary)) {
    return ok({
      command: [binary],
      stdout: '',
      stderr: `Bundled Agent Browser executable was not found at ${binary}`,
      exitCode: 127,
      remediation:
        'Browser automation is unavailable because the Agent Browser binary is missing from the Ouroboros app bundle. Update or reinstall Ouroboros, then retry.',
    })
  }

  const commandArgs = buildAgentBrowserArgs(args)
  const timeoutMs = args.timeout * 1000
  const cdp = resolveRequestedCdp(args)
  const preconnectArgs = needsCdpPreconnect(args, cdp) ? ['connect', cdp] : undefined
  const command = preconnectArgs
    ? [binary, ...preconnectArgs, '&&', binary, ...commandArgs]
    : [binary, ...commandArgs]
  const toolEnv = buildToolEnv(process.env)

  if (preconnectArgs) {
    const preconnect = await runAgentBrowserCommand(
      binary,
      preconnectArgs,
      toolEnv,
      timeoutMs,
      context?.abortSignal,
    )
    if (!preconnect.ok) return preconnect
    if (preconnect.value.timedOut) {
      return err(new Error(`Browser automation timed out after ${args.timeout}s and was killed`))
    }
    if (preconnect.value.exitCode !== 0) {
      return ok({
        command,
        stdout: preconnect.value.stdout,
        stderr: preconnect.value.stderr,
        exitCode: preconnect.value.exitCode,
        ...(shouldAttachRemediation(
          preconnect.value.stderr,
          preconnect.value.stdout,
          preconnect.value.exitCode,
        )
          ? { remediation: CHROME_CDP_REMEDIATION }
          : {}),
      })
    }
  }

  const result = await runAgentBrowserCommand(
    binary,
    commandArgs,
    toolEnv,
    timeoutMs,
    context?.abortSignal,
  )
  if (!result.ok) return result
  if (result.value.timedOut) {
    return err(new Error(`Browser automation timed out after ${args.timeout}s and was killed`))
  }

  const { stdout, stderr, exitCode } = result.value
  return ok({
    command,
    stdout,
    stderr,
    exitCode,
    ...(shouldAttachRemediation(stderr, stdout, exitCode)
      ? { remediation: CHROME_CDP_REMEDIATION }
      : {}),
  })
}

export const tier = 0
