/**
 * RSI Orchestrator
 *
 * Central coordinator for all Recursive Self-Improvement operations.
 * Manages the lifecycle hooks that connect RSI components to the Agent:
 *
 * - Post-task reflection (after every run() call)
 * - Crystallization pipeline (when reflection indicates novel pattern)
 * - Dream cycle (session-end memory consolidation)
 * - Evolution logging (all events written to the log)
 *
 * All operations are error-isolated: RSI failures never crash the agent
 * or interrupt the user's task. Errors are logged and emitted as events.
 */

import type { LanguageModel } from 'ai'
import { type Result, err } from '@src/types'
import type { OuroborosConfig } from '@src/config'
import type { RSIEventHandler, RSIEvent } from './types'
import {
  reflect,
  shouldCrystallize,
  crystallize,
  type ReflectionRecord,
  type CrystallizationResult,
} from './crystallize'
import { appendEntry } from './evolution-log'
import { dream, type DreamResult, type DreamOptions } from '@src/memory/dream'
import { getSkillCatalog } from '@src/tools/skill-manager'

// ── Types ──────────────────────────────────────────────────────────

export interface RSIOrchestratorOptions {
  config: OuroborosConfig
  llm: LanguageModel
  onEvent?: RSIEventHandler
  basePath?: string
}

// ── Orchestrator ───────────────────────────────────────────────────

export class RSIOrchestrator {
  private config: OuroborosConfig
  private llm: LanguageModel
  private onEvent: RSIEventHandler
  private basePath: string | undefined

  constructor(options: RSIOrchestratorOptions) {
    this.config = options.config
    this.llm = options.llm
    this.onEvent = options.onEvent ?? (() => {})
    this.basePath = options.basePath
  }

  /**
   * Called after each task completion.
   * Triggers reflection and potentially crystallization.
   */
  async onTaskComplete(taskSummary: string, transcript?: string): Promise<void> {
    if (!this.config.rsi.autoReflect) {
      return
    }

    try {
      const reflectionResult = await this.triggerReflection(taskSummary)

      if (!reflectionResult.ok) {
        this.emitError('reflection', reflectionResult.error)
        return
      }

      const reflection = reflectionResult.value

      // Check if crystallization is warranted
      if (shouldCrystallize(reflection, this.config.rsi.noveltyThreshold)) {
        const crystalResult = await this.triggerCrystallization(taskSummary, transcript)

        if (!crystalResult.ok) {
          this.emitError('crystallization', crystalResult.error)
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      this.emitError('reflection', error)
    }
  }

  /**
   * Called on session end.
   * Triggers the dream cycle if configured.
   */
  async onSessionEnd(): Promise<void> {
    if (this.config.memory.consolidationSchedule !== 'session-end') {
      return
    }

    try {
      const result = await this.triggerDream({ mode: 'consolidate-only' })
      if (!result.ok) {
        this.emitError('dream', result.error)
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      this.emitError('dream', error)
    }
  }

  /**
   * Manual trigger: run reflection on a task summary.
   */
  async triggerReflection(taskSummary: string): Promise<Result<ReflectionRecord>> {
    try {
      const existingSkills = getSkillCatalog().map((s) => s.name)
      const result = await reflect(taskSummary, existingSkills, this.llm)

      if (result.ok) {
        // Log to evolution log
        appendEntry(
          {
            timestamp: new Date().toISOString(),
            event: 'reflection',
            summary: `Reflected on: ${taskSummary.slice(0, 100)}`,
            data: {
              noveltyScore: result.value.noveltyScore,
              generalizabilityScore: result.value.generalizabilityScore,
              shouldCrystallize: result.value.shouldCrystallize,
            },
          },
          this.basePath,
        )

        // Emit event
        this.emitEvent({
          type: 'rsi-reflection',
          reflection: result.value,
        })
      }

      return result
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      return err(error)
    }
  }

  /**
   * Manual trigger: run the full crystallization pipeline.
   */
  async triggerCrystallization(
    taskSummary: string,
    transcript?: string,
  ): Promise<Result<CrystallizationResult>> {
    try {
      const existingSkills = getSkillCatalog().map((s) => s.name)

      const result = await crystallize(taskSummary, {
        llm: this.llm,
        existingSkills,
        transcript,
        basePath: this.basePath,
        noveltyThreshold: this.config.rsi.noveltyThreshold,
      })

      if (result.ok) {
        const crystalResult = result.value

        // Log to evolution log
        appendEntry(
          {
            timestamp: new Date().toISOString(),
            event: 'crystallization',
            summary: `Crystallization: ${crystalResult.outcome}`,
            data: {
              outcome: crystalResult.outcome,
              skillName: crystalResult.skill?.frontmatter.name,
              skillPath: crystalResult.skillPath,
            },
          },
          this.basePath,
        )

        // If promoted, log the promotion separately
        if (crystalResult.outcome === 'promoted' && crystalResult.skillPath) {
          appendEntry(
            {
              timestamp: new Date().toISOString(),
              event: 'skill-promoted',
              summary: `Skill promoted: ${crystalResult.skill?.frontmatter.name}`,
              data: {
                skillName: crystalResult.skill?.frontmatter.name,
                skillPath: crystalResult.skillPath,
              },
            },
            this.basePath,
          )
        }

        // Emit event
        this.emitEvent({
          type: 'rsi-crystallization',
          result: crystalResult,
        })
      }

      return result
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      return err(error)
    }
  }

  /**
   * Manual trigger: run the dream cycle.
   */
  async triggerDream(options?: DreamOptions): Promise<Result<DreamResult>> {
    try {
      const dreamOpts: DreamOptions = {
        mode: options?.mode ?? 'consolidate-only',
        basePath: options?.basePath ?? this.basePath,
      }

      const result = await dream(dreamOpts)

      if (result.ok) {
        const dreamResult = result.value

        // Log to evolution log
        appendEntry(
          {
            timestamp: new Date().toISOString(),
            event: 'memory-consolidated',
            summary: dreamResult.summary,
            data: {
              mode: dreamResult.mode,
              topicsMerged: dreamResult.topicsMerged,
              topicsCreated: dreamResult.topicsCreated,
              topicsPruned: dreamResult.topicsPruned,
            },
          },
          this.basePath,
        )

        // Emit event
        this.emitEvent({
          type: 'rsi-dream',
          result: dreamResult,
        })
      }

      return result
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      return err(error)
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private emitEvent(event: RSIEvent): void {
    try {
      this.onEvent(event)
    } catch {
      // Event handler error — swallow to maintain error isolation
    }
  }

  private emitError(stage: string, error: Error): void {
    // Log to evolution log
    appendEntry(
      {
        timestamp: new Date().toISOString(),
        event: 'rsi-error',
        summary: `RSI error in ${stage}: ${error.message}`,
        data: { stage, errorMessage: error.message },
      },
      this.basePath,
    )

    // Emit error event
    this.emitEvent({
      type: 'rsi-error',
      stage,
      error,
    })
  }
}
