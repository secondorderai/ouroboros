/**
 * Agent Loop — ReAct Pattern
 *
 * The brain of Ouroboros. Receives user input, builds a system prompt,
 * streams an LLM response, detects and executes tool calls, feeds
 * observations back, and loops until the task is complete.
 *
 * Decoupled from CLI — the agent emits events that consumers
 * (CLI, JSON-RPC, etc.) subscribe to for rendering.
 */

import type { LanguageModel } from 'ai'
import { streamResponse } from '@src/llm/streaming'
import { buildSystemPrompt, type BuildSystemPromptOptions } from '@src/llm/prompt'
import type { LLMMessage, ToolCall, StreamChunk, LLMToolSpec } from '@src/llm/types'
import type { ToolRegistry } from '@src/tools/registry'
import { getMemoryIndex } from '@src/memory/index'
import { getAgentsMdInstructions } from '@src/agents-md'
import { getSkillCatalog, type SkillCatalogEntry } from '@src/tools/skill-manager'
import type { RSIEvent } from '@src/rsi/types'
import type { RSIOrchestrator } from '@src/rsi/orchestrator'
import type { ModeManager } from '@src/modes/manager'
import type { Plan } from '@src/modes/plan/types'

// ── Event types ──────────────────────────────────────────────────────

/** Events emitted during the agent loop. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call-start'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool-call-end'
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
    }
  | { type: 'turn-complete'; text: string; iterations: number }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'mode-entered'; modeId: string; displayName: string; reason: string }
  | { type: 'mode-exited'; modeId: string; reason: string }
  | { type: 'plan-submitted'; plan: Plan }
  | RSIEvent

/** Callback function for agent events. */
export type AgentEventHandler = (event: AgentEvent) => void

// ── Agent options ────────────────────────────────────────────────────

export interface AgentOptions {
  /** LLM model instance (from createProvider) */
  model: LanguageModel
  /** Tool registry with discovered tools */
  toolRegistry: ToolRegistry
  /** Maximum iterations before stopping (default 50) */
  maxIterations?: number
  /** Event handler callback */
  onEvent?: AgentEventHandler
  /** Optional override for system prompt building (for testing) */
  systemPromptBuilder?: (options: BuildSystemPromptOptions) => string
  /** Optional override for memory fetching (for testing) */
  memoryProvider?: () => string
  /** Optional override for skill catalog fetching (for testing) */
  skillCatalogProvider?: () => SkillCatalogEntry[]
  /** RSI orchestrator instance (initialized lazily, only if RSI is enabled) */
  rsiOrchestrator?: RSIOrchestrator
  /** Mode manager for behavioral overlays (plan mode, etc.) */
  modeManager?: ModeManager
}

// ── Agent result ─────────────────────────────────────────────────────

export interface AgentRunResult {
  /** The final text response from the agent */
  text: string
  /** Number of LLM iterations used */
  iterations: number
  /** Whether the max iteration limit was hit */
  maxIterationsReached: boolean
}

export interface AgentRunOptions {
  responseStyle?: 'default' | 'desktop-readable'
}

// ── Agent class ──────────────────────────────────────────────────────

export class Agent {
  private model: LanguageModel
  private toolRegistry: ToolRegistry
  private maxIterations: number
  private onEvent: AgentEventHandler
  private systemPromptBuilder: (options: BuildSystemPromptOptions) => string
  private memoryProvider: () => string
  private skillCatalogProvider: () => SkillCatalogEntry[]
  private rsiOrchestrator: RSIOrchestrator | null
  private modeManager: ModeManager | null

  /** Conversation history persisted across run() calls within a session. */
  private conversationHistory: LLMMessage[] = []

  constructor(options: AgentOptions) {
    this.model = options.model
    this.toolRegistry = options.toolRegistry
    this.maxIterations = options.maxIterations ?? 50
    this.onEvent = options.onEvent ?? (() => {})
    this.systemPromptBuilder = options.systemPromptBuilder ?? buildSystemPrompt
    this.memoryProvider =
      options.memoryProvider ??
      (() => {
        const result = getMemoryIndex()
        return result.ok ? result.value : ''
      })
    this.skillCatalogProvider = options.skillCatalogProvider ?? getSkillCatalog
    this.rsiOrchestrator = options.rsiOrchestrator ?? null
    this.modeManager = options.modeManager ?? null
  }

  /**
   * Run the agent loop for a user message.
   *
   * The agent:
   * 1. Appends the user message to conversation history
   * 2. Builds a system prompt with current tools, skills, memory
   * 3. Streams the LLM response
   * 4. If tool calls detected: executes them, injects results, loops
   * 5. If text only: turn is complete
   *
   * Multi-turn: conversation history persists between calls.
   */
  async run(userMessage: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    // Append user message to conversation history
    this.conversationHistory.push({ role: 'user', content: userMessage })

    let iterations = 0
    let finalText = ''

    while (iterations < this.maxIterations) {
      iterations++

      // Build system prompt with current state
      const systemPrompt = this.buildCurrentSystemPrompt(options)

      // Build tool definitions for the LLM
      const toolDefs = this.buildToolDefinitions()

      // Stream the LLM response
      const streamResult = streamResponse(this.model, this.conversationHistory, {
        system: systemPrompt,
        tools: Object.keys(toolDefs).length > 0 ? toolDefs : undefined,
      })

      if (!streamResult.ok) {
        // Setup error — emit and inject error into conversation for retry
        const error = streamResult.error
        this.emitEvent({ type: 'error', error, recoverable: true })

        this.conversationHistory.push({
          role: 'user',
          content: `[System: LLM call failed: ${error.message}. Please try again or adjust your approach.]`,
        })
        continue
      }

      // Process the stream
      const turnResult = await this.processStream(streamResult.value.stream)

      if (turnResult.error) {
        // Stream error — inject into conversation and retry
        this.emitEvent({ type: 'error', error: turnResult.error, recoverable: true })

        this.conversationHistory.push({
          role: 'user',
          content: `[System: LLM streaming error: ${turnResult.error.message}. Please try again or adjust your approach.]`,
        })
        continue
      }

      // Accumulate text from the assistant
      const assistantText = turnResult.text
      const toolCalls = turnResult.toolCalls

      if (toolCalls.length > 0) {
        // Assistant message with tool calls
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantText,
          toolCalls,
        })

        // Execute tool calls (in parallel where possible)
        const toolResults = await this.executeToolCalls(toolCalls)

        // Inject tool results into conversation
        this.conversationHistory.push({
          role: 'tool',
          content: toolResults,
        })

        // Loop — send updated conversation back to LLM
        continue
      }

      // No tool calls — turn is complete
      if (assistantText) {
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantText,
        })
      }

      finalText = assistantText

      this.emitEvent({
        type: 'turn-complete',
        text: finalText,
        iterations,
      })

      // Post-task RSI reflection (non-blocking, error-isolated)
      if (this.rsiOrchestrator) {
        this.runRSIPostTask(finalText).catch(() => {
          // Swallowed — RSI errors must never propagate to the caller.
        })
      }

      return {
        text: finalText,
        iterations,
        maxIterationsReached: false,
      }
    }

    // Max iterations reached
    const limitMessage = `[Agent stopped: reached maximum of ${this.maxIterations} iterations]`
    this.emitEvent({
      type: 'error',
      error: new Error(limitMessage),
      recoverable: false,
    })
    this.emitEvent({
      type: 'turn-complete',
      text: limitMessage,
      iterations,
    })

    return {
      text: limitMessage,
      iterations,
      maxIterationsReached: true,
    }
  }

  /**
   * Get the current conversation history (for serialization/transcripts).
   */
  getConversationHistory(): LLMMessage[] {
    return [...this.conversationHistory]
  }

  /**
   * Replace the current conversation history (e.g. when loading a past session).
   */
  setConversationHistory(history: LLMMessage[]): void {
    this.conversationHistory = [...history]
  }

  /**
   * Clear conversation history (start a new session).
   */
  clearHistory(): void {
    this.conversationHistory = []
  }

  /**
   * Shut down the agent gracefully.
   * Triggers session-end RSI hooks (dream cycle) if configured.
   */
  async shutdown(): Promise<void> {
    if (this.rsiOrchestrator) {
      try {
        await this.rsiOrchestrator.onSessionEnd()
      } catch {
        // RSI shutdown errors are swallowed — never crash on exit.
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Run RSI post-task reflection asynchronously.
   * Error-isolated: any failure is emitted as an rsi-error event.
   */
  private async runRSIPostTask(taskSummary: string): Promise<void> {
    if (!this.rsiOrchestrator) return
    try {
      await this.rsiOrchestrator.onTaskComplete(taskSummary)
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      this.emitEvent({ type: 'rsi-error', stage: 'post-task', error })
    }
  }

  private emitEvent(event: AgentEvent): void {
    try {
      this.onEvent(event)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`[agent] Event handler error (${event.type}): ${msg}\n`)
    }
  }

  /**
   * Build the system prompt with current tools, skills, and memory.
   */
  private buildCurrentSystemPrompt(options: AgentRunOptions = {}): string {
    const tools = this.toolRegistry.getTools()
    const memory = this.memoryProvider()
    const agentsInstructions = getAgentsMdInstructions()

    // Map skill catalog entries to the format expected by buildSystemPrompt
    const skillCatalog = this.skillCatalogProvider()
    const skills = skillCatalog.map((s) => ({
      name: s.name,
      description: s.description,
    }))

    // Get mode overlay (active mode section or auto-detection hints)
    const modeOverlay = this.modeManager?.getPromptOverlay() ?? undefined

    return this.systemPromptBuilder({
      tools,
      skills,
      memory,
      agentsInstructions,
      responseStyle: options.responseStyle,
      modeOverlay,
    })
  }

  /**
   * Convert tool registry metadata to the LLM tool definition format
   * used by streamResponse().
   */
  private buildToolDefinitions(): Record<string, LLMToolSpec> {
    let tools = this.toolRegistry.getTools()

    // Filter tools based on active mode (if any)
    if (this.modeManager) {
      tools = this.modeManager.filterTools(tools)
    }

    const defs: Record<string, LLMToolSpec> = {}

    for (const tool of tools) {
      defs[tool.name] = {
        description: tool.description,
        parameters: tool.parameters,
      }
    }

    return defs
  }

  /**
   * Process a stream of chunks, accumulating text and collecting tool calls.
   * Emits events for text deltas and tool call starts.
   */
  private async processStream(
    stream: AsyncIterable<StreamChunk>,
  ): Promise<{ text: string; toolCalls: ToolCall[]; error: Error | null }> {
    let text = ''
    const toolCalls: ToolCall[] = []
    let streamError: Error | null = null

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta':
          text += chunk.textDelta
          this.emitEvent({ type: 'text', text: chunk.textDelta })
          break

        case 'tool-call':
          toolCalls.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          })
          this.emitEvent({
            type: 'tool-call-start',
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
          })
          break

        case 'error':
          streamError = chunk.error
          break

        case 'finish':
          // Finish event — we use it implicitly (loop ends)
          break

        // Ignore tool-call-streaming-start, tool-call-delta (progressive streaming)
        default:
          break
      }
    }

    return { text, toolCalls, error: streamError }
  }

  /**
   * Execute tool calls in parallel and return tool results.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
  ): Promise<Array<{ toolCallId: string; toolName: string; result: unknown }>> {
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        // Intercept bash commands in active mode (e.g. block writes in plan mode)
        if (tc.toolName === 'bash' && this.modeManager) {
          const command = (tc.input as Record<string, unknown>).command
          if (typeof command === 'string') {
            const blocked = this.modeManager.interceptBash(command)
            if (blocked) {
              this.emitEvent({
                type: 'tool-call-end',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                result: blocked,
                isError: true,
              })
              return { toolCallId: tc.toolCallId, toolName: tc.toolName, result: blocked }
            }
          }
        }

        const execResult = await this.toolRegistry.executeTool(tc.toolName, tc.input)

        const isError = !execResult.ok
        const resultValue = execResult.ok ? execResult.value : execResult.error.message

        this.emitEvent({
          type: 'tool-call-end',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: resultValue,
          isError,
        })

        return {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: resultValue,
        }
      }),
    )

    return results
  }
}
