import { z } from 'zod'
import type { Result } from '@src/types'

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
  execute: (args: any) => Promise<Result<unknown>>
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
