/**
 * CLI Renderer — Output formatting utilities
 *
 * Handles streaming text display, tool call indicators (spinners),
 * verbose output formatting, and error rendering.
 * Writes directly to process.stdout/stderr for piping compatibility.
 */

// ── ANSI escape codes ────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

/** Spinner frames for tool call progress indicator. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ── Types ────────────────────────────────────────────────────────────

export interface ToolCallState {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  spinnerInterval: ReturnType<typeof setInterval> | null
  frameIndex: number
}

export interface RendererOptions {
  /** Show tool call details (name, args, result) */
  verbose: boolean
  /** Whether output is a TTY (enables ANSI codes and spinners) */
  isTTY: boolean
}

// ── Renderer class ───────────────────────────────────────────────────

export class Renderer {
  private verbose: boolean
  private isTTY: boolean
  private activeSpinners = new Map<string, ToolCallState>()

  constructor(options: RendererOptions) {
    this.verbose = options.verbose
    this.isTTY = options.isTTY
  }

  /** Write streaming text delta to stdout. */
  writeText(text: string): void {
    process.stdout.write(text)
  }

  /** Write a full line to stdout (with newline). */
  writeLine(text: string): void {
    process.stdout.write(text + '\n')
  }

  /** Start a tool call spinner indicator. */
  startToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    const state: ToolCallState = {
      toolCallId,
      toolName,
      args,
      spinnerInterval: null,
      frameIndex: 0
    }

    if (this.isTTY) {
      // Show tool name with spinner
      if (this.verbose) {
        this.writeToolHeader(toolName, args)
      }

      state.spinnerInterval = setInterval(() => {
        state.frameIndex = (state.frameIndex + 1) % SPINNER_FRAMES.length
        const frame = SPINNER_FRAMES[state.frameIndex]
        // Move cursor to start of line and rewrite spinner
        process.stdout.write(`\r${CYAN}${frame}${RESET} ${DIM}Running ${toolName}...${RESET}`)
      }, 80)

      // Write initial spinner frame
      const frame = SPINNER_FRAMES[0]
      process.stdout.write(`${CYAN}${frame}${RESET} ${DIM}Running ${toolName}...${RESET}`)
    } else if (this.verbose) {
      // Non-TTY: just show a line indicating tool call started
      this.writeLine(`[tool-call] ${toolName}(${this.formatArgs(args)})`)
    }

    this.activeSpinners.set(toolCallId, state)
  }

  /** End a tool call spinner and show result. */
  endToolCall(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    const state = this.activeSpinners.get(toolCallId)

    if (state?.spinnerInterval) {
      clearInterval(state.spinnerInterval)
    }

    if (this.isTTY) {
      // Clear the spinner line
      process.stdout.write('\r\x1b[K')

      if (isError) {
        this.writeLine(`${RED}✗${RESET} ${toolName} ${RED}failed${RESET}`)
      } else {
        this.writeLine(`${GREEN}✓${RESET} ${toolName} ${DIM}done${RESET}`)
      }

      if (this.verbose) {
        this.writeToolResult(result, isError)
      }
    } else if (this.verbose) {
      // Non-TTY verbose
      const status = isError ? 'ERROR' : 'OK'
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      this.writeLine(`[tool-result] ${toolName} (${status}): ${resultStr}`)
    }

    this.activeSpinners.delete(toolCallId)
  }

  /** Show an error message in red. */
  writeError(error: Error): void {
    if (this.isTTY) {
      process.stderr.write(`${RED}${BOLD}Error:${RESET} ${RED}${error.message}${RESET}\n`)
    } else {
      process.stderr.write(`Error: ${error.message}\n`)
    }
  }

  /** Show the turn-complete indicator and prepare for next input. */
  writeTurnComplete(): void {
    // Ensure we're on a new line after streaming text
    process.stdout.write('\n')
  }

  /** Write the REPL prompt. */
  writePrompt(): void {
    if (this.isTTY) {
      process.stdout.write(`\n${BOLD}${CYAN}> ${RESET}`)
    }
  }

  /** Write a status/info message. */
  writeInfo(message: string): void {
    if (this.isTTY) {
      process.stdout.write(`${DIM}${message}${RESET}\n`)
    }
  }

  /** Write the welcome banner. */
  writeBanner(provider: string, model: string): void {
    if (this.isTTY) {
      this.writeLine(`${BOLD}Ouroboros v0.1.0${RESET}`)
      this.writeLine(`${DIM}Model: ${provider}/${model}${RESET}`)
      this.writeLine(`${DIM}Type your message. Ctrl+C to cancel, Ctrl+C twice to exit.${RESET}`)
    }
  }

  /** Stop all active spinners (cleanup on cancel/exit). */
  stopAllSpinners(): void {
    for (const [_id, state] of this.activeSpinners) {
      if (state.spinnerInterval) {
        clearInterval(state.spinnerInterval)
      }
    }
    this.activeSpinners.clear()
    // Clear any partial spinner line
    if (this.isTTY) {
      process.stdout.write('\r\x1b[K')
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private writeToolHeader(toolName: string, args: Record<string, unknown>): void {
    const argsStr = this.formatArgs(args)
    this.writeLine(`\n${YELLOW}┌ ${BOLD}${toolName}${RESET}${YELLOW}(${argsStr})${RESET}`)
  }

  private writeToolResult(result: unknown, isError: boolean): void {
    const color = isError ? RED : DIM
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    // Indent result lines and truncate for readability
    const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr
    const lines = truncated.split('\n')
    for (const line of lines) {
      this.writeLine(`${color}│ ${line}${RESET}`)
    }
    this.writeLine(`${color}└${RESET}`)
  }

  private formatArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args)
    if (entries.length === 0) return ''
    return entries
      .map(([k, v]) => {
        const val = typeof v === 'string' ? `"${v.length > 50 ? v.slice(0, 50) + '...' : v}"` : JSON.stringify(v)
        return `${k}: ${val}`
      })
      .join(', ')
  }
}
