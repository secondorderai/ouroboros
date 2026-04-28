import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '@src/config'
import { buildVerifyPlan } from '../../../scripts/verify'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const ROOT_PACKAGE_JSON = join(REPO_ROOT, 'package.json')

interface RootPackageJson {
  scripts?: Record<string, string>
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

async function runRootDevInPty(): Promise<{ output: string }> {
  const innerCmd = `cd "${REPO_ROOT}" && bun run dev`
  // BSD script (macOS) takes `[file] [command...]`; util-linux script (Linux)
  // requires `-c <command>` with the typescript file as the only positional.
  const args =
    process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', 'sh', '-lc', innerCmd]
      : ['script', '-qfc', `sh -lc ${JSON.stringify(innerCmd)}`, '/dev/null']

  const proc = Bun.spawn(args, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // The CLI exits before printing its banner if the configured provider
    // has no API key. CI runs without a checked-in `.ouroboros`, so the
    // default `anthropic` provider needs a stub key for the REPL to start.
    // Existing keys from the parent env take precedence.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'test-key',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'test-key',
      OUROBOROS_OPENAI_COMPATIBLE_API_KEY:
        process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY ?? 'test-key',
    },
  })

  // The REPL is interactive and only exits on stdin EOF. BSD `script`
  // forwards EOF to its child; util-linux `script` does not, so the process
  // would otherwise hang indefinitely on Linux. Drain output and, once the
  // banner has been printed, give the REPL a beat to flush its `> ` prompt
  // before killing it.
  let output = ''
  let killTimer: ReturnType<typeof setTimeout> | null = null
  const decoder = new TextDecoder()
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value) output += decoder.decode(value, { stream: true })
        if (killTimer === null && output.includes('Type your message')) {
          killTimer = setTimeout(() => proc.kill(), 500)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  const deadline = setTimeout(() => proc.kill(), 10_000)
  try {
    await Promise.all([
      drain(proc.stdout as ReadableStream<Uint8Array>),
      drain(proc.stderr as ReadableStream<Uint8Array>),
    ])
    await proc.exited
  } finally {
    clearTimeout(deadline)
    if (killTimer) clearTimeout(killTimer)
  }

  return { output }
}

async function runCliPackageDevCommand(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const quotedArgs = args.map((arg) => JSON.stringify(arg)).join(' ')
  const proc = Bun.spawn(
    ['sh', '-lc', `cd "${join(REPO_ROOT, 'packages', 'cli')}" && bun run dev -- ${quotedArgs}`],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...env,
      },
    },
  )

  const timeout = setTimeout(() => {
    proc.kill()
  }, 15_000)

  const exitCode = await proc.exited
  clearTimeout(timeout)

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  return { stdout, stderr, exitCode }
}

describe('root dev workflow regressions', () => {
  test('root package dev script delegates directly into the CLI package', () => {
    const pkg = readJsonFile<RootPackageJson>(ROOT_PACKAGE_JSON)
    const devScript = pkg.scripts?.dev

    expect(typeof devScript).toBe('string')
    expect(devScript).toContain('cd packages/cli')
    expect(devScript).toContain('bun run dev')
    expect(devScript).not.toContain('--filter @ouroboros/cli')
  })

  test('bun run dev from repo root enters the REPL and uses the repo config', async () => {
    if (process.platform === 'win32') {
      return
    }

    const configResult = loadConfig(join(REPO_ROOT, 'packages', 'cli'))
    expect(configResult.ok).toBe(true)
    if (!configResult.ok) return

    const provider = configResult.value.model.provider
    const model = configResult.value.model.name

    expect(typeof provider).toBe('string')
    expect(typeof model).toBe('string')

    const { output } = await runRootDevInPty()

    expect(output).toContain('Ouroboros v0.1.0')
    expect(output).toContain(`Model: ${provider}/${model}`)
    expect(output).toContain('Type your message. Ctrl+C to cancel, Ctrl+C twice to exit.')
    expect(output).toContain('> ')
    expect(output).not.toContain('How can I help?')
    expect(output).not.toContain('Hi — what would you like me to do?')
    expect(output).not.toContain('Usage:')
  })

  test('packages/cli bun run dev -- auth list runs once instead of staying in watch mode', async () => {
    if (process.platform === 'win32') {
      return
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'ouroboros-auth-list-'))
    const authFile = join(tempDir, 'auth.json')

    const result = await runCliPackageDevCommand(['auth', 'list'], {
      OUROBOROS_AUTH_FILE: authFile,
    })
    const combined = result.stdout + result.stderr

    expect(result.exitCode).toBe(0)
    expect(combined).toContain('No stored provider authentication.')
    expect(combined).not.toContain('Ouroboros v0.1.0')
    expect(combined).not.toContain('Type your message. Ctrl+C to cancel, Ctrl+C twice to exit.')
  })
})

describe('root verify workflow regressions', () => {
  test('root verify script uses the Bun runner so extra args are not forwarded to Playwright', () => {
    const pkg = readJsonFile<RootPackageJson>(ROOT_PACKAGE_JSON)
    const verifyScript = pkg.scripts?.verify

    expect(verifyScript).toBe('bun scripts/verify.ts')

    const plan = buildVerifyPlan(['test:desktop'])

    expect(plan.ignoredArgs).toEqual(['test:desktop'])
    expect(plan.steps.map((step) => step.command.join(' '))).toEqual([
      'bun run lint',
      'bun run ts-check',
      'bun run test:all',
    ])
  })

  test('root desktop tests build the Electron app before launching Playwright', () => {
    const pkg = readJsonFile<RootPackageJson>(ROOT_PACKAGE_JSON)
    const desktopTestScript = pkg.scripts?.['test:desktop']

    expect(typeof desktopTestScript).toBe('string')
    if (typeof desktopTestScript !== 'string') return

    expect(desktopTestScript).toContain('build:vite')
    expect(desktopTestScript).toContain('test:e2e')
    expect(desktopTestScript.indexOf('build:vite')).toBeLessThan(
      desktopTestScript.indexOf('test:e2e'),
    )
  })
})
