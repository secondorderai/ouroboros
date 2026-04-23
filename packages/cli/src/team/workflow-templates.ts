import { err, ok, type Result } from '@src/types'
import type { CreateTaskGraphInput, CreateTaskNodeInput } from './task-graph'
import type { AgentVerdict } from '@src/tools/subagent-synthesis'
import type { WorkerDiffContext } from '@src/tools/worker-diff-approval'

export const WORKFLOW_TEMPLATE_NAMES = [
  'parallel-investigation',
  'pre-merge-red-team',
  'architecture-decision',
  'review-triad',
] as const

export type WorkflowTemplateName = (typeof WORKFLOW_TEMPLATE_NAMES)[number]

export interface WorkflowTemplateInput {
  template: WorkflowTemplateName
  taskContext: string
  name?: string
}

export interface DebateEvidence {
  id: string
  claim: string
  source: string
  excerpt?: string
}

export interface DebateStatement {
  id: string
  agentId?: string
  text: string
  evidenceIds: string[]
}

export interface DebateContradiction {
  id: string
  topic: string
  claims: string[]
  reason: string
}

export interface DebateRecord {
  hypothesis: string
  objections: DebateStatement[]
  rebuttals: DebateStatement[]
  evidence: DebateEvidence[]
  finalVerdict: {
    claim: string
    evidenceIds: string[]
    decision: 'accept' | 'reject' | 'needs-work'
  }
  unresolvedRisks: string[]
  contradictions: DebateContradiction[]
}

export interface DebateValidation {
  canCompleteAutomatically: boolean
  blockedReasons: string[]
}

export interface BlindRedTeamContext {
  taskContext: string
  workerDiff: WorkerDiffContext
}

interface WorkerOutputForReview extends Partial<WorkerDiffContext> {
  taskId: string
  worktreePath: string
  changedFiles: string[]
  diff: string
  rationale?: unknown
  reasoning?: unknown
}

function task(
  id: string,
  title: string,
  description: string,
  dependencies: string[] = [],
  requiredArtifacts: string[] = [],
): CreateTaskNodeInput {
  return {
    id,
    title,
    description,
    dependencies,
    requiredArtifacts,
    qualityGates: [
      {
        id: `${id}-evidence-gate`,
        description: 'Task output cites concrete evidence for material claims.',
      },
    ],
  }
}

function graph(name: string, tasks: CreateTaskNodeInput[]): CreateTaskGraphInput {
  return { name, tasks }
}

export function createWorkflowTemplate(input: WorkflowTemplateInput): Result<CreateTaskGraphInput> {
  const taskContext = input.taskContext.trim()
  if (!taskContext) return err(new Error('Workflow task context is required'))

  switch (input.template) {
    case 'parallel-investigation':
      return ok(
        graph(input.name ?? 'Parallel Investigation', [
          task(
            'explorer-primary',
            'Explore primary implementation path',
            `Investigate the main implementation path for this task:\n${taskContext}`,
            [],
            ['evidence-backed findings'],
          ),
          task(
            'explorer-alternative',
            'Explore alternative implementation path',
            `Investigate a materially different approach for this task:\n${taskContext}`,
            [],
            ['evidence-backed findings'],
          ),
          task(
            'explorer-risk',
            'Explore risks and edge cases',
            `Investigate failure modes, constraints, and edge cases for this task:\n${taskContext}`,
            [],
            ['risk register', 'evidence-backed findings'],
          ),
          task(
            'synthesis',
            'Synthesize investigation',
            'Compare explorer outputs, identify contradictions, and produce a final evidence-backed synthesis.',
            ['explorer-primary', 'explorer-alternative', 'explorer-risk'],
            ['debate record', 'final verdict'],
          ),
        ]),
      )
    case 'pre-merge-red-team':
      return ok(
        graph(input.name ?? 'Pre-merge Red Team', [
          task(
            'blind-red-team-review',
            'Blind red-team review',
            `Review only the task context and diff. Do not use worker rationale or hidden reasoning.\nTask context:\n${taskContext}`,
            [],
            ['review findings', 'evidence-backed objections'],
          ),
          task(
            'rebuttal',
            'Worker rebuttal',
            'Respond to red-team objections with evidence-backed rebuttals or accepted fixes.',
            ['blind-red-team-review'],
            ['rebuttals', 'accepted objections'],
          ),
          task(
            'red-team-verdict',
            'Red-team verdict',
            'Validate evidence, unresolved risks, and contradictions before allowing automatic completion.',
            ['rebuttal'],
            ['debate record', 'final verdict'],
          ),
        ]),
      )
    case 'architecture-decision':
      return ok(
        graph(input.name ?? 'Architecture Decision', [
          task(
            'hypothesis',
            'State architecture hypothesis',
            `Define the proposed architecture decision and success criteria:\n${taskContext}`,
            [],
            ['hypothesis'],
          ),
          task(
            'supporting-case',
            'Build supporting case',
            'Gather evidence for the proposed architecture decision.',
            ['hypothesis'],
            ['evidence-backed support'],
          ),
          task(
            'opposing-case',
            'Build opposing case',
            'Gather objections, alternatives, and risks for the proposed architecture decision.',
            ['hypothesis'],
            ['evidence-backed objections'],
          ),
          task(
            'decision-record',
            'Produce decision record',
            'Resolve objections and produce a verdict with unresolved risks called out.',
            ['supporting-case', 'opposing-case'],
            ['debate record', 'architecture decision verdict'],
          ),
        ]),
      )
    case 'review-triad':
      return ok(
        graph(input.name ?? 'Review Triad', [
          task(
            'correctness-review',
            'Correctness review',
            `Review correctness for this task:\n${taskContext}`,
            [],
            ['correctness findings'],
          ),
          task(
            'maintainability-review',
            'Maintainability review',
            `Review maintainability and integration risk for this task:\n${taskContext}`,
            [],
            ['maintainability findings'],
          ),
          task(
            'test-review',
            'Test review',
            `Review test coverage and regression risk for this task:\n${taskContext}`,
            [],
            ['test coverage findings'],
          ),
          task(
            'review-triad-verdict',
            'Review triad verdict',
            'Synthesize the three reviews and block automatic completion on contradictions or missing evidence.',
            ['correctness-review', 'maintainability-review', 'test-review'],
            ['debate record', 'final verdict'],
          ),
        ]),
      )
  }
}

export function createBlindRedTeamContext(
  taskContext: string,
  workerOutput: WorkerOutputForReview,
): BlindRedTeamContext {
  return {
    taskContext,
    workerDiff: {
      taskId: workerOutput.taskId,
      ...(workerOutput.branchName ? { branchName: workerOutput.branchName } : {}),
      worktreePath: workerOutput.worktreePath,
      changedFiles: [...workerOutput.changedFiles],
      diff: workerOutput.diff,
      ...(workerOutput.testResult ? { testResult: workerOutput.testResult } : {}),
      unresolvedRisks: [...(workerOutput.unresolvedRisks ?? [])],
      ...(workerOutput.reviewStatus ? { reviewStatus: workerOutput.reviewStatus } : {}),
    },
  }
}

export function createDebateRecordFromVerdict(
  hypothesis: string,
  verdict: AgentVerdict,
): DebateRecord {
  const evidence: DebateEvidence[] = verdict.supportingClaims.flatMap((claim, claimIndex) =>
    claim.evidence.map((item, evidenceIndex) => ({
      id: `claim-${claimIndex + 1}-evidence-${evidenceIndex + 1}`,
      claim: claim.claim,
      source: evidenceSource(item),
      excerpt: 'excerpt' in item ? item.excerpt : undefined,
    })),
  )
  const evidenceIds = evidence.map((item) => item.id)

  return {
    hypothesis,
    objections: verdict.reviewFindings.map((finding, index) => ({
      id: `objection-${index + 1}`,
      text: finding.body,
      evidenceIds: finding.evidence.map(
        (_, evidenceIndex) => `finding-${index + 1}-evidence-${evidenceIndex + 1}`,
      ),
    })),
    rebuttals: [],
    evidence,
    finalVerdict: {
      claim: verdict.consensus,
      evidenceIds,
      decision:
        verdict.conflictingClaims.length > 0 || evidenceIds.length === 0 ? 'needs-work' : 'accept',
    },
    unresolvedRisks: [...verdict.unresolvedRisks],
    contradictions: verdict.conflictingClaims.map((conflict, index) => ({
      id: `contradiction-${index + 1}`,
      topic: conflict.topic,
      reason: conflict.reason,
      claims: conflict.claims.map((claim) => claim.claim),
    })),
  }
}

function evidenceSource(
  item: AgentVerdict['supportingClaims'][number]['evidence'][number],
): string {
  if (item.type === 'file') return item.path
  if (item.type === 'command') return item.command
  return 'output'
}

export function validateDebateRecord(record: DebateRecord): DebateValidation {
  const blockedReasons: string[] = []
  const evidenceIds = new Set(record.evidence.map((item) => item.id))

  if (!record.hypothesis.trim()) blockedReasons.push('Debate hypothesis is required.')
  if (!Array.isArray(record.objections)) blockedReasons.push('Debate objections are required.')
  if (!Array.isArray(record.rebuttals)) blockedReasons.push('Debate rebuttals are required.')
  if (!Array.isArray(record.evidence)) blockedReasons.push('Debate evidence is required.')
  if (!record.finalVerdict.claim.trim()) blockedReasons.push('Final verdict claim is required.')

  const verdictEvidenceIds = record.finalVerdict.evidenceIds.filter((id) => evidenceIds.has(id))
  if (verdictEvidenceIds.length === 0) {
    blockedReasons.push('Final verdict requires at least one evidence-backed claim.')
  }

  if (record.contradictions.length > 0) {
    blockedReasons.push('Contradictions must be resolved before automatic completion.')
  }

  return {
    canCompleteAutomatically: blockedReasons.length === 0,
    blockedReasons,
  }
}
