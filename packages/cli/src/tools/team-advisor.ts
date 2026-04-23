import { z } from 'zod'
import { adviseTeamSize } from '@src/team/advisor'
import {
  extractWorkflowRSICandidates,
  recordAgentOutcome,
  readAgentOutcomes,
  type AgentOutcomeInput,
} from '@src/team/reputation'
import { type Result, err, ok } from '@src/types'
import type { TypedToolExecute, ToolExecutionContext } from './types'

export const name = 'team_advisor'

export const description =
  'Recommend an orchestration shape, record agent/team outcomes, and extract RSI candidates from repeated successful workflows.'

export const schema = z.object({
  action: z.enum(['advise', 'record-outcome', 'extract-rsi-candidates']),
  taskSummary: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1)).optional(),
  sequentialDependencies: z.boolean().optional(),
  ambiguousInvestigation: z.boolean().optional(),
  taskIndependence: z.enum(['low', 'medium', 'high']).optional(),
  permissionsRequired: z
    .array(z.enum(['read-only', 'workspace-write', 'shell', 'network']))
    .optional(),
  likelyTokenCost: z.enum(['low', 'medium', 'high']).optional(),
  expectedTestCost: z.enum(['low', 'medium', 'high']).optional(),
  userRiskSetting: z.enum(['low', 'normal', 'high']).optional(),
  outcome: z
    .object({
      projectId: z.string().trim().min(1),
      role: z.string().trim().min(1),
      agentId: z.string().trim().min(1).optional(),
      runId: z.string().trim().min(1).optional(),
      workflowPattern: z.string().trim().min(1).optional(),
      workflowSteps: z.array(z.string().trim().min(1)).optional(),
      categories: z.array(z.enum(['task', 'finding', 'patch', 'test', 'override'])).optional(),
      metrics: z
        .object({
          completedTasks: z.number().int().nonnegative().optional(),
          failedTasks: z.number().int().nonnegative().optional(),
          acceptedFindings: z.number().int().nonnegative().optional(),
          rejectedFindings: z.number().int().nonnegative().optional(),
          acceptedPatches: z.number().int().nonnegative().optional(),
          rejectedPatches: z.number().int().nonnegative().optional(),
          testsPassed: z.number().int().nonnegative().optional(),
          testsFailed: z.number().int().nonnegative().optional(),
          userOverrides: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
      notes: z.string().trim().min(1).optional(),
      recordedAt: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
  minimumSuccessfulRuns: z.number().int().positive().optional(),
})

function requireContext(context?: ToolExecutionContext): Result<ToolExecutionContext> {
  if (!context) return err(new Error('team_advisor requires an active agent execution context.'))
  return ok(context)
}

export const execute: TypedToolExecute<typeof schema, unknown> = async (
  args,
  maybeContext,
): Promise<Result<unknown>> => {
  const contextResult = requireContext(maybeContext)
  if (!contextResult.ok) return contextResult
  const context = contextResult.value

  if (args.action === 'advise') {
    if (!args.taskSummary) return err(new Error('team_advisor advise requires taskSummary.'))
    return adviseTeamSize({
      taskSummary: args.taskSummary,
      files: args.files,
      sequentialDependencies: args.sequentialDependencies,
      ambiguousInvestigation: args.ambiguousInvestigation,
      taskIndependence: args.taskIndependence,
      permissionsRequired: args.permissionsRequired,
      likelyTokenCost: args.likelyTokenCost,
      expectedTestCost: args.expectedTestCost,
      userRiskSetting: args.userRiskSetting,
    })
  }

  if (args.action === 'record-outcome') {
    if (!args.outcome) return err(new Error('team_advisor record-outcome requires outcome.'))
    return recordAgentOutcome(args.outcome as AgentOutcomeInput, context.basePath)
  }

  const outcomesResult = readAgentOutcomes(context.basePath)
  if (!outcomesResult.ok) return outcomesResult
  return extractWorkflowRSICandidates(outcomesResult.value, {
    minimumSuccessfulRuns: args.minimumSuccessfulRuns,
  })
}
