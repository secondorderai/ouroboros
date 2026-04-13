/**
 * Tool: enter-mode
 *
 * Enters a named mode (e.g. "plan"). Called by the LLM either
 * when it auto-detects a complex task or when the user explicitly
 * requests planning.
 */

import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from '@src/tools/types'
import type { ModeManager } from '../manager'

// Module-level reference set during CLI initialization.
let modeManager: ModeManager | null = null

export function setModeManager(manager: ModeManager): void {
  modeManager = manager
}

export const name = 'enter-mode'

export const description =
  'Enter a behavioral mode that changes how you work. ' +
  'Use mode="plan" to enter Plan Mode for complex, multi-step tasks. ' +
  'In Plan Mode you explore the codebase (read-only) and produce a structured plan for user approval before making changes.'

export const schema = z.object({
  mode: z.enum(['plan']).describe('The mode to enter'),
  reason: z
    .string()
    .optional()
    .describe('Why this mode is being entered (e.g. "complex multi-file refactor")'),
})

export const execute: TypedToolExecute<typeof schema, string> = async (
  args,
): Promise<Result<string>> => {
  if (!modeManager) {
    return err(new Error('Mode system not initialized.'))
  }

  const result = modeManager.enterMode(args.mode, args.reason)
  if (!result.ok) {
    return result
  }

  return ok(
    `Entered ${result.value} mode. ` +
      `You are now in a read-only exploration phase. ` +
      `Explore the codebase to understand the task, then call submit-plan with your structured plan.`,
  )
}
