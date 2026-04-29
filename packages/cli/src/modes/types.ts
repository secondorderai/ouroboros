/**
 * Mode System — Core Types
 *
 * Modes are behavioral overlays on the agent loop. When active, a mode
 * injects a prompt section, filters the tool set, and can intercept
 * tool execution (e.g. blocking writes in plan mode).
 *
 * The framework is extensible — add new modes by creating a ModeDefinition
 * and registering it with the ModeManager.
 */

import type { Plan } from './plan/types'

/** Extensible union of mode identifiers. */
export type ModeId = 'plan'

/**
 * A mode definition describes how a mode alters agent behavior.
 * Registered with the ModeManager at startup.
 */
export interface ModeDefinition {
  /** Unique mode identifier. */
  id: ModeId

  /** Human-readable name shown in prompts and UI. */
  displayName: string

  /** System prompt section injected when this mode is active. */
  systemPromptSection: string

  /**
   * Tool names allowed in this mode. If undefined, all tools are allowed.
   * Mode-specific tools (enter-mode, submit-plan, exit-mode) are added automatically.
   */
  allowedTools?: string[]

  /**
   * Tool names blocked in this mode. Applied after allowedTools filter.
   * Takes precedence over allowedTools if a tool appears in both.
   */
  blockedTools?: string[]

  /** If true, the LLM can auto-detect and enter this mode. */
  autoDetectable: boolean

  /** Prompt fragment telling the LLM when/how to auto-trigger this mode. */
  autoDetectionHint?: string

  /**
   * Optional interceptor for bash commands in this mode.
   * Return null to allow the command, or a string error message to block it.
   */
  bashInterceptor?: (command: string) => string | null
}

/** Current mode state — either inactive or active with a specific mode. */
export type ModeState =
  | { status: 'inactive' }
  | { status: 'active'; modeId: ModeId; enteredAt: string }

/** Events emitted by the ModeManager. */
export type ModeEvent =
  | { type: 'mode-entered'; modeId: ModeId; displayName: string; reason: string }
  | { type: 'mode-exited'; modeId: ModeId; reason: string }
  | { type: 'plan-submitted'; plan: Plan }
