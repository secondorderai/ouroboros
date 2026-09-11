import type { z } from 'zod'
import type { PlanResult, QueueState, Snapshot } from './model'

type Plan = z.infer<typeof PlanResult>

export async function runPlanningPhase(
  snapshot: Snapshot,
  operations: {
    infer(): Promise<Plan>
    writePlan(plan: Plan): Promise<void>
    checkpoint(): Promise<void>
    publish(plan: Plan): Promise<void>
    update(patch: Partial<QueueState>): Promise<void>
  },
): Promise<void> {
  snapshot.plan ??= await operations.infer()
  await operations.writePlan(snapshot.plan)
  await operations.update({
    reason: 'Plan generated. Saving its encrypted checkpoint before requesting approval.',
  })
  // A resume reuses this saved report if publication fails. An approval prompt
  // must never point to a checkpoint that does not contain the displayed plan.
  await operations.checkpoint()
  await operations.publish(snapshot.plan)
  await operations.update({
    status: 'waiting-approval',
    reason: 'Plan ready for human approval.',
    activeRunId: null,
  })
}
