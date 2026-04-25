/**
 * Interactive REPL
 *
 * Multi-turn conversation loop using Node's readline for input
 * and direct stdout writes for streaming output.
 *
 * Features:
 * - Persistent conversation history across turns (via Agent)
 * - Input history with up-arrow recall (persisted to ~/.ouroboros_history)
 * - Ctrl+C: first press cancels current generation, second press exits
 * - Streaming text display with tool call spinners
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Agent, AgentEvent } from '@src/agent'
import type { OuroborosConfig } from '@src/config'
import { activateSkillForRun, resolveSlashSkillInvocation } from '@src/skills/skill-invocation'
import type { SkillActivationResult } from '@src/tools/skill-manager'
import { Renderer } from './renderer'

const HISTORY_FILE = join(homedir(), '.ouroboros_history')
const MAX_HISTORY_LINES = 1000
let historyLineCount = 0

export interface ReplOptions {
  /** The configured agent instance */
  agent: Agent
  /** Show tool call details */
  verbose: boolean
  /** Optional autonomous step limit override for this process */
  maxSteps?: number
  /** Parsed runtime config used for slash skill lookup. */
  config: OuroborosConfig
  /** Base path for resolving configured skill directories. */
  basePath?: string
  /** Event handler installer — called with the current turn's handler */
  setEventHandler: (handler: (event: AgentEvent) => void) => void
}

/**
 * Start the interactive REPL loop.
 *
 * This function does not return until the user exits (Ctrl+C twice or Ctrl+D).
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const { agent, verbose, maxSteps, config, basePath, setEventHandler } = options

  const renderer = new Renderer({
    verbose,
    isTTY: process.stdout.isTTY === true,
  })

  // Load input history from file
  const history = loadHistory()

  const prompt = '> '

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt,
    history,
    historySize: MAX_HISTORY_LINES,
    terminal: process.stdin.isTTY === true,
  })

  let isRunning = false
  let abortController: AbortController | null = null
  let ctrlCCount = 0
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    if (isRunning) {
      // First Ctrl+C during generation — cancel it
      renderer.stopAllSpinners()
      if (abortController) {
        abortController.abort()
        abortController = null
      }
      isRunning = false
      process.stdout.write('\n')
      renderer.writeInfo('Generation cancelled.')
      renderer.writePrompt()
      rl.resume()
      ctrlCCount = 0
      return
    }

    // Not running — track Ctrl+C for double-tap exit
    ctrlCCount++

    if (ctrlCCount >= 2) {
      renderer.writeLine('')
      renderer.writeInfo('Goodbye.')
      cleanup(rl)
      process.exit(0)
    }

    // First Ctrl+C when idle
    renderer.writeLine('')
    renderer.writeInfo('Press Ctrl+C again to exit.')
    renderer.writePrompt()
    rl.resume()

    // Reset counter after a short delay
    if (ctrlCTimer) clearTimeout(ctrlCTimer)
    ctrlCTimer = setTimeout(() => {
      ctrlCCount = 0
    }, 1500)
  })

  // Handle Ctrl+D (EOF)
  rl.on('close', () => {
    renderer.writeLine('')
    renderer.writeInfo('Goodbye.')
    cleanup(rl)
    process.exit(0)
  })

  // Main REPL loop
  renderer.writePrompt()

  for await (const line of rl) {
    const input = line.trim()

    // Reset Ctrl+C counter on any input
    ctrlCCount = 0

    // Skip empty lines
    if (!input) {
      renderer.writePrompt()
      continue
    }

    // Handle /plan command — prepend plan mode trigger
    let effectiveInput = input
    let activatedSkill: SkillActivationResult | undefined
    if (/^\/plan(?:\s|$)/.test(input)) {
      const planMessage = input.slice(5).trim()
      if (!planMessage) {
        renderer.writeInfo('Usage: /plan <task description>')
        renderer.writePrompt()
        continue
      }
      effectiveInput = `[User requests plan mode] ${planMessage}`
    } else {
      const parsed = resolveSlashSkillInvocation(input, config, basePath)
      if (!parsed.ok) {
        renderer.writeError(parsed.error)
        renderer.writePrompt()
        continue
      }
      effectiveInput = parsed.value.message
      if (parsed.value.skillName) {
        const activation = await activateSkillForRun(parsed.value.skillName, config, basePath)
        if (!activation.ok) {
          renderer.writeError(activation.error)
          renderer.writePrompt()
          continue
        }
        activatedSkill = activation.value
      }
    }

    // Save to history (original input, not transformed)
    appendToHistory(input)

    // Run agent
    isRunning = true
    abortController = new AbortController()

    // Set up event handler for this turn
    setEventHandler((event: AgentEvent) => {
      switch (event.type) {
        case 'text':
          renderer.writeText(event.text)
          break

        case 'tool-call-start':
          renderer.startToolCall(event.toolCallId, event.toolName, event.input)
          break

        case 'tool-call-end':
          renderer.endToolCall(event.toolCallId, event.toolName, event.result, event.isError)
          break

        case 'subagent-started':
          renderer.writeInfo(`Subagent ${event.agentId} started`)
          break

        case 'subagent-completed':
          renderer.writeInfo(`Subagent ${event.agentId} completed`)
          break

        case 'subagent-failed':
          renderer.writeInfo(`Subagent ${event.agentId} failed: ${event.error.message}`)
          break

        case 'turn-complete':
          renderer.writeTurnComplete()
          break

        case 'mode-entered':
          renderer.writeInfo(`Entered ${event.displayName} mode`)
          break

        case 'mode-exited':
          renderer.writeInfo(`Exited ${event.modeId} mode`)
          break

        case 'error':
          renderer.writeError(event.error)
          break
      }
    })

    try {
      await agent.run(effectiveInput, {
        runProfile: 'interactive',
        maxSteps,
        activatedSkill,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // Cancelled by Ctrl+C — already handled in SIGINT handler
      } else {
        const message = e instanceof Error ? e.message : String(e)
        renderer.writeError(new Error(message))
      }
    }

    isRunning = false
    abortController = null
    renderer.stopAllSpinners()
    renderer.writePrompt()
  }
}

// ── History persistence ──────────────────────────────────────────────

function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      const content = readFileSync(HISTORY_FILE, 'utf-8')
      const lines = content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-MAX_HISTORY_LINES)
      historyLineCount = lines.length
      return lines.reverse() // readline expects most recent first
    }
  } catch {
    // History file not readable — start fresh
  }
  return []
}

function appendToHistory(line: string): void {
  try {
    appendFileSync(HISTORY_FILE, line + '\n')
    historyLineCount++

    // Only re-read and truncate when line count exceeds threshold
    if (historyLineCount > MAX_HISTORY_LINES * 1.5) {
      const content = readFileSync(HISTORY_FILE, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim().length > 0)
      const trimmed = lines.slice(-MAX_HISTORY_LINES)
      writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n')
      historyLineCount = trimmed.length
    }
  } catch {
    // History write failed — not critical
  }
}

function cleanup(_rl: ReadlineInterface): void {
  // Any cleanup needed on exit
}
