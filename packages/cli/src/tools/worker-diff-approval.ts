import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { collectWorkerDiff } from './worker-runtime'
import { type Result, err, ok } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'apply_worker_diff'

export const description =
  'Apply an isolated worker worktree diff to the parent workspace only after explicit parent approval. The tool never commits or automatically merges worker branches.'

export const workerDiffReviewStatusSchema = z.enum([
  'awaiting-review',
  'reviewed',
  'approved',
  'rejected',
  'applied',
  'blocked',
])

export const workerDiffTestResultSchema = z
  .object({
    command: z.string().trim().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative().optional(),
    outputExcerpt: z.string().optional(),
    status: z.enum(['passed', 'failed']),
  })
  .strict()

export const workerDiffContextSchema = z
  .object({
    taskId: z.string().trim().min(1),
    branchName: z.string().trim().min(1).optional(),
    worktreePath: z.string().trim().min(1),
    changedFiles: z.array(z.string().trim().min(1)).default([]),
    diff: z.string().default(''),
    diffLineCount: z.number().int().nonnegative().optional(),
    testResult: workerDiffTestResultSchema.optional(),
    unresolvedRisks: z.array(z.string().trim().min(1)).default([]),
    reviewStatus: workerDiffReviewStatusSchema.optional(),
  })
  .strict()

export const schema = z.object({
  workerDiff: workerDiffContextSchema.describe('Reviewable worker diff result to apply'),
  action: z
    .enum(['apply-patch'])
    .default('apply-patch')
    .describe('Application strategy. apply-patch applies the worker diff without committing.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Why the parent is requesting to apply this worker output.'),
})

export type WorkerDiffReviewStatus = z.infer<typeof workerDiffReviewStatusSchema>
export type WorkerDiffContext = z.infer<typeof workerDiffContextSchema>

export interface WorkerDiffApprovalDetails extends WorkerDiffContext {
  approvalId: string
  action: 'apply-patch'
  description: string
  createdAt: string
  risk: 'medium' | 'high'
}

export interface WorkerDiffApprovalRequest {
  approvalId: string
  description: string
  details: WorkerDiffApprovalDetails
}

export interface WorkerDiffApprovalDecision {
  approved: true
  approvedAt: string
}

type WorkerDiffApprovalHandler = (
  request: WorkerDiffApprovalRequest,
) => Promise<Result<WorkerDiffApprovalDecision>>

let workerDiffApprovalHandler: WorkerDiffApprovalHandler | null = null

export interface ApplyWorkerDiffResult {
  status: 'applied'
  taskId: string
  action: 'apply-patch'
  changedFiles: string[]
  approvedAt: string
  appliedAt: string
  message: string
}

export function setWorkerDiffApprovalHandler(handler: WorkerDiffApprovalHandler | null): void {
  workerDiffApprovalHandler = handler
}

export function buildWorkerDiffApprovalDetails(
  workerDiff: WorkerDiffContext,
  action: 'apply-patch',
  reason?: string,
): WorkerDiffApprovalDetails {
  const createdAt = new Date().toISOString()
  const changedCount = workerDiff.changedFiles.length
  const risk =
    workerDiff.unresolvedRisks.length > 0 || workerDiff.testResult?.status === 'failed'
      ? 'high'
      : 'medium'
  const description =
    reason ??
    `Apply worker output for ${workerDiff.taskId}: ${changedCount} changed file${changedCount === 1 ? '' : 's'}`

  return {
    ...workerDiff,
    approvalId: `worker-diff-approval-${workerDiff.taskId}-${crypto.randomUUID()}`,
    action,
    description,
    createdAt,
    risk,
    reviewStatus: 'awaiting-review',
  }
}

export async function requestWorkerDiffApproval(
  workerDiff: WorkerDiffContext,
  action: 'apply-patch',
  reason?: string,
): Promise<Result<WorkerDiffApprovalDecision>> {
  if (!workerDiffApprovalHandler) {
    return err(new Error('Worker diff approval is required, but no approval handler is active.'))
  }

  const details = buildWorkerDiffApprovalDetails(workerDiff, action, reason)
  return workerDiffApprovalHandler({
    approvalId: details.approvalId,
    description: details.description,
    details,
  })
}

export const execute: TypedToolExecute<typeof schema, ApplyWorkerDiffResult> = async (
  args,
  context,
): Promise<Result<ApplyWorkerDiffResult>> => {
  if (!context?.basePath) {
    return err(new Error('apply_worker_diff requires a parent workspace basePath.'))
  }

  const approval = await requestWorkerDiffApproval(args.workerDiff, args.action, args.reason)
  if (!approval.ok) {
    return approval
  }

  const latest = collectWorkerDiff(args.workerDiff.worktreePath)
  if (latest.changedFiles.length === 0 || latest.diff.trim().length === 0) {
    return err(new Error('Worker diff has no changes to apply.'))
  }

  const parentRoot = gitOutput(['rev-parse', '--show-toplevel'], context.basePath)
  if (!parentRoot) {
    return err(new Error('apply_worker_diff requires the parent workspace to be a git repository.'))
  }

  const check = gitApply(parentRoot, latest.diff, ['apply', '--check', '--whitespace=nowarn', '-'])
  if (!check.ok) return check

  const apply = gitApply(parentRoot, latest.diff, ['apply', '--whitespace=nowarn', '-'])
  if (!apply.ok) return apply

  return ok({
    status: 'applied',
    taskId: args.workerDiff.taskId,
    action: args.action,
    changedFiles: latest.changedFiles,
    approvedAt: approval.value.approvedAt,
    appliedAt: new Date().toISOString(),
    message:
      'Worker diff applied to the parent worktree without committing or merging the worker branch.',
  })
}

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function gitApply(cwd: string, patch: string, args: string[]): Result<void> {
  try {
    const patchInput = patch.endsWith('\n') ? patch : `${patch}\n`
    execFileSync('git', args, {
      cwd,
      input: patchInput,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return ok(undefined)
  } catch (e) {
    const error = e as { stderr?: Buffer | string; message?: string }
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf-8')
      : typeof error.stderr === 'string'
        ? error.stderr
        : ''
    return err(new Error(`Failed to apply worker diff: ${stderr.trim() || error.message}`))
  }
}
