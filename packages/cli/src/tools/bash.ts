import { z } from 'zod'
import { spawn } from 'node:child_process'
import { type Result, ok, err } from '@src/types'
import type { ToolTier, TypedToolExecute } from './types'
import type { ToolExecutionContext } from './types'
import { scrubToolEnv } from './env'

export const name = 'bash'

export const description =
  'Execute a shell command and return its stdout, stderr, and exit code. ' +
  'Commands are run in a child process with an optional timeout (default 30 s).'

export const schema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().positive().optional().default(30).describe('Timeout in seconds (default 30)'),
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

const READ_ONLY_COMMANDS = new Set([
  'awk',
  'basename',
  'cat',
  'cd',
  'date',
  'dirname',
  'du',
  'echo',
  'env',
  'false',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'pwd',
  'printf',
  'rg',
  'sed',
  'stat',
  'tail',
  'test',
  'true',
  'uname',
  'wc',
  'which',
  'whoami',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
])

const SYSTEM_LEVEL_COMMANDS = new Set([
  'apt',
  'apt-get',
  'brew',
  'chgrp',
  'chmod',
  'chown',
  'curl',
  'dnf',
  'doas',
  'launchctl',
  'npm',
  'pnpm',
  'sudo',
  'su',
  'wget',
  'yarn',
  'yum',
])

const SHELL_CONTROL_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
])

const READ_ONLY_SED_FLAGS = new Set(['-E', '-e', '-n', '-r', '-u'])
const REDIRECT_TO_FILE = /(?:^|\s)(?:\d?>|>>|&>|<>)\s*(?!&|\d)/
const COMMAND_SUBSTITUTION = /\$\(|`/

export function resolveTier(args: unknown): ToolTier {
  const command =
    typeof args === 'object' && args !== null ? (args as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return 1

  return classifyBashCommand(command)
}

export function classifyBashCommand(command: string): ToolTier {
  const trimmed = command.trim()
  if (!trimmed) return 0
  if (COMMAND_SUBSTITUTION.test(trimmed) || REDIRECT_TO_FILE.test(trimmed) || isHereDoc(trimmed)) {
    return 1
  }

  const tokens = tokenizeShellLike(trimmed)
  if (tokens.length === 0) return 0

  let currentCommand: string[] = []
  let highestTier: ToolTier = 0

  for (const token of tokens) {
    if (isCommandSeparator(token)) {
      highestTier = maxTier(highestTier, classifySimpleCommand(currentCommand))
      currentCommand = []
      continue
    }
    currentCommand.push(token)
  }

  return maxTier(highestTier, classifySimpleCommand(currentCommand))
}

function classifySimpleCommand(tokens: string[]): ToolTier {
  const command = firstCommandWord(tokens)
  if (!command) return 0
  const base = command.split('/').pop() ?? command

  if (base === 'bun') {
    const subcommand = nextNonOption(tokens, 1)
    return subcommand === 'install' || subcommand === 'add' || subcommand === 'remove' ? 4 : 1
  }

  if (SYSTEM_LEVEL_COMMANDS.has(base)) return 4

  if (base === 'git') {
    const subcommand = nextNonOption(tokens, 1)
    return subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ? 0 : 1
  }

  if (base === 'sed' && tokens.some((token) => token === '-i' || token.startsWith('-i'))) {
    return 1
  }

  if (
    base === 'sed' &&
    !tokens
      .slice(1)
      .every((token) => (token.startsWith('-') ? READ_ONLY_SED_FLAGS.has(token) : true))
  ) {
    return 1
  }

  return READ_ONLY_COMMANDS.has(base) ? 0 : 1
}

function firstCommandWord(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (SHELL_CONTROL_WORDS.has(token) || token.includes('=')) continue
    return token
  }
  return undefined
}

function nextNonOption(tokens: string[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token || token.includes('=')) continue
    if (token === '--') return tokens[index + 1]
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

function maxTier(left: ToolTier, right: ToolTier): ToolTier {
  return left > right ? left : right
}

function isCommandSeparator(token: string): boolean {
  return token === '|' || token === '||' || token === '&&' || token === ';'
}

function isHereDoc(command: string): boolean {
  return /<<-?\s*\S+/.test(command)
}

function tokenizeShellLike(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < command.length; index++) {
    const char = command[index]

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    const twoChar = command.slice(index, index + 2)
    if (twoChar === '&&' || twoChar === '||' || twoChar === '>>' || twoChar === '<>') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      tokens.push(twoChar)
      index++
      continue
    }

    if (char === '|' || char === ';' || char === '<' || char === '>') {
      if (current) {
        tokens.push(current)
        current = ''
      }
      tokens.push(char)
      continue
    }

    if (char === '\\' && index + 1 < command.length) {
      current += command[index + 1]
      index++
      continue
    }

    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

export const execute: TypedToolExecute<typeof schema, BashResult> = async (
  args,
  context?: ToolExecutionContext,
): Promise<Result<BashResult>> => {
  const { command, timeout, cwd } = args
  const timeoutMs = timeout * 1000

  if (context?.abortSignal?.aborted) {
    return err(new Error('Command cancelled by user before it could start'))
  }

  const filteredEnv = scrubToolEnv()

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let killed = false
    let aborted = false
    let settled = false

    const child = spawn('sh', ['-c', command], {
      cwd: cwd ?? process.cwd(),
      env: filteredEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    // SIGKILL on the shell alone leaves orphaned grandchildren holding the
    // stdio pipes open, so 'close' never fires. detached + negative pid
    // signals the whole process group.
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // Process group already gone — nothing to do.
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      killed = true
      killGroup('SIGKILL')
    }, timeoutMs)

    const onAbort = () => {
      aborted = true
      killGroup('SIGKILL')
    }
    context?.abortSignal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        context?.abortSignal?.removeEventListener('abort', onAbort)
        resolve(err(new Error(`Failed to spawn command: ${error.message}`)))
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        context?.abortSignal?.removeEventListener('abort', onAbort)
        if (aborted) {
          resolve(err(new Error('Command cancelled by user')))
        } else if (killed) {
          resolve(err(new Error(`Command timed out after ${timeout}s and was killed`)))
        } else {
          resolve(ok({ stdout, stderr, exitCode: code ?? 1 }))
        }
      }
    })
  })
}
export const tier = 1
