/**
 * ModeManager — Central controller for the mode system.
 *
 * Lives as a peer to the Agent class. The Agent consults the ModeManager
 * at two points in its loop:
 * - buildCurrentSystemPrompt(): gets the mode's prompt overlay
 * - buildToolDefinitions(): gets the filtered tool set
 *
 * The ModeManager also handles plan lifecycle (submit/approve/reject)
 * and bash command interception.
 */

import type { Result } from '@src/types'
import { ok, err } from '@src/types'
import type { ToolMetadata } from '@src/tools/types'
import type { ModeId, ModeDefinition, ModeState, ModeEvent } from './types'
import type { Plan } from './plan/types'

export type ModeEventHandler = (event: ModeEvent) => void

export class ModeManager {
  private state: ModeState = { status: 'inactive' }
  private modes = new Map<ModeId, ModeDefinition>()
  private currentPlan: Plan | null = null
  private onEvent: ModeEventHandler

  constructor(onEvent?: ModeEventHandler) {
    this.onEvent = onEvent ?? (() => {})
  }

  /** Register a mode definition. Call at startup. */
  registerMode(mode: ModeDefinition): void {
    this.modes.set(mode.id, mode)
  }

  /** Enter a mode. Returns the mode's display name on success. */
  enterMode(modeId: ModeId, reason?: string): Result<string> {
    if (this.state.status === 'active') {
      return err(
        new Error(`Already in ${this.state.modeId} mode. Exit first before entering a new mode.`),
      )
    }

    const mode = this.modes.get(modeId)
    if (!mode) {
      return err(new Error(`Unknown mode: ${modeId}`))
    }

    this.state = { status: 'active', modeId, enteredAt: new Date().toISOString() }
    this.currentPlan = null

    this.onEvent({
      type: 'mode-entered',
      modeId,
      displayName: mode.displayName,
      reason: reason ?? 'explicit',
    })

    return ok(mode.displayName)
  }

  /** Exit the current mode. */
  exitMode(reason?: string): Result<string> {
    if (this.state.status === 'inactive') {
      return err(new Error('No mode is currently active.'))
    }

    const modeId = this.state.modeId
    const mode = this.modes.get(modeId)

    this.state = { status: 'inactive' }
    this.currentPlan = null

    this.onEvent({
      type: 'mode-exited',
      modeId,
      reason: reason ?? 'explicit',
    })

    return ok(mode?.displayName ?? modeId)
  }

  /** Get the current mode state. */
  getActiveMode(): ModeState {
    return this.state
  }

  /**
   * Get the prompt overlay for the current state.
   *
   * When a mode is active: returns the mode's system prompt section.
   * When no mode is active: returns auto-detection hints for all
   * auto-detectable modes so the LLM knows when to enter them.
   */
  getPromptOverlay(): { section?: string; autoDetectionHints: string[] } {
    if (this.state.status === 'active') {
      const mode = this.modes.get(this.state.modeId)
      return {
        section: mode?.systemPromptSection,
        autoDetectionHints: [],
      }
    }

    // Collect auto-detection hints from all registered modes
    const hints: string[] = []
    for (const mode of this.modes.values()) {
      if (mode.autoDetectable && mode.autoDetectionHint) {
        hints.push(mode.autoDetectionHint)
      }
    }

    return { autoDetectionHints: hints }
  }

  /**
   * Filter tools based on the active mode's allow/block lists.
   * Mode-specific tools (enter-mode, submit-plan, exit-mode) are
   * conditionally included based on mode state.
   */
  filterTools(tools: ToolMetadata[]): ToolMetadata[] {
    // enter-mode is always visible (for auto-detection)
    // submit-plan and exit-mode are only visible when a mode is active
    const modeToolVisibility: Record<string, boolean> = {
      'enter-mode': this.state.status === 'inactive',
      'submit-plan': this.state.status === 'active',
      'exit-mode': this.state.status === 'active',
    }

    if (this.state.status === 'inactive') {
      // No mode active — show all tools except mode-only tools
      return tools.filter((t) => modeToolVisibility[t.name] !== false)
    }

    const mode = this.modes.get(this.state.modeId)
    if (!mode) return tools

    const allowed = mode.allowedTools ? new Set(mode.allowedTools) : null
    const blocked = mode.blockedTools ? new Set(mode.blockedTools) : new Set<string>()

    return tools.filter((t) => {
      // Check mode tool visibility first
      if (modeToolVisibility[t.name] !== undefined) {
        return modeToolVisibility[t.name]
      }

      // Apply block list (takes precedence)
      if (blocked.has(t.name)) return false

      // Apply allow list
      if (allowed && !allowed.has(t.name)) return false

      return true
    })
  }

  /**
   * Intercept a bash command when a mode is active.
   * Returns null if the command is allowed, or an error message if blocked.
   */
  interceptBash(command: string): string | null {
    if (this.state.status === 'inactive') return null

    const mode = this.modes.get(this.state.modeId)
    if (!mode?.bashInterceptor) return null

    return mode.bashInterceptor(command)
  }

  /** Store a submitted plan. */
  submitPlan(plan: Plan): void {
    this.currentPlan = { ...plan, status: 'submitted' }
    this.onEvent({
      type: 'plan-submitted',
      plan: this.currentPlan,
    })
  }

  /** Mark the current plan as approved and return it. */
  approvePlan(): Result<Plan> {
    if (!this.currentPlan) {
      return err(new Error('No plan has been submitted.'))
    }
    this.currentPlan = { ...this.currentPlan, status: 'approved' }
    return ok(this.currentPlan)
  }

  /** Mark the current plan as rejected with feedback. */
  rejectPlan(feedback: string): void {
    if (this.currentPlan) {
      this.currentPlan = { ...this.currentPlan, status: 'rejected', feedback }
    }
  }

  /** Get the current plan (if any). */
  getCurrentPlan(): Plan | null {
    return this.currentPlan
  }
}
