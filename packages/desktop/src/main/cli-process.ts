/**
 * CLI Process Manager
 *
 * Manages the Ouroboros CLI child process lifecycle: spawning, health
 * checking, restart-on-crash, and graceful shutdown. Communicates with
 * the CLI via JSON-RPC over stdin/stdout (NDJSON).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { EventEmitter } from 'node:events'
import type { CLIStatus } from '../shared/protocol'

// ── Configuration ──────────────────────────────────────────────────

const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY_MS = 1000
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000

// ── Types ──────────────────────────────────────────────────────────

export type LineHandler = (line: string) => void

export interface CLIProcessManagerOptions {
  /** Handler called for each complete NDJSON line from the CLI's stdout */
  onStdoutLine: LineHandler
  /** Handler called for each line from the CLI's stderr (debug logging) */
  onStderrLine?: LineHandler
  /** Handler called when CLI status changes */
  onStatusChange?: (status: CLIStatus) => void
}

// ── CLI Process Manager ────────────────────────────────────────────

export class CLIProcessManager extends EventEmitter {
  private process: ChildProcess | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private stderrLog: string[] = []
  private restartCount = 0
  private intentionalShutdown = false
  private status: CLIStatus = 'starting'

  private readonly onStdoutLine: LineHandler
  private readonly onStderrLine: LineHandler
  private readonly onStatusChange: (status: CLIStatus) => void

  constructor(options: CLIProcessManagerOptions) {
    super()
    this.onStdoutLine = options.onStdoutLine
    this.onStderrLine = options.onStderrLine ?? (() => {})
    this.onStatusChange = options.onStatusChange ?? (() => {})
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Spawn the CLI child process and begin reading its output.
   */
  start(): void {
    this.intentionalShutdown = false
    this.setStatus('starting')
    this.spawnProcess()
  }

  /**
   * Write a line of JSON to the CLI's stdin (NDJSON format).
   * Each call appends a newline after the JSON string.
   */
  writeLine(json: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('CLI process stdin is not writable')
    }
    this.process.stdin.write(json + '\n')
  }

  /**
   * Graceful shutdown: close stdin, wait up to 3 seconds, then force-kill.
   * Returns a promise that resolves once the process has exited.
   */
  async shutdown(): Promise<void> {
    this.intentionalShutdown = true

    if (!this.process) {
      return
    }

    const proc = this.process

    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL')
        }
        resolve()
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)

      proc.once('exit', () => {
        clearTimeout(forceKillTimer)
        resolve()
      })

      // Close stdin to signal the CLI to shut down
      if (proc.stdin) {
        proc.stdin.end()
      }

      // Also send SIGTERM as a backup
      proc.kill('SIGTERM')
    })
  }

  /**
   * Get the current CLI status.
   */
  getStatus(): CLIStatus {
    return this.status
  }

  /**
   * Get captured stderr output for debugging.
   */
  getStderrLog(): string[] {
    return [...this.stderrLog]
  }

  // ── Private ───────────────────────────────────────────────────────

  private setStatus(status: CLIStatus): void {
    this.status = status
    this.onStatusChange(status)
    this.emit('status', status)
  }

  /**
   * Resolve the CLI binary path. In development, reads from OUROBOROS_CLI_PATH
   * env var. In production, uses the bundled binary in resources/.
   */
  private getCliPath(): { command: string; args: string[] } {
    const envPath = process.env.OUROBOROS_CLI_PATH

    if (envPath) {
      // Development mode: run via bun if it's a .ts file
      if (envPath.endsWith('.ts')) {
        return { command: 'bun', args: ['run', envPath, '--json-rpc'] }
      }
      return { command: envPath, args: ['--json-rpc'] }
    }

    // Production: bundled binary in resources/
    const isPackaged = app.isPackaged
    const resourcesPath = isPackaged
      ? join(process.resourcesPath, 'ouroboros')
      : join(app.getAppPath(), '..', 'cli', 'dist', 'ouroboros')

    return { command: resourcesPath, args: ['--json-rpc'] }
  }

  private spawnProcess(): void {
    const { command, args } = this.getCliPath()

    try {
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[cli-process] Failed to spawn CLI: ${message}`)
      this.setStatus('error')
      return
    }

    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    // Read stdout line by line (NDJSON)
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf-8')
      this.drainStdoutBuffer()
    })

    // Read stderr line by line for debug logging
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf-8')
      this.drainStderrBuffer()
    })

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.error(
        `[cli-process] CLI process exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      )
      this.process = null

      if (this.intentionalShutdown) {
        return
      }

      // Unexpected exit — attempt restart
      this.handleUnexpectedExit()
    })

    this.process.on('error', (error) => {
      console.error(`[cli-process] CLI process error: ${error.message}`)
      this.process = null

      if (!this.intentionalShutdown) {
        this.handleUnexpectedExit()
      }
    })
  }

  /**
   * Drain the stdout buffer, extracting complete NDJSON lines.
   * Handles the case where multiple lines arrive in a single data event
   * or a line is split across multiple events.
   */
  private drainStdoutBuffer(): void {
    let newlineIndex: number
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)

      if (line.length > 0) {
        this.onStdoutLine(line)
      }
    }
  }

  /**
   * Drain the stderr buffer, extracting complete lines.
   */
  private drainStderrBuffer(): void {
    let newlineIndex: number
    while ((newlineIndex = this.stderrBuffer.indexOf('\n')) !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim()
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1)

      if (line.length > 0) {
        this.stderrLog.push(line)
        // Keep a bounded log
        if (this.stderrLog.length > 1000) {
          this.stderrLog.shift()
        }
        this.onStderrLine(line)
      }
    }
  }

  /**
   * Handle an unexpected CLI exit by attempting restart with retries.
   */
  private handleUnexpectedExit(): void {
    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      this.setStatus('error')
      dialog.showErrorBox(
        'Ouroboros CLI Error',
        `The CLI process has crashed ${MAX_RESTART_ATTEMPTS} times and could not be restarted. ` +
          'Please check your CLI installation and try restarting the application.',
      )
      return
    }

    this.restartCount++
    this.setStatus('restarting')
    console.error(
      `[cli-process] Restarting CLI (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})`,
    )

    setTimeout(() => {
      this.spawnProcess()
      // After spawning, the health check in rpc-client will set status to 'ready'
    }, RESTART_DELAY_MS)
  }

  /**
   * Reset the restart counter. Called after a successful health check
   * to indicate the CLI is healthy.
   */
  resetRestartCount(): void {
    this.restartCount = 0
  }

  /**
   * Set the status to 'ready'. Called by the RPC client after a
   * successful health check.
   */
  markReady(): void {
    this.setStatus('ready')
    this.resetRestartCount()
  }

  /**
   * Set the status to 'error'. Called when health check fails.
   */
  markError(): void {
    this.setStatus('error')
  }
}
