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

import { getAgentsMdInstructions } from '@src/agents-md'
import { loadConfig, type OuroborosConfig } from '@src/config'
import { buildSystemPrompt, type BuildSystemPromptOptions } from '@src/llm/prompt'
import { streamResponse } from '@src/llm/streaming'
import type { FinishReason, LLMMessage, LLMToolSpec, StreamChunk, ToolCall } from '@src/llm/types'
import { readCheckpoint, reflectCheckpoint } from '@src/memory/checkpoints'
import { loadLayeredMemory, type LayeredMemorySections } from '@src/memory/loaders'
import { appendObservationBatch, type NewObservationInput } from '@src/memory/observations'
import type { ModeManager } from '@src/modes/manager'
import type { Plan } from '@src/modes/plan/types'
import { appendEntry, type NewEvolutionEntry } from '@src/rsi/evolution-log'
import type { RSIOrchestrator } from '@src/rsi/orchestrator'
import type { ReflectionCheckpoint, RSIEvent } from '@src/rsi/types'
import type { ToolRegistry } from '@src/tools/registry'
import { discoverSkills, getSkillCatalog, type SkillCatalogEntry } from '@src/tools/skill-manager'
import type { LanguageModel } from 'ai'

// ── Event types ──────────────────────────────────────────────────────

/** Events emitted during the agent loop. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | {
      type: 'context-usage'
      estimatedTotalTokens: number
      contextWindowTokens: number | null
      usageRatio: number | null
      threshold: ContextBudgetThreshold
    }
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
  /** Maximum autonomous steps before stopping. */
  maxSteps?: number
  /** @deprecated Use maxSteps. Kept for compatibility with existing callers. */
  maxIterations?: number
  /** Event handler callback */
  onEvent?: AgentEventHandler
  /** Optional override for system prompt building (for testing) */
  systemPromptBuilder?: (options: BuildSystemPromptOptions) => string
  /** Optional legacy override for durable memory fetching (for testing) */
  memoryProvider?: () => string
  /** Optional override for structured memory loading (for testing) */
  memoryContextProvider?: () => LayeredMemorySections
  /** Optional override for skill catalog fetching (for testing) */
  skillCatalogProvider?: () => SkillCatalogEntry[]
  /** Parsed configuration used for layered memory budgets */
  config?: OuroborosConfig
  /** Base path used for filesystem-backed memory loading */
  basePath?: string
  /** Active session whose checkpoint should be loaded into prompt memory */
  sessionId?: string
  /** RSI orchestrator instance (initialized lazily, only if RSI is enabled) */
  rsiOrchestrator?: RSIOrchestrator
  /** Mode manager for behavioral overlays (plan mode, etc.) */
  modeManager?: ModeManager
}

// ── Agent result ─────────────────────────────────────────────────────

export interface AgentRunResult {
  /** The final text response from the agent */
  text: string
  /** Number of LLM steps used */
  iterations: number
  /** Why the run stopped */
  stopReason: AgentStopReason
  /** Whether the max step limit was hit */
  maxIterationsReached: boolean
}

export type AgentRunProfile = 'interactive' | 'desktop' | 'singleShot' | 'automation'
export type AgentStopReason = 'completed' | 'max_steps' | 'error'

export interface AgentRunOptions {
  responseStyle?: 'default' | 'desktop-readable'
  maxSteps?: number
  runProfile?: AgentRunProfile
}

export type ContextBudgetThreshold = 'within-budget' | 'warn' | 'flush' | 'compact'

export interface ContextUsageEstimate {
  systemPromptTokens: number
  durableMemoryTokens: number
  checkpointMemoryTokens: number
  workingMemoryTokens: number
  liveConversationTokens: number
  toolResultTokens: number
  estimatedTotalTokens: number
  contextWindowTokens: number | null
  usageRatio: number | null
  threshold: ContextBudgetThreshold
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim()
  if (normalized.length === 0) {
    return 0
  }

  return Math.ceil(normalized.length / 4)
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function checkpointToObservationInputs(checkpoint: ReflectionCheckpoint): NewObservationInput[] {
  const inputs: NewObservationInput[] = []

  if (checkpoint.goal.trim().length > 0) {
    inputs.push({
      kind: 'goal',
      summary: checkpoint.goal,
      evidence: [checkpoint.goal],
      priority: 'high',
      tags: ['context-manager', 'checkpoint-seed'],
    })
  }

  for (const constraint of checkpoint.constraints) {
    inputs.push({
      kind: 'constraint',
      summary: constraint,
      evidence: [constraint],
      priority: 'high',
      tags: ['context-manager', 'checkpoint-seed'],
    })
  }

  for (const decision of checkpoint.decisionsMade) {
    inputs.push({
      kind: 'decision',
      summary: decision,
      evidence: [decision],
      priority: 'normal',
      tags: ['context-manager', 'checkpoint-seed'],
    })
  }

  for (const file of checkpoint.filesInPlay) {
    inputs.push({
      kind: 'artifact',
      summary: file,
      evidence: [file],
      priority: 'normal',
      tags: ['context-manager', 'checkpoint-seed', `file:${file}`],
    })
  }

  for (const completed of checkpoint.completedWork) {
    inputs.push({
      kind: 'progress',
      summary: completed,
      evidence: [completed],
      priority: 'normal',
      tags: ['context-manager', 'checkpoint-seed', 'completed'],
    })
  }

  for (const openLoop of checkpoint.openLoops) {
    inputs.push({
      kind: 'open-loop',
      summary: openLoop,
      evidence: [openLoop],
      priority: 'normal',
      tags: ['context-manager', 'checkpoint-seed'],
    })
  }

  for (const step of checkpoint.currentPlan) {
    inputs.push({
      kind: 'progress',
      summary: step,
      evidence: [step],
      priority: 'normal',
      tags: ['context-manager', 'checkpoint-seed', 'plan'],
    })
  }

  if (checkpoint.nextBestStep.trim().length > 0) {
    inputs.push({
      kind: 'progress',
      summary: checkpoint.nextBestStep,
      evidence: [checkpoint.nextBestStep],
      priority: 'high',
      tags: ['context-manager', 'checkpoint-seed', 'next-step'],
    })
  }

  return inputs
}

function estimateConversationTokens(messages: LLMMessage[]): { live: number; toolResults: number } {
  let live = 0
  let toolResults = 0

  for (const message of messages) {
    if (message.role === 'tool') {
      toolResults += estimateTextTokens(
        message.content
          .map(
            (result) =>
              `${result.toolName}:${result.toolCallId}:${summarizeText(serializeUnknown(result.result), 400)}`,
          )
          .join('\n'),
      )
      continue
    }

    let text = message.content
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const toolCallText = message.toolCalls
        .map((toolCall) => `${toolCall.toolName}:${serializeUnknown(toolCall.input)}`)
        .join('\n')
      text = [message.content, toolCallText].filter((value) => value.length > 0).join('\n')
    }

    live += estimateTextTokens(text)
  }

  return { live, toolResults }
}

export function estimateContextUsage(options: {
  systemPrompt: string
  memorySections: LayeredMemorySections
  conversationHistory: LLMMessage[]
  contextWindowTokens?: number
  warnRatio?: number
  flushRatio?: number
  compactRatio?: number
}): ContextUsageEstimate {
  const durableMemoryTokens = estimateTextTokens(options.memorySections.durableMemory ?? '')
  const checkpointMemoryTokens = estimateTextTokens(options.memorySections.checkpointMemory ?? '')
  const workingMemoryTokens = estimateTextTokens(options.memorySections.workingMemory ?? '')
  const allMemoryTokens = durableMemoryTokens + checkpointMemoryTokens + workingMemoryTokens
  const rawSystemTokens = estimateTextTokens(options.systemPrompt)
  const systemPromptTokens = Math.max(rawSystemTokens - allMemoryTokens, 0)
  const conversationTokens = estimateConversationTokens(options.conversationHistory)
  const estimatedTotalTokens =
    systemPromptTokens + allMemoryTokens + conversationTokens.live + conversationTokens.toolResults

  const contextWindowTokens =
    options.contextWindowTokens && options.contextWindowTokens > 0
      ? options.contextWindowTokens
      : null
  const usageRatio = contextWindowTokens ? estimatedTotalTokens / contextWindowTokens : null

  let threshold: ContextBudgetThreshold = 'within-budget'
  if (usageRatio !== null) {
    if (usageRatio >= (options.compactRatio ?? 0.9)) {
      threshold = 'compact'
    } else if (usageRatio >= (options.flushRatio ?? 0.8)) {
      threshold = 'flush'
    } else if (usageRatio >= (options.warnRatio ?? 0.7)) {
      threshold = 'warn'
    }
  }

  return {
    systemPromptTokens,
    durableMemoryTokens,
    checkpointMemoryTokens,
    workingMemoryTokens,
    liveConversationTokens: conversationTokens.live,
    toolResultTokens: conversationTokens.toolResults,
    estimatedTotalTokens,
    contextWindowTokens,
    usageRatio,
    threshold,
  }
}

// ── Agent class ──────────────────────────────────────────────────────

export class Agent {
  private model: LanguageModel
  private toolRegistry: ToolRegistry
  private maxStepsOverride: number | undefined
  private onEvent: AgentEventHandler
  private systemPromptBuilder: (options: BuildSystemPromptOptions) => string
  private memoryProvider: (() => string) | null
  private memoryContextProvider: (() => LayeredMemorySections) | null
  private skillCatalogProvider: () => SkillCatalogEntry[]
  private config: OuroborosConfig
  private basePath: string | undefined
  private sessionId: string | undefined
  private rsiOrchestrator: RSIOrchestrator | null
  private modeManager: ModeManager | null

  /** Conversation history persisted across run() calls within a session. */
  private conversationHistory: LLMMessage[] = []
  /** Number of history entries already captured into structured observations. */
  private observedHistoryLength = 0
  /** History length at which the checkpoint was last refreshed by the context manager. */
  private checkpointedHistoryLength = 0

  constructor(options: AgentOptions) {
    this.model = options.model
    this.toolRegistry = options.toolRegistry
    this.maxStepsOverride = options.maxSteps ?? options.maxIterations
    this.onEvent = options.onEvent ?? (() => {})
    this.systemPromptBuilder = options.systemPromptBuilder ?? buildSystemPrompt
    this.memoryProvider = options.memoryProvider ?? null
    this.memoryContextProvider = options.memoryContextProvider ?? null
    this.skillCatalogProvider = options.skillCatalogProvider ?? getSkillCatalog
    this.basePath = options.basePath
    this.sessionId = options.sessionId
    this.config =
      options.config ??
      (() => {
        const result = loadConfig(options.basePath)
        return result.ok
          ? result.value
          : ({
              model: { provider: 'anthropic', name: 'claude-opus-4-7' },
              permissions: {
                tier0: true,
                tier1: true,
                tier2: true,
                tier3: false,
                tier4: false,
              },
              skillDirectories: ['skills/core', 'skills/generated'],
              agent: {
                maxSteps: {
                  interactive: 200,
                  desktop: 200,
                  singleShot: 50,
                  automation: 100,
                },
              },
              memory: {
                consolidationSchedule: 'session-end',
                contextWindowTokens: 200_000,
                warnRatio: 0.7,
                flushRatio: 0.8,
                compactRatio: 0.9,
                tailMessageCount: 12,
                dailyLoadDays: 2,
                durableMemoryBudgetTokens: 1500,
                checkpointBudgetTokens: 1200,
                workingMemoryBudgetTokens: 1000,
              },
              rsi: {
                noveltyThreshold: 0.7,
                autoReflect: true,
                observeEveryTurns: 1,
                checkpointEveryTurns: 6,
                durablePromotionThreshold: 0.8,
                crystallizeFromRepeatedPatternsOnly: true,
              },
            } satisfies OuroborosConfig)
      })()
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

    const maxSteps = this.resolveMaxSteps(options)
    let iterations = 0
    let finalText = ''
    let lengthRecoveryAttempted = false

    while (iterations < maxSteps) {
      iterations++

      // Build system prompt with current state, observing/compacting if needed first.
      const context = this.prepareContextForCall(options)
      const systemPrompt = context.systemPrompt
      this.emitContextUsage(context.usage)

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

      if (turnResult.finishReason === 'length') {
        if (!lengthRecoveryAttempted) {
          lengthRecoveryAttempted = true
          this.performEmergencyRecovery(turnResult.text)
          continue
        }

        const error = new Error(
          'LLM output reached the context window limit after one recovery attempt',
        )
        if (this.sessionId) {
          this.logAndEmitRSIEvent(
            {
              type: 'rsi-length-recovery-failed',
              sessionId: this.sessionId,
              partialResponseLength: turnResult.text.length,
              metrics: {
                repeatedWorkDetected: false,
              },
            },
            {
              type: 'length-recovery-failed',
              summary: `Length recovery failed for ${this.sessionId}`,
              details: {
                sessionId: this.sessionId,
                partialResponseLength: turnResult.text.length,
                repeatedWorkDetected: false,
              },
              motivation:
                'The model exhausted the context window again after one recovery attempt.',
            },
          )
        }
        this.emitEvent({ type: 'error', error, recoverable: false })
        finalText = turnResult.text
        this.emitEvent({
          type: 'turn-complete',
          text: finalText,
          iterations,
        })

        return {
          text: finalText,
          iterations,
          stopReason: 'error',
          maxIterationsReached: false,
        }
      }

      // Accumulate text from the assistant
      const assistantText = turnResult.text
      const toolCalls = turnResult.toolCalls

      if (lengthRecoveryAttempted && this.sessionId) {
        this.logAndEmitRSIEvent(
          {
            type: 'rsi-length-recovery-succeeded',
            sessionId: this.sessionId,
            partialResponseLength: assistantText.length,
            metrics: {
              repeatedWorkDetected: false,
            },
          },
          {
            type: 'length-recovery-succeeded',
            summary: `Length recovery succeeded for ${this.sessionId}`,
            details: {
              sessionId: this.sessionId,
              partialResponseLength: assistantText.length,
              repeatedWorkDetected: false,
            },
            motivation:
              'The agent resumed successfully after rebuilding context from checkpoint state.',
          },
        )
      }

      lengthRecoveryAttempted = false

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
      this.emitContextUsage(this.appendAssistantTextToUsage(context.usage, assistantText))

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
        stopReason: 'completed',
        maxIterationsReached: false,
      }
    }

    const limitMessage = await this.summarizeAfterStepLimit(maxSteps, iterations, options)
    this.emitEvent({
      type: 'turn-complete',
      text: limitMessage,
      iterations,
    })

    return {
      text: limitMessage,
      iterations,
      stopReason: 'max_steps',
      maxIterationsReached: true,
    }
  }

  private resolveMaxSteps(options: AgentRunOptions): number {
    const configuredProfile = options.runProfile ?? 'automation'
    const configuredLimit = this.config.agent.maxSteps[configuredProfile]
    return Math.max(1, options.maxSteps ?? this.maxStepsOverride ?? configuredLimit)
  }

  private async summarizeAfterStepLimit(
    maxSteps: number,
    iterations: number,
    options: AgentRunOptions,
  ): Promise<string> {
    const fallback = this.buildStepLimitFallback(maxSteps, iterations)
    const summaryInstruction =
      `The autonomous step limit of ${maxSteps} steps has been reached. ` +
      'Do not call tools. Respond with a concise handoff summary that includes: ' +
      '1) what was completed, 2) the current state, and 3) recommended next steps to continue.'

    const context = this.prepareContextForCall(options)
    this.emitContextUsage(context.usage)

    const streamResult = streamResponse(this.model, this.conversationHistory, {
      system: `${context.systemPrompt}\n\n${summaryInstruction}`,
    })

    if (!streamResult.ok) {
      this.emitEvent({ type: 'text', text: fallback })
      this.conversationHistory.push({ role: 'assistant', content: fallback })
      return fallback
    }

    const turnResult = await this.processStream(streamResult.value.stream)
    if (turnResult.error) {
      this.emitEvent({ type: 'text', text: fallback })
      this.conversationHistory.push({ role: 'assistant', content: fallback })
      return fallback
    }

    const summary = turnResult.text.trim().length > 0 ? turnResult.text : fallback
    if (summary === fallback && turnResult.text.trim().length === 0) {
      this.emitEvent({ type: 'text', text: fallback })
    }

    this.conversationHistory.push({ role: 'assistant', content: summary })
    this.emitContextUsage(this.appendAssistantTextToUsage(context.usage, summary))
    return summary
  }

  private buildStepLimitFallback(maxSteps: number, iterations: number): string {
    return (
      `[Agent stopped: reached maximum of ${maxSteps} autonomous steps after ${iterations} ` +
      'steps. Send a follow-up message to continue from the current conversation state.]'
    )
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
    this.observedHistoryLength = 0
    this.checkpointedHistoryLength = 0
  }

  /**
   * Clear conversation history (start a new session).
   */
  clearHistory(): void {
    this.conversationHistory = []
    this.observedHistoryLength = 0
    this.checkpointedHistoryLength = 0
  }

  /**
   * Update the active session ID used for layered checkpoint loading.
   */
  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId
    this.observedHistoryLength = 0
    this.checkpointedHistoryLength = 0
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
  private buildCurrentSystemPrompt(
    options: AgentRunOptions = {},
    memorySections = this.loadPromptMemory(),
  ): string {
    const tools = this.toolRegistry.getTools()
    const agentsInstructions = getAgentsMdInstructions()

    discoverSkills(this.config.skillDirectories, this.basePath)

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
      memory: memorySections.durableMemory,
      memorySections,
      agentsInstructions,
      responseStyle: options.responseStyle,
      modeOverlay,
    })
  }

  private prepareContextForCall(options: AgentRunOptions): {
    systemPrompt: string
    memorySections: LayeredMemorySections
    usage: ContextUsageEstimate
  } {
    let memorySections = this.loadPromptMemory()
    let systemPrompt = this.buildCurrentSystemPrompt(options, memorySections)
    let usage = estimateContextUsage({
      systemPrompt,
      memorySections,
      conversationHistory: this.conversationHistory,
      contextWindowTokens: this.config.memory.contextWindowTokens,
      warnRatio: this.config.memory.warnRatio,
      flushRatio: this.config.memory.flushRatio,
      compactRatio: this.config.memory.compactRatio,
    })

    if (usage.threshold === 'flush' || usage.threshold === 'compact') {
      this.logAndEmitRSIEvent(
        {
          type: 'rsi-context-flushed',
          sessionId: this.sessionId ?? 'unknown-session',
          reason: usage.threshold,
          unseenMessageCount: Math.max(
            0,
            this.conversationHistory.length - this.observedHistoryLength,
          ),
          metrics: {
            usageRatio: usage.usageRatio,
            estimatedTotalTokens: usage.estimatedTotalTokens,
            contextWindowTokens: usage.contextWindowTokens,
            threshold: usage.threshold,
          },
        },
        this.sessionId
          ? {
              type: 'context-flushed',
              summary: `Context budget reached ${usage.threshold} threshold for ${this.sessionId}`,
              details: {
                sessionId: this.sessionId,
                usageRatio: usage.usageRatio,
                estimatedTotalTokens: usage.estimatedTotalTokens,
                contextWindowTokens: usage.contextWindowTokens,
                threshold: usage.threshold,
                unseenMessageCount: Math.max(
                  0,
                  this.conversationHistory.length - this.observedHistoryLength,
                ),
              },
              motivation: 'Pre-compaction flush preserves active working state before trimming.',
            }
          : null,
      )

      const refreshSucceeded = this.captureObservationsAndRefreshCheckpoint(usage.threshold)

      if (refreshSucceeded && usage.threshold === 'compact') {
        this.compactConversationHistory('compact')
      }

      memorySections = this.loadPromptMemory()
      systemPrompt = this.buildCurrentSystemPrompt(options, memorySections)
      usage = estimateContextUsage({
        systemPrompt,
        memorySections,
        conversationHistory: this.conversationHistory,
        contextWindowTokens: this.config.memory.contextWindowTokens,
        warnRatio: this.config.memory.warnRatio,
        flushRatio: this.config.memory.flushRatio,
        compactRatio: this.config.memory.compactRatio,
      })
    }

    return { systemPrompt, memorySections, usage }
  }

  private emitContextUsage(usage: ContextUsageEstimate): void {
    this.emitEvent({
      type: 'context-usage',
      estimatedTotalTokens: usage.estimatedTotalTokens,
      contextWindowTokens: usage.contextWindowTokens,
      usageRatio: usage.usageRatio,
      threshold: usage.threshold,
    })
  }

  private appendAssistantTextToUsage(
    usage: ContextUsageEstimate,
    assistantText: string,
  ): ContextUsageEstimate {
    const assistantTokens = estimateTextTokens(assistantText)
    const liveConversationTokens = usage.liveConversationTokens + assistantTokens
    const estimatedTotalTokens = usage.estimatedTotalTokens + assistantTokens
    const usageRatio =
      usage.contextWindowTokens && usage.contextWindowTokens > 0
        ? estimatedTotalTokens / usage.contextWindowTokens
        : null

    return {
      ...usage,
      liveConversationTokens,
      estimatedTotalTokens,
      usageRatio,
      threshold: this.getContextBudgetThreshold(usageRatio),
    }
  }

  private getContextBudgetThreshold(usageRatio: number | null): ContextBudgetThreshold {
    if (usageRatio === null) return 'within-budget'
    if (usageRatio >= this.config.memory.compactRatio) return 'compact'
    if (usageRatio >= this.config.memory.flushRatio) return 'flush'
    if (usageRatio >= this.config.memory.warnRatio) return 'warn'
    return 'within-budget'
  }

  private loadPromptMemory(): LayeredMemorySections {
    if (this.memoryContextProvider) {
      return this.memoryContextProvider()
    }

    if (this.memoryProvider) {
      return { durableMemory: this.memoryProvider() }
    }

    const result = loadLayeredMemory({
      basePath: this.basePath,
      sessionId: this.sessionId,
      config: this.config.memory,
    })

    return result.ok ? result.value : {}
  }

  private captureObservationsAndRefreshCheckpoint(
    reason: 'flush' | 'compact' | 'length-recovery' = 'flush',
    partialAssistantText?: string,
  ): boolean {
    if (!this.sessionId) {
      return false
    }

    const unseenMessages = this.conversationHistory.slice(this.observedHistoryLength)
    if (unseenMessages.length === 0 && !partialAssistantText) {
      if (this.checkpointedHistoryLength !== this.conversationHistory.length) {
        const refreshResult = reflectCheckpoint(this.sessionId, { basePath: this.basePath })
        if (!refreshResult.ok) {
          this.emitEvent({ type: 'error', error: refreshResult.error, recoverable: true })
          return false
        }
        this.checkpointedHistoryLength = this.conversationHistory.length
      }
      return true
    }

    const existingCheckpoint = readCheckpoint(this.sessionId, this.basePath)
    const inputs = this.buildObservationInputs(
      unseenMessages,
      existingCheckpoint.ok ? existingCheckpoint.value : null,
      partialAssistantText,
    )

    if (inputs.length > 0) {
      const appendResult = appendObservationBatch(this.sessionId, inputs, this.basePath)
      if (!appendResult.ok) {
        this.emitEvent({ type: 'error', error: appendResult.error, recoverable: true })
        return false
      } else {
        this.logAndEmitRSIEvent(
          {
            type: 'rsi-observation-recorded',
            sessionId: this.sessionId,
            reason:
              this.observedHistoryLength === 0 && existingCheckpoint ? 'checkpoint-seed' : reason,
            observationIds: appendResult.value.map((record) => record.id),
            observationKinds: appendResult.value.map((record) => record.kind),
            observationCount: appendResult.value.length,
          },
          {
            type: 'observation-recorded',
            summary: `Recorded ${appendResult.value.length} structured observations for ${this.sessionId}`,
            details: {
              sessionId: this.sessionId,
              observationCount: appendResult.value.length,
              observationKinds: appendResult.value.map((record) => record.kind),
              sourceObservationIds: appendResult.value.map((record) => record.id),
              metadata: {
                reason:
                  this.observedHistoryLength === 0 && existingCheckpoint
                    ? 'checkpoint-seed'
                    : reason,
              },
            },
            motivation: 'Observations capture session state before reflection and compaction.',
          },
        )
      }
    }

    const reflectionResult = reflectCheckpoint(this.sessionId, { basePath: this.basePath })
    if (!reflectionResult.ok) {
      this.emitEvent({ type: 'error', error: reflectionResult.error, recoverable: true })
      return false
    }

    this.logAndEmitRSIEvent(
      {
        type: 'rsi-checkpoint-written',
        sessionId: this.sessionId,
        reason,
        updatedAt: reflectionResult.value.updatedAt,
        openLoopCount: reflectionResult.value.openLoops.length,
        durableCandidateCount: reflectionResult.value.durableMemoryCandidates.length,
        skillCandidateCount: reflectionResult.value.skillCandidates.length,
      },
      {
        type: 'checkpoint-written',
        summary: `Updated reflection checkpoint for ${this.sessionId}`,
        details: {
          sessionId: this.sessionId,
          checkpointUpdatedAt: reflectionResult.value.updatedAt,
          openLoopCount: reflectionResult.value.openLoops.length,
          durableCandidateCount: reflectionResult.value.durableMemoryCandidates.length,
          skillCandidateCount: reflectionResult.value.skillCandidates.length,
          metadata: {
            reason,
          },
        },
        motivation: 'Checkpoints preserve the active plan, constraints, and open loops.',
      },
    )

    this.observedHistoryLength = this.conversationHistory.length
    this.checkpointedHistoryLength = this.conversationHistory.length
    return true
  }

  private buildObservationInputs(
    messages: LLMMessage[],
    existingCheckpoint: ReflectionCheckpoint | null,
    partialAssistantText?: string,
  ): NewObservationInput[] {
    const inputs: NewObservationInput[] =
      this.observedHistoryLength === 0 && existingCheckpoint
        ? checkpointToObservationInputs(existingCheckpoint)
        : []
    let shouldCaptureGoal = !existingCheckpoint || existingCheckpoint.goal.trim().length === 0
    let pendingOpenLoopIds: string[] = []

    for (const message of messages) {
      if (message.role === 'user') {
        const summary = summarizeText(message.content)
        if (shouldCaptureGoal && summary.length > 0) {
          inputs.push({
            kind: 'goal',
            summary,
            evidence: [message.content],
            priority: 'high',
            tags: ['context-manager', 'latest-goal'],
          })
          shouldCaptureGoal = false
        }

        const openLoopId = crypto.randomUUID()
        inputs.push({
          id: openLoopId,
          kind: 'open-loop',
          summary,
          evidence: [message.content],
          priority: 'normal',
          tags: ['context-manager', 'user-turn'],
        })
        pendingOpenLoopIds.push(openLoopId)
        continue
      }

      if (message.role === 'assistant') {
        const summary = summarizeText(message.content)
        if (summary.length > 0) {
          const supersedes = pendingOpenLoopIds.length > 0 ? [...pendingOpenLoopIds] : undefined
          inputs.push({
            kind: 'progress',
            summary,
            evidence: [message.content],
            priority: 'normal',
            tags: ['context-manager', 'completed'],
            supersedes,
          })
          pendingOpenLoopIds = []
        }
        continue
      }

      if (message.role === 'tool') {
        for (const result of message.content) {
          const renderedResult = summarizeText(serializeUnknown(result.result), 320)
          const supersedes = pendingOpenLoopIds.length > 0 ? [...pendingOpenLoopIds] : undefined
          inputs.push({
            kind: 'artifact',
            summary: `${result.toolName} result captured`,
            evidence: [renderedResult],
            priority: 'normal',
            tags: ['context-manager', `tool:${result.toolName}`],
            supersedes,
          })
          pendingOpenLoopIds = []
        }
      }
    }

    if (partialAssistantText && partialAssistantText.trim().length > 0) {
      const supersedes = pendingOpenLoopIds.length > 0 ? [...pendingOpenLoopIds] : undefined
      inputs.push({
        kind: 'progress',
        summary: summarizeText(partialAssistantText),
        evidence: [partialAssistantText],
        priority: 'high',
        tags: ['context-manager', 'partial-response', 'completed'],
        supersedes,
      })
      pendingOpenLoopIds = []
    }

    return inputs
  }

  private compactConversationHistory(reason: 'compact' | 'length-recovery'): void {
    const tailCount = Math.max(1, this.config.memory.tailMessageCount)
    if (this.conversationHistory.length <= tailCount) {
      return
    }

    let compactedHistory = this.conversationHistory.slice(-tailCount)
    const lastUserIndex = compactedHistory.map((message) => message.role).lastIndexOf('user')
    if (lastUserIndex > 0) {
      compactedHistory = compactedHistory.slice(lastUserIndex)
    }

    const droppedMessageCount = Math.max(
      0,
      this.conversationHistory.length - compactedHistory.length,
    )
    this.conversationHistory = compactedHistory
    this.observedHistoryLength = this.conversationHistory.length
    this.checkpointedHistoryLength = this.conversationHistory.length

    if (!this.sessionId) {
      return
    }

    this.logAndEmitRSIEvent(
      {
        type: 'rsi-history-compacted',
        sessionId: this.sessionId,
        reason,
        metrics: {
          droppedMessageCount,
          retainedMessageCount: compactedHistory.length,
          tailMessageCount: tailCount,
        },
      },
      {
        type: 'history-compacted',
        summary: `Compacted conversation history for ${this.sessionId}`,
        details: {
          sessionId: this.sessionId,
          droppedMessageCount,
          retainedMessageCount: compactedHistory.length,
          tailMessageCount: tailCount,
          metadata: {
            reason,
          },
        },
        motivation: 'Compaction trims low-value raw history once checkpoint state is externalized.',
      },
    )
  }

  private performEmergencyRecovery(partialAssistantText: string): void {
    if (this.sessionId) {
      const currentUsage = estimateContextUsage({
        systemPrompt: this.buildCurrentSystemPrompt({}, this.loadPromptMemory()),
        memorySections: this.loadPromptMemory(),
        conversationHistory: this.conversationHistory,
        contextWindowTokens: this.config.memory.contextWindowTokens,
        warnRatio: this.config.memory.warnRatio,
        flushRatio: this.config.memory.flushRatio,
        compactRatio: this.config.memory.compactRatio,
      })

      this.logAndEmitRSIEvent(
        {
          type: 'rsi-context-flushed',
          sessionId: this.sessionId,
          reason: 'length-recovery',
          unseenMessageCount: Math.max(
            0,
            this.conversationHistory.length - this.observedHistoryLength,
          ),
          metrics: {
            usageRatio: currentUsage.usageRatio,
            estimatedTotalTokens: currentUsage.estimatedTotalTokens,
            contextWindowTokens: currentUsage.contextWindowTokens,
            threshold: currentUsage.threshold,
          },
        },
        {
          type: 'context-flushed',
          summary: `Emergency context flush triggered for ${this.sessionId} after a length stop`,
          details: {
            sessionId: this.sessionId,
            usageRatio: currentUsage.usageRatio,
            estimatedTotalTokens: currentUsage.estimatedTotalTokens,
            contextWindowTokens: currentUsage.contextWindowTokens,
            threshold: currentUsage.threshold,
            unseenMessageCount: Math.max(
              0,
              this.conversationHistory.length - this.observedHistoryLength,
            ),
            partialResponseLength: partialAssistantText.length,
            metadata: {
              reason: 'length-recovery',
            },
          },
          motivation: 'Emergency flush preserves partial work before length-recovery compaction.',
        },
      )
    }

    this.captureObservationsAndRefreshCheckpoint('length-recovery', partialAssistantText)
    this.compactConversationHistory('length-recovery')
  }

  private logAndEmitRSIEvent(event: RSIEvent, entry: NewEvolutionEntry | null = null): void {
    if (entry) {
      const appendResult = appendEntry(entry, this.basePath)
      if (!appendResult.ok) {
        this.emitEvent({ type: 'error', error: appendResult.error, recoverable: true })
      }
    }

    this.emitEvent(event)
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
  private async processStream(stream: AsyncIterable<StreamChunk>): Promise<{
    text: string
    toolCalls: ToolCall[]
    error: Error | null
    finishReason: FinishReason
  }> {
    let text = ''
    const toolCalls: ToolCall[] = []
    let streamError: Error | null = null
    let finishReason: FinishReason = 'unknown'

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
          finishReason = chunk.finishReason
          break

        // Ignore tool-call-streaming-start, tool-call-delta (progressive streaming)
        default:
          break
      }
    }

    return { text, toolCalls, error: streamError, finishReason }
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
