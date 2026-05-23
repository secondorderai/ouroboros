import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import type {
  AutomationBrowserLaunchParams,
  AutomationBrowserProfileMode,
  AutomationBrowserStatus,
} from '../shared/protocol'

const CDP_READY_TIMEOUT_MS = 8_000
const CDP_POLL_INTERVAL_MS = 200

export interface AutomationBrowserManagerOptions {
  appGetPath?: (name: string) => string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
  fetchVersion?: (port: number) => Promise<boolean>
  allocatePort?: () => Promise<number>
}

export class AutomationBrowserManager extends EventEmitter {
  private status: AutomationBrowserStatus = { state: 'stopped' }
  private process: ChildProcess | null = null
  private readonly appGetPath: (name: string) => string
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly spawnProcess: typeof spawn
  private readonly fetchVersion: (port: number) => Promise<boolean>
  private readonly allocatePortFn: () => Promise<number>
  private readonly cdpStatePath: string

  constructor(options: AutomationBrowserManagerOptions = {}) {
    super()
    this.appGetPath =
      options.appGetPath ?? ((name) => app.getPath(name as Parameters<typeof app.getPath>[0]))
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.spawnProcess = options.spawnProcess ?? spawn
    this.fetchVersion = options.fetchVersion ?? waitForCdpVersion
    this.allocatePortFn = options.allocatePort ?? allocatePort
    this.cdpStatePath = join(this.appGetPath('userData'), 'automation-browser-cdp.json')
  }

  getStatus(): AutomationBrowserStatus {
    return { ...this.status }
  }

  getCdpPort(): number | undefined {
    return this.status.state === 'running' ? this.status.port : undefined
  }

  getCdpStatePath(): string {
    return this.cdpStatePath
  }

  async launch(params: AutomationBrowserLaunchParams): Promise<AutomationBrowserStatus> {
    if (this.status.state === 'running' || this.status.state === 'starting') {
      return this.getStatus()
    }

    const chromePath = findChromeExecutable(this.platform, this.env)
    if (!chromePath) {
      return this.setStatus({
        state: 'error',
        errorMessage:
          'Google Chrome was not found. Install Chrome from https://www.google.com/chrome/, then retry.',
      })
    }

    const port = await this.allocatePortFn()
    const profileMode = params.profileMode
    this.setStatus({ state: 'starting', chromePath, port, profileMode })

    const args = buildChromeLaunchArgs({
      port,
      profileMode,
      userDataDir: join(this.appGetPath('userData'), 'automation-browser-profile'),
    })

    try {
      this.process = this.spawnProcess(chromePath, args, {
        detached: false,
        stdio: 'ignore',
        env: this.env,
      })
    } catch (error) {
      return this.setStatus({
        state: 'error',
        chromePath,
        port,
        profileMode,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }

    this.process.once('exit', () => {
      this.process = null
      if (this.status.state !== 'stopping') {
        this.setStatus({ state: 'stopped', chromePath, profileMode })
      }
    })

    const ready = await this.fetchVersion(port)
    if (!ready) {
      this.process?.kill()
      this.process = null
      this.clearCdpState()
      return this.setStatus({
        state: 'error',
        chromePath,
        port,
        profileMode,
        errorMessage:
          'Chrome started, but the automation debugging port did not become available. If using My Chrome profile, close existing Chrome windows and try again.',
      })
    }

    this.writeCdpState(port)
    return this.setStatus({ state: 'running', chromePath, port, profileMode })
  }

  async stop(): Promise<AutomationBrowserStatus> {
    if (!this.process) {
      return this.setStatus({ state: 'stopped' })
    }

    const previous = this.getStatus()
    this.setStatus({ ...previous, state: 'stopping' })
    const proc = this.process

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }, 3_000)

      proc.once('exit', () => {
        clearTimeout(timer)
        this.process = null
        this.clearCdpState()
        resolve(this.setStatus({ state: 'stopped', chromePath: previous.chromePath }))
      })

      proc.kill('SIGTERM')
    })
  }

  private setStatus(status: AutomationBrowserStatus): AutomationBrowserStatus {
    this.status = status
    const snapshot = this.getStatus()
    this.emit('status', snapshot)
    return snapshot
  }

  private writeCdpState(port: number): void {
    mkdirSync(dirname(this.cdpStatePath), { recursive: true })
    writeFileSync(this.cdpStatePath, JSON.stringify({ port }, null, 2), 'utf8')
  }

  private clearCdpState(): void {
    rmSync(this.cdpStatePath, { force: true })
  }
}

export function buildChromeLaunchArgs(args: {
  port: number
  profileMode: AutomationBrowserProfileMode
  userDataDir: string
}): string[] {
  const launchArgs = [
    `--remote-debugging-port=${args.port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (args.profileMode === 'managed-profile') {
    mkdirSync(args.userDataDir, { recursive: true })
    launchArgs.push(`--user-data-dir=${args.userDataDir}`)
  }
  return launchArgs
}

export function findChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(env.HOME ?? '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : platform === 'win32'
        ? [
            join(env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }

  for (const executable of [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ]) {
    const found = findExecutableOnPath(executable, env.PATH)
    if (found) return found
  }

  return null
}

function findExecutableOnPath(executable: string, pathValue?: string): string | null {
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter)) {
    const candidate = join(dir, executable)
    if (existsSync(candidate)) return candidate
    if (process.platform === 'win32') {
      const winCandidate = `${candidate}.exe`
      if (existsSync(winCandidate)) return winCandidate
    }
  }
  return null
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate automation browser port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function waitForCdpVersion(port: number): Promise<boolean> {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return true
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS))
  }
  return false
}
