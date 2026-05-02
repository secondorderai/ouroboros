/**
 * Reflect Tool
 *
 * Thin wrapper around the RSI crystallize module's `reflect()` function.
 * Evaluates whether a completed task contains a generalizable pattern
 * worth crystallizing into a reusable skill.
 *
 * Follows the tool registry interface:
 * name, description, schema (Zod), execute (async fn returning Result).
 */
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { type Result, ok, err } from '@src/types'
import {
  reflect,
  shouldCrystallize as checkShouldCrystallize,
  type ReflectionRecord,
} from '@src/rsi/crystallize'
import { getSkillCatalog } from '@src/tools/skill-manager'
import type { TranscriptStore } from '@src/memory/transcripts'

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'reflect'

export const description =
  'Evaluate whether a completed task contains a generalizable pattern worth crystallizing into a reusable skill. ' +
  'Returns a structured reflection record with novelty and generalizability scores.'

export const schema = z.object({
  taskSummary: z.string().describe('Description of the completed task and its solution approach'),
})

export interface ReflectToolInput {
  taskSummary: string
}

/** Dependencies injected at tool registration time */
export interface ReflectToolDeps {
  /** Language model to use for reflection */
  llm?: LanguageModel
  /** Transcript store for persisting reflection records */
  transcriptStore?: TranscriptStore
  /** Active session ID for transcript storage */
  sessionId?: string
  /** Novelty threshold for crystallization decision (default: 0.7) */
  noveltyThreshold?: number
}

/**
 * Create the execute function with injected dependencies.
 * This allows the tool to be configured with a specific LLM,
 * transcript store, and threshold at startup.
 */
export function createExecute(deps: ReflectToolDeps = {}) {
  return async (input: ReflectToolInput): Promise<Result<ReflectionRecord>> => {
    if (!deps.llm) {
      return err(
        new Error(
          'Reflect tool requires an LLM instance. ' +
            'Configure it via createExecute({ llm: ... }).',
        ),
      )
    }

    const existingSkills = getSkillCatalog()
    const threshold = deps.noveltyThreshold ?? 0.7

    const reflectResult = await reflect(input.taskSummary, existingSkills, deps.llm)

    if (!reflectResult.ok) {
      return reflectResult
    }

    const record = reflectResult.value

    // Override shouldCrystallize based on configured threshold
    const crystallize = checkShouldCrystallize(record, threshold)
    const finalRecord: ReflectionRecord = {
      ...record,
      shouldCrystallize: crystallize,
    }

    // Store reflection record in transcript if available
    if (deps.transcriptStore && deps.sessionId) {
      const storeResult = deps.transcriptStore.addMessage(deps.sessionId, {
        role: 'tool-result',
        content: JSON.stringify(finalRecord),
        toolName: 'reflect',
        toolArgs: { taskSummary: input.taskSummary },
      })
      if (!storeResult.ok) {
        // Log but don't fail the reflection — the record is still valid
        console.warn(
          `[reflect] Warning: Failed to store reflection record: ${storeResult.error.message}`,
        )
      }
    }

    return ok(finalRecord)
  }
}

/**
 * Default execute function (no LLM configured).
 * In production, use createExecute() with proper dependencies.
 */
export const execute = createExecute()
export const tier = 2
