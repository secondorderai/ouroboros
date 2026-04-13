import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '@src/config'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const ROOT_PACKAGE_JSON = join(REPO_ROOT, 'package.json')

interface RootPackageJson {
  scripts?: Record<string, string>
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

async function runRootDevInPty(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    ['script', '-q', '/dev/null', 'sh', '-lc', `cd "${REPO_ROOT}" && bun run dev`],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
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

    const result = await runRootDevInPty()
    const combined = result.stdout + result.stderr

    expect(result.exitCode).toBe(0)
    expect(combined).toContain('Ouroboros v0.1.0')
    expect(combined).toContain(`Model: ${provider}/${model}`)
    expect(combined).toContain('Type your message. Ctrl+C to cancel, Ctrl+C twice to exit.')
    expect(combined).toContain('> ')
    expect(combined).not.toContain('How can I help?')
    expect(combined).not.toContain('Hi — what would you like me to do?')
    expect(combined).not.toContain('Usage:')
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
