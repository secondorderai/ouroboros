import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const ROOT_PACKAGE_JSON = join(REPO_ROOT, 'package.json')
const ROOT_CONFIG_JSON = join(REPO_ROOT, '.ouroboros')

interface RootPackageJson {
  scripts?: Record<string, string>
}

interface RootConfig {
  model?: {
    provider?: string
    name?: string
  }
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

    const config = readJsonFile<RootConfig>(ROOT_CONFIG_JSON)
    const provider = config.model?.provider
    const model = config.model?.name

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
})
