/**
 * Discriminated union Result type used by all tools.
 * Convention: never throw — always return a Result.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

export type PermissionConfig = {
  tier0: boolean
  tier1: boolean
  tier2: boolean
  tier3: boolean
  tier4: boolean
  canInvokeAgents?: string[]
}

export type AgentMode = 'primary' | 'subagent' | 'all'

export type AgentDefinition = {
  id: string
  description: string
  mode: AgentMode
  prompt: string
  model?: string
  permissions?: PermissionConfig
  hidden?: boolean
  phaseGate?: string
  maxSteps?: number
}

/** Create a successful Result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Create a failed Result */
export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error }
}
