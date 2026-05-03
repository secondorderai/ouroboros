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

import { resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import { type Result, err, ok } from '@src/types'
import type { OuroborosConfig } from '@src/config'
import type { RSIEventHandler, RSIEvent } from './types'
import {
  reflect,
  shouldCrystallize,
  crystallize,
  buildRSILLMCallOptions,
  generateRSIResponse,
  type ReflectionRecord,
  type CrystallizationResult,
} from './crystallize'
import { appendEntry } from './evolution-log'
import { dream, type DreamResult, type DreamOptions, type DreamDeps } from '@src/memory/dream'
import { discoverConfiguredSkills, getSkillCatalog } from '@src/tools/skill-manager'
import type { TranscriptStore } from '@src/memory/transcripts'

// ── Types ──────────────────────────────────────────────────────────

export interface RSIOrchestratorOptions {
  config: OuroborosConfig
  llm: LanguageModel
  onEvent?: RSIEventHandler
  basePath?: string
  /**
   * Optional transcript store. When provided, the dream cycle's transcript
   * analysis (`mode: 'full' | 'propose-only'`) reads recent sessions from it;
   * when omitted, those modes silently skip the transcript-analysis stage and
   * only structured-memory consolidation runs.
   */
  transcriptStore?: TranscriptStore
}

// ── Orchestrator ───────────────────────────────────────────────────

export class RSIOrchestrator {
  private config: OuroborosConfig
  private llm: LanguageModel
  private onEvent: RSIEventHandler
  private basePath: string | undefined
  private transcriptStore: TranscriptStore | undefined

  constructor(options: RSIOrchestratorOptions) {
    this.config = options.config
    this.llm = options.llm
    this.onEvent = options.onEvent ?? (() => {})
    this.basePath = options.basePath
    this.transcriptStore = options.transcriptStore
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
      discoverConfiguredSkills(
        this.config.skillDirectories,
        this.basePath,
        this.config.disabledSkills,
      )
      const existingSkills = getSkillCatalog()
      const result = await reflect(taskSummary, existingSkills, this.llm)

      if (result.ok) {
        appendEntry(
          {
            type: 'memory-updated',
            summary: `Reflected on: ${taskSummary.slice(0, 100)}`,
            details: {
              skillName: result.value.proposedSkillName,
            },
            motivation: `Novelty: ${result.value.novelty}, Generalizability: ${result.value.generalizability}, shouldCrystallize: ${result.value.shouldCrystallize}`,
          },
          this.basePath,
        )

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
      discoverConfiguredSkills(
        this.config.skillDirectories,
        this.basePath,
        this.config.disabledSkills,
      )
      const existingSkills = getSkillCatalog()
      const cwd = this.basePath ?? process.cwd()

      const result = await crystallize(taskSummary, {
        llm: this.llm,
        existingSkills,
        transcript,
        skillDirs: {
          staging: resolve(cwd, 'skills/staging'),
          generated: resolve(cwd, 'skills/generated'),
          core: resolve(cwd, 'skills/core'),
        },
        noveltyThreshold: this.config.rsi.noveltyThreshold,
      })

      if (result.ok) {
        const crystalResult = result.value

        appendEntry(
          {
            type:
              crystalResult.outcome === 'promoted'
                ? 'skill-promoted'
                : crystalResult.outcome === 'test-failed'
                  ? 'skill-failed'
                  : 'skill-created',
            summary: `Crystallization: ${crystalResult.outcome}${crystalResult.skillName ? ` (${crystalResult.skillName})` : ''}`,
            details: {
              skillName: crystalResult.skillName,
            },
            motivation: `Pipeline outcome: ${crystalResult.outcome}`,
          },
          this.basePath,
        )

        const sourceSessionIds =
          crystalResult.reflection?.sourceReferences
            ?.flatMap((reference) => reference.sessionId)
            .filter((value, index, values) => values.indexOf(value) === index) ?? []
        const repeatCount = crystalResult.reflection?.repeatCount ?? sourceSessionIds.length
        if (sourceSessionIds.length > 0 && crystalResult.skillName) {
          appendEntry(
            {
              type: 'skill-proposed-from-observations',
              summary: `Observation-backed skill proposal: ${crystalResult.skillName}`,
              details: {
                skillName: crystalResult.skillName,
                sourceSessionIds,
                sourceObservationIds:
                  crystalResult.reflection?.sourceReferences?.flatMap(
                    (reference) => reference.observationIds,
                  ) ?? [],
                repeatCount,
              },
              motivation:
                'Repeated observation patterns can be audited independently from transcripts.',
            },
            this.basePath,
          )

          this.emitEvent({
            type: 'rsi-skill-proposed-from-observations',
            skillName: crystalResult.skillName,
            repeatCount,
            sourceSessionIds,
            reason: 'crystallization',
          })
        }

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
        ...(options?.sessionCount !== undefined ? { sessionCount: options.sessionCount } : {}),
      }

      // Build dream dependencies. The LLM call mirrors how reflect()/generateSkill()
      // talk to the model in crystallize.ts so dream prompts share the same
      // reasoning-model handling and bad-request retry behavior. Session
      // accessors come from the transcript store when one is configured;
      // otherwise we keep the legacy no-op shape so non-RPC callers (e.g. the
      // CLI when no DB is open) still consolidate structured memory.
      const llm = this.llm
      const transcriptStore = this.transcriptStore
      const deps: DreamDeps = {
        generateFn: async (prompt: string) => {
          const r = await generateRSIResponse(
            llm,
            [{ role: 'user', content: prompt }],
            buildRSILLMCallOptions(llm, 0.2, 2048),
          )
          return r.ok ? ok(r.value.text) : err(r.error)
        },
        getRecentSessions: transcriptStore
          ? (limit) => transcriptStore.getRecentSessions(limit)
          : () => ok([]),
        getSession: transcriptStore
          ? (sessionId) => transcriptStore.getSession(sessionId)
          : () => err(new Error('No session store configured')),
        basePath: this.basePath,
      }

      const result = await dream(deps, dreamOpts)

      if (result.ok) {
        const dreamResult = result.value

        appendEntry(
          {
            type: 'memory-consolidated',
            summary: `Dream cycle: ${dreamResult.topicsMerged} merged, ${dreamResult.topicsCreated} created, ${dreamResult.topicsPruned} pruned`,
            details: {
              sessionId: `dream-${Date.now()}`,
            },
            motivation: 'Memory consolidation via dream cycle',
          },
          this.basePath,
        )

        this.emitEvent({
          type: 'rsi-dream',
          result: dreamResult,
        })

        for (const item of dreamResult.durablePromotions) {
          appendEntry(
            {
              type: 'durable-memory-promoted',
              summary: `Promoted durable memory: ${item}`,
              details: {
                sessionId: `dream-${Date.now()}`,
                item,
                metadata: {
                  contradictionsResolved: dreamResult.contradictionsResolvedEntries,
                },
              },
              motivation:
                'Dream consolidation promoted validated structured memory into durable memory.',
            },
            this.basePath,
          )

          this.emitEvent({
            type: 'rsi-durable-memory-promoted',
            sessionId: undefined,
            item,
            sourceSessionIds: [],
            reason: 'dream',
          })
        }

        for (const item of dreamResult.durablePrunes) {
          appendEntry(
            {
              type: 'durable-memory-pruned',
              summary: `Pruned durable memory: ${item}`,
              details: {
                sessionId: `dream-${Date.now()}`,
                item,
                metadata: {
                  contradictionsResolved: dreamResult.contradictionsResolvedEntries,
                },
              },
              motivation: 'Dream consolidation removed stale or contradicted durable memory.',
            },
            this.basePath,
          )

          this.emitEvent({
            type: 'rsi-durable-memory-pruned',
            sessionId: undefined,
            item,
            reason: 'dream',
          })
        }
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
    appendEntry(
      {
        type: 'skill-failed',
        summary: `RSI error in ${stage}: ${error.message}`,
        details: {},
        motivation: `Error during RSI ${stage} stage`,
      },
      this.basePath,
    )

    this.emitEvent({
      type: 'rsi-error',
      stage,
      error,
    })
  }
}
