import { z } from 'zod'
import type { Result } from '@src/types'
import type { OuroborosConfig } from '@src/config'
import type { BuildSystemPromptOptions } from '@src/llm/prompt'
import type { TranscriptStore } from '@src/memory/transcripts'
import type { LanguageModel } from 'ai'
import type { ToolRegistry } from './registry'
import type { SkillActivationResult, SkillCatalogEntry } from './skill-manager'
import type { AgentEvent } from '@src/agent'
import type { PermissionLease } from '@src/permission-lease'
import type { TaskGraphStore } from '@src/team/task-graph'

export interface ToolExecutionContext {
  model: LanguageModel
  toolRegistry: ToolRegistry
  config: OuroborosConfig
  transcriptStore?: TranscriptStore
  basePath?: string
  sessionId?: string
  agentId: string
  permissionLease?: PermissionLease
  taskGraphStore?: TaskGraphStore
  systemPromptBuilder?: (options: BuildSystemPromptOptions) => string
  memoryProvider?: () => string
  skillCatalogProvider?: () => SkillCatalogEntry[]
  /** Skill currently activated for the parent run. Spawned subagents may opt to inherit it. */
  activatedSkill?: SkillActivationResult
  emitEvent?: (event: AgentEvent) => void
  /**
   * Fires when the user cancels the in-flight agent run. Cancellation-aware
   * tools (bash, web-fetch, spawn-agent) should listen and bail with a
   * `Result.err` so the loop can return a `cancelled` stop reason promptly.
   */
  abortSignal?: AbortSignal
}

/**
 * The base (type-erased) tool interface used by the registry to store
 * heterogeneous tools. The `execute` function accepts `unknown` because the
 * registry validates args via the Zod schema before calling it.
 */
export interface ToolDefinition {
  /** Unique tool name (kebab-case by convention, e.g. "file-read"). */
  name: string

  /** Human-readable description shown to the LLM in the system prompt. */
  description: string

  /** Zod schema for argument validation. */
  schema: z.ZodType<any>

  /**
   * Execute the tool. The registry always calls `schema.parse(args)` first,
   * so the value passed here is guaranteed to be valid at runtime.
   * Must never throw — return a Result instead.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context?: ToolExecutionContext) => Promise<Result<unknown>>
}

/**
 * A strongly-typed tool definition. Individual tool files use this to get
 * compile-time checking on their `execute` function's parameter and return types.
 *
 * Usage in a tool file:
 * ```ts
 * export const execute: TypedToolExecute<typeof schema, MyResult> = async (args) => { ... }
 * ```
 */
export type TypedToolExecute<TSchema extends z.ZodType<any>, TResult> = (
  args: z.infer<TSchema>,
  context?: ToolExecutionContext,
) => Promise<Result<TResult>>

/**
 * Metadata returned by `getTools()` — everything the system prompt builder needs
 * without exposing the execute function.
 */
export interface ToolMetadata {
  name: string
  description: string
  /** JSON Schema representation of the Zod schema (for system prompt injection). */
  parameters: Record<string, unknown>
}
