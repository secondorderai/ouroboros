import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fixtureDir = resolve(import.meta.dir, 'fixtures/automation-browser')

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return join(fixtureDir, 'user-data')
      return fixtureDir
    },
  },
  dialog: { showErrorBox: () => {} },
}))

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null
  killed = false

  kill(signal?: string): boolean {
    this.killed = true
    this.exitCode = signal === 'SIGKILL' ? 137 : 0
    queueMicrotask(() => this.emit('exit', this.exitCode, signal ?? null))
    return true
  }
}

function createChromeOnPath(): { chromePath: string; env: NodeJS.ProcessEnv } {
  const binDir = join(fixtureDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const chromePath = join(binDir, 'google-chrome')
  writeFileSync(chromePath, '', 'utf8')
  return { chromePath, env: { PATH: binDir, HOME: fixtureDir } }
}

describe('AutomationBrowserManager', () => {
  beforeEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
    mkdirSync(fixtureDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test('detects Chrome from PATH', async () => {
    const { chromePath, env } = createChromeOnPath()
    const { findChromeExecutable } = await import('../src/main/automation-browser')

    expect(findChromeExecutable('linux', env)).toBe(chromePath)
  })

  test('launches managed profile with remote debugging flags', async () => {
    const { chromePath, env } = createChromeOnPath()
    const calls: Array<{ command: string; args: string[] }> = []
    const child = new FakeChildProcess()
    const { AutomationBrowserManager } = await import('../src/main/automation-browser')
    const manager = new AutomationBrowserManager({
      platform: 'linux',
      env,
      appGetPath: () => join(fixtureDir, 'user-data'),
      allocatePort: async () => 9333,
      fetchVersion: async () => true,
      spawnProcess: ((command: string, args: string[]) => {
        calls.push({ command, args })
        return child
      }) as never,
    })

    const status = await manager.launch({ profileMode: 'managed-profile' })

    expect(status.state).toBe('running')
    expect(status.port).toBe(9333)
    expect(status.chromePath).toBe(chromePath)
    expect(JSON.parse(readFileSync(manager.getCdpStatePath(), 'utf8'))).toEqual({ port: 9333 })
    expect(calls[0].args).toContain('--remote-debugging-port=9333')
    expect(calls[0].args).toContain('--no-first-run')
    expect(calls[0].args).toContain('--no-default-browser-check')
    expect(calls[0].args).toContain(
      `--user-data-dir=${join(fixtureDir, 'user-data', 'automation-browser-profile')}`,
    )
  })

  test('launches default profile without overriding user-data-dir', async () => {
    const { env } = createChromeOnPath()
    const calls: string[][] = []
    const { AutomationBrowserManager } = await import('../src/main/automation-browser')
    const manager = new AutomationBrowserManager({
      platform: 'linux',
      env,
      allocatePort: async () => 9444,
      fetchVersion: async () => true,
      spawnProcess: ((_command: string, args: string[]) => {
        calls.push(args)
        return new FakeChildProcess()
      }) as never,
    })

    await manager.launch({ profileMode: 'default-profile' })

    expect(calls[0].some((arg) => arg.startsWith('--user-data-dir='))).toBe(false)
  })

  test('returns error when Chrome is missing', async () => {
    const { AutomationBrowserManager } = await import('../src/main/automation-browser')
    const manager = new AutomationBrowserManager({
      platform: 'linux',
      env: { PATH: join(fixtureDir, 'missing') },
    })

    const status = await manager.launch({ profileMode: 'managed-profile' })

    expect(status.state).toBe('error')
    expect(status.errorMessage).toContain('Google Chrome was not found')
  })

  test('reports CDP readiness failure and kills launched process', async () => {
    const { env } = createChromeOnPath()
    const child = new FakeChildProcess()
    const { AutomationBrowserManager } = await import('../src/main/automation-browser')
    const manager = new AutomationBrowserManager({
      platform: 'linux',
      env,
      allocatePort: async () => 9555,
      fetchVersion: async () => false,
      spawnProcess: (() => child) as never,
    })

    const status = await manager.launch({ profileMode: 'default-profile' })

    expect(status.state).toBe('error')
    expect(status.errorMessage).toContain('debugging port')
    expect(child.killed).toBe(true)
  })

  test('stop kills only the managed process and returns stopped', async () => {
    const { env } = createChromeOnPath()
    const child = new FakeChildProcess()
    const { AutomationBrowserManager } = await import('../src/main/automation-browser')
    const manager = new AutomationBrowserManager({
      platform: 'linux',
      env,
      allocatePort: async () => 9666,
      fetchVersion: async () => true,
      spawnProcess: (() => child) as never,
    })

    await manager.launch({ profileMode: 'managed-profile' })
    const status = await manager.stop()

    expect(status.state).toBe('stopped')
    expect(child.killed).toBe(true)
    expect(existsSync(manager.getCdpStatePath())).toBe(false)
  })
})
