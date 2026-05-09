/**
 * CLI Process Manager
 *
 * Manages the Ouroboros CLI child process lifecycle: spawning, health
 * checking, restart-on-crash, and graceful shutdown. Communicates with
 * the CLI via JSON-RPC over stdin/stdout (NDJSON).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { EventEmitter } from 'node:events'
import type { CLIStatus, CLIStatusEvent } from '../shared/protocol'
import { writeTestLog } from './test-logging'
import { TEST_SCENARIO_PATH } from './test-paths'

// Cap on retained status transitions. The full lifecycle of a CLI process is
// a handful of events (`starting`/`ready`/`restarting`/...), so even a few
// thousand restarts stay well under this — but the bound prevents an
// unbounded crash loop from leaking memory.
const STATUS_HISTORY_LIMIT = 256

const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY_MS = 1000
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000
const MACOS_PACKAGED_CLI_BY_ARCH: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: 'ouroboros-darwin-arm64',
  x64: 'ouroboros-darwin-x64',
}

export type LineHandler = (line: string) => void

export interface CLIProcessManagerOptions {
  onStdoutLine: LineHandler
  onStderrLine?: LineHandler
  onStatusChange?: (status: CLIStatus) => void
  /** Extra environment variables to inject when spawning the CLI process (e.g. persisted API keys). */
  extraEnv?: Record<string, string>
}

export class CLIProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private stderrLog: string[] = []
  private restartCount = 0
  private intentionalShutdown = false
  private status: CLIStatus = 'starting'
  // Sequence-stamped history of every transition since the manager was
  // constructed. Renderers replay this on subscribe to recover transitions
  // that fired before they were ready to listen (e.g. the CLI reaches `ready`
  // a beat before the renderer mounts and registers its `onCLIStatus`
  // handler). Capped to keep memory bounded across long-lived sessions.
  private statusHistory: CLIStatusEvent[] = []
  private statusSeq = 0

  private readonly onStdoutLine: LineHandler
  private readonly onStderrLine: LineHandler
  private readonly onStatusChange: (status: CLIStatus) => void
  private extraEnv: Record<string, string>

  constructor(options: CLIProcessManagerOptions) {
    super()
    this.onStdoutLine = options.onStdoutLine
    this.onStderrLine = options.onStderrLine ?? (() => {})
    this.onStatusChange = options.onStatusChange ?? (() => {})
    this.extraEnv = options.extraEnv ?? {}
  }

  /** Update extra env vars (e.g. when API keys are saved). Applied on next spawn. */
  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env
  }

  start(): void {
    this.intentionalShutdown = false
    this.setStatus('starting')
    writeTestLog('cli process start()')
    this.spawnProcess()
  }

  writeLine(json: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('CLI process stdin is not writable')
    }
    this.process.stdin.write(json + '\n')
  }

  async shutdown(): Promise<void> {
    this.intentionalShutdown = true
    if (!this.process) return

    const proc = this.process
    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL')
        resolve()
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)

      proc.once('exit', () => {
        clearTimeout(forceKillTimer)
        resolve()
      })

      if (proc.stdin) proc.stdin.end()
      proc.kill('SIGTERM')
    })
  }

  getStatus(): CLIStatus { return this.status }
  getStatusHistory(): CLIStatusEvent[] { return [...this.statusHistory] }
  getStderrLog(): string[] { return [...this.stderrLog] }

  markReady(): void {
    this.setStatus('ready')
    this.restartCount = 0
  }

  markError(): void {
    this.setStatus('error')
  }

  private setStatus(status: CLIStatus): void {
    this.status = status
    this.statusSeq += 1
    const event: CLIStatusEvent = { seq: this.statusSeq, status }
    this.statusHistory.push(event)
    if (this.statusHistory.length > STATUS_HISTORY_LIMIT) {
      this.statusHistory.splice(0, this.statusHistory.length - STATUS_HISTORY_LIMIT)
    }
    this.onStatusChange(status)
    this.emit('status', event)
  }

  private getCliPath(): { command: string; args: string[] } {
    if (process.env.NODE_ENV === 'test') {
      const fixturePath = join(app.getAppPath(), '..', '..', 'tests', 'fixtures', 'mock-cli.mjs')
      return {
        command: process.env.OUROBOROS_TEST_NODE_BINARY ?? 'node',
        args: [fixturePath, '--json-rpc', ...this.getCliConfigArgs(), TEST_SCENARIO_PATH],
      }
    }

    const envPath = process.env.OUROBOROS_CLI_PATH
    if (envPath) {
      if (envPath.endsWith('.ts')) {
        return { command: 'bun', args: ['run', envPath, '--json-rpc', ...this.getCliConfigArgs()] }
      }
      return { command: envPath, args: ['--json-rpc', ...this.getCliConfigArgs()] }
    }

    if (app.isPackaged) {
      return {
        command: this.resolvePackagedCliPath(),
        args: ['--json-rpc', ...this.getCliConfigArgs()],
      }
    }

    return {
      command: join(app.getAppPath(), '..', 'cli', 'dist', process.platform === 'win32' ? 'ouroboros.exe' : 'ouroboros'),
      args: ['--json-rpc', ...this.getCliConfigArgs()],
    }
  }

  private spawnProcess(): void {
    const { command, args } = this.getCliPath()
    const cwd = this.getCliWorkingDirectory()
    mkdirSync(cwd, { recursive: true })
    writeTestLog(`spawning cli: ${command} ${args.join(' ')} cwd=${cwd}`)
    try {
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          OUROBOROS_BUILTIN_SKILLS_DIR: this.getBuiltinSkillsDir(),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeTestLog(`spawn threw: ${message}`)
      this.setStatus('error')
      return
    }

    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf-8')
      this.drainBuffer('stdout')
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf-8')
      this.drainBuffer('stderr')
    })

    this.process.on('exit', (code, signal) => {
      writeTestLog(`cli exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      this.process = null
      if (!this.intentionalShutdown) this.handleUnexpectedExit()
    })

    this.process.on('error', (error) => {
      writeTestLog(`cli error ${error.message}`)
      this.process = null
      if (!this.intentionalShutdown) this.handleUnexpectedExit()
    })

    this.emit('spawned', { restartCount: this.restartCount })
  }

  private drainBuffer(stream: 'stdout' | 'stderr'): void {
    const bufferKey = stream === 'stdout' ? 'stdoutBuffer' as const : 'stderrBuffer' as const
    const handler = stream === 'stdout' ? this.onStdoutLine : this.onStderrLine

    let newlineIndex: number
    while ((newlineIndex = this[bufferKey].indexOf('\n')) !== -1) {
      const line = this[bufferKey].slice(0, newlineIndex).trim()
      this[bufferKey] = this[bufferKey].slice(newlineIndex + 1)
      if (line.length > 0) {
        if (stream === 'stderr') {
          this.stderrLog.push(line)
          if (this.stderrLog.length > 1000) this.stderrLog.shift()
        }
        handler(line)
      }
    }
  }

  private handleUnexpectedExit(): void {
    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      this.setStatus('error')
      if (process.env.NODE_ENV !== 'test') {
        dialog.showErrorBox(
          'Ouroboros CLI Error',
          `The CLI process has crashed ${MAX_RESTART_ATTEMPTS} times and could not be restarted. ` +
            'Please check your CLI installation and try restarting the application.',
        )
      }
      return
    }

    this.restartCount++
    this.setStatus('restarting')
    writeTestLog(`cli restarting attempt=${this.restartCount}`)
    setTimeout(() => this.spawnProcess(), RESTART_DELAY_MS)
  }

  /**
   * Resolve the directory whose direct children are built-in skill folders
   * (each containing a SKILL.md). The CLI receives this path via the
   * OUROBOROS_BUILTIN_SKILLS_DIR env var and scans it as the lowest-precedence
   * skill source, so workspace-local skills can override built-ins by name.
   */
  private getBuiltinSkillsDir(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'skills', 'builtin')
    }
    // app.getAppPath() resolves to packages/desktop in dev (same anchor used
    // by getCliPath above when locating the CLI binary).
    return join(app.getAppPath(), 'resources', 'skills', 'builtin')
  }

  private getCliWorkingDirectory(): string {
    return app.getPath('userData')
  }

  private getCliConfigArgs(): string[] {
    return ['--config', app.getPath('userData')]
  }

  private resolvePackagedCliPath(): string {
    const candidates: string[] = []

    if (process.platform === 'darwin') {
      const archSpecificBinary = MACOS_PACKAGED_CLI_BY_ARCH[process.arch]
      if (archSpecificBinary) {
        candidates.push(join(process.resourcesPath, archSpecificBinary))
      }
    }

    candidates.push(
      join(process.resourcesPath, process.platform === 'win32' ? 'ouroboros.exe' : 'ouroboros'),
      join(process.resourcesPath, 'ouroboros'),
    )

    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  }
}
