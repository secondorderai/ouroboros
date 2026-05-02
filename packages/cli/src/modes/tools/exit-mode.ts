/**
 * Tool: exit-mode
 *
 * Exits the currently active mode. Called after a plan is approved
 * (to begin execution) or when the user cancels.
 */

import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from '@src/tools/types'
import type { ModeManager } from '../manager'

let modeManager: ModeManager | null = null

export function setModeManager(manager: ModeManager): void {
  modeManager = manager
}

export const name = 'exit-mode'

export const description =
  'Exit the currently active mode. Call this after a plan is approved to begin execution, ' +
  'or when the user cancels the planning process.'

export const schema = z.object({
  reason: z
    .string()
    .optional()
    .describe('Why the mode is being exited (e.g. "plan approved", "user cancelled")'),
})

export const execute: TypedToolExecute<typeof schema, string> = async (
  args,
): Promise<Result<string>> => {
  if (!modeManager) {
    return err(new Error('Mode system not initialized.'))
  }

  const result = modeManager.exitMode(args.reason)
  if (!result.ok) {
    return result
  }

  return ok(
    `Exited ${result.value} mode. All tools are now available. ` +
      `You may proceed with implementation.`,
  )
}
export const tier = 1
