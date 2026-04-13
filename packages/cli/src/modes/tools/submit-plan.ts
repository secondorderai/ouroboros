/**
 * Tool: submit-plan
 *
 * Submits a structured plan for user approval while in plan mode.
 * The tool result instructs the LLM to present the plan and ask
 * the user for approval via the ask-user tool.
 */

import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from '@src/tools/types'
import type { ModeManager } from '../manager'
import type { Plan, PlanStep } from '../plan/types'

let modeManager: ModeManager | null = null

export function setModeManager(manager: ModeManager): void {
  modeManager = manager
}

export const name = 'submit-plan'

export const description =
  'Submit a structured plan for user approval. Call this after exploring the codebase in plan mode. ' +
  'The plan must include a title, summary, ordered steps with target files, and explored files. ' +
  'After submitting, present the plan to the user and ask for approval using ask-user.'

const planStepSchema = z.object({
  description: z.string().describe('What this step does (imperative form)'),
  targetFiles: z.array(z.string()).describe('Files this step will read or modify'),
  tools: z.array(z.string()).describe('Tools this step anticipates using'),
  dependsOn: z.array(z.number()).optional().describe('Indices of prerequisite steps (0-based)'),
})

export const schema = z.object({
  title: z.string().describe('Short plan title'),
  summary: z.string().describe('One-paragraph summary of the approach'),
  steps: z.array(planStepSchema).min(1).describe('Ordered steps to execute'),
  exploredFiles: z.array(z.string()).describe('Files explored during planning (for context)'),
})

export const execute: TypedToolExecute<typeof schema, string> = async (
  args,
): Promise<Result<string>> => {
  if (!modeManager) {
    return err(new Error('Mode system not initialized.'))
  }

  const state = modeManager.getActiveMode()
  if (state.status !== 'active' || state.modeId !== 'plan') {
    return err(new Error('submit-plan can only be called while in plan mode.'))
  }

  const plan: Plan = {
    title: args.title,
    summary: args.summary,
    steps: args.steps as PlanStep[],
    exploredFiles: args.exploredFiles,
    status: 'submitted',
  }

  modeManager.submitPlan(plan)

  // Format the plan for presentation
  const stepsFormatted = plan.steps
    .map((step, i) => {
      const deps = step.dependsOn?.length
        ? ` (after step ${step.dependsOn.map((d) => d + 1).join(', ')})`
        : ''
      const files = step.targetFiles.length ? `\n   Files: ${step.targetFiles.join(', ')}` : ''
      return `${i + 1}. ${step.description}${deps}${files}`
    })
    .join('\n')

  return ok(
    `Plan submitted for approval.\n\n` +
      `## ${plan.title}\n\n` +
      `${plan.summary}\n\n` +
      `### Steps\n${stepsFormatted}\n\n` +
      `### Files Explored\n${plan.exploredFiles.join(', ')}\n\n` +
      `Now present this plan to the user. Ask them to approve, reject (with feedback), or cancel. ` +
      `Do NOT call ask-user — simply present the plan as text and end your turn. ` +
      `The user will respond with their decision in their next message.`,
  )
}
