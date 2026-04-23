import { err, ok, type Result } from '@src/types'

export const TEAM_ADVISOR_RECOMMENDATIONS = [
  'single-agent',
  'one-explorer',
  'read-only-research-team',
  'review-test-pair',
  'worktree-workers',
  'full-task-graph-team',
] as const

export type TeamAdvisorRecommendation = (typeof TEAM_ADVISOR_RECOMMENDATIONS)[number]
export type TeamAdvisorRiskSetting = 'low' | 'normal' | 'high'
export type TeamAdvisorIndependence = 'low' | 'medium' | 'high'
export type TeamAdvisorCost = 'low' | 'medium' | 'high'
export type TeamAdvisorPermission = 'read-only' | 'workspace-write' | 'shell' | 'network'

export interface TeamAdvisorInput {
  taskSummary: string
  files?: string[]
  sequentialDependencies?: boolean
  ambiguousInvestigation?: boolean
  taskIndependence?: TeamAdvisorIndependence
  permissionsRequired?: TeamAdvisorPermission[]
  likelyTokenCost?: TeamAdvisorCost
  expectedTestCost?: TeamAdvisorCost
  userRiskSetting?: TeamAdvisorRiskSetting
}

export interface TeamAdvisorOutput {
  recommendation: TeamAdvisorRecommendation
  rationale: string[]
  considered: {
    fileOverlapRisk: 'low' | 'medium' | 'high'
    taskIndependence: TeamAdvisorIndependence
    permissionsRequired: TeamAdvisorPermission[]
    likelyTokenCost: TeamAdvisorCost
    expectedTestCost: TeamAdvisorCost
    userRiskSetting: TeamAdvisorRiskSetting
  }
}

function normalizeCost(cost?: TeamAdvisorCost): TeamAdvisorCost {
  return cost ?? 'medium'
}

function normalizeIndependence(independence?: TeamAdvisorIndependence): TeamAdvisorIndependence {
  return independence ?? 'medium'
}

function inferFileOverlapRisk(files: string[] | undefined): 'low' | 'medium' | 'high' {
  if (!files || files.length <= 1) return 'high'

  const uniqueFiles = new Set(files)
  if (uniqueFiles.size < files.length) return 'high'
  if (uniqueFiles.size <= 3) return 'medium'
  return 'low'
}

function includesWritePermission(permissions: TeamAdvisorPermission[]): boolean {
  return permissions.some((permission) => permission !== 'read-only')
}

function isExpensive(cost: TeamAdvisorCost): boolean {
  return cost === 'high'
}

export function adviseTeamSize(input: TeamAdvisorInput): Result<TeamAdvisorOutput> {
  const taskSummary = input.taskSummary.trim()
  if (!taskSummary) {
    return err(new Error('Team advisor task summary is required'))
  }

  const files = input.files?.filter((file) => file.trim().length > 0) ?? []
  const permissionsRequired = input.permissionsRequired ?? ['workspace-write']
  const fileOverlapRisk = inferFileOverlapRisk(files)
  const taskIndependence = normalizeIndependence(input.taskIndependence)
  const likelyTokenCost = normalizeCost(input.likelyTokenCost)
  const expectedTestCost = normalizeCost(input.expectedTestCost)
  const userRiskSetting = input.userRiskSetting ?? 'normal'
  const rationale: string[] = []

  let recommendation: TeamAdvisorRecommendation = 'single-agent'

  if (input.sequentialDependencies || fileOverlapRisk === 'high' || taskIndependence === 'low') {
    recommendation = input.ambiguousInvestigation ? 'one-explorer' : 'single-agent'
    rationale.push(
      input.sequentialDependencies
        ? 'The work has sequential dependencies, so parallel workers would wait on each other.'
        : 'The work has high file overlap risk, so multiple writers would likely conflict.',
    )
  } else if (input.ambiguousInvestigation && !includesWritePermission(permissionsRequired)) {
    recommendation = files.length > 3 ? 'read-only-research-team' : 'one-explorer'
    rationale.push(
      files.length > 3
        ? 'The task is an ambiguous read-only investigation across several files, so bounded parallel exploration is useful.'
        : 'The task is ambiguous but small enough for one read-only explorer.',
    )
  } else if (
    userRiskSetting === 'low' &&
    taskIndependence !== 'high' &&
    (isExpensive(likelyTokenCost) || isExpensive(expectedTestCost))
  ) {
    recommendation = 'single-agent'
    rationale.push(
      'The user risk setting is low and the expected token or test cost is high, so the advisor avoids extra agents.',
    )
  } else if (taskIndependence === 'medium' && expectedTestCost !== 'high') {
    recommendation = 'review-test-pair'
    rationale.push(
      'The task has moderate independence and manageable tests, so a focused review/test pair is enough.',
    )
  } else if (taskIndependence === 'high' && fileOverlapRisk === 'low') {
    recommendation =
      userRiskSetting === 'high' && likelyTokenCost !== 'high'
        ? 'full-task-graph-team'
        : 'worktree-workers'
    rationale.push(
      recommendation === 'full-task-graph-team'
        ? 'The work appears independent with low file overlap and high user risk tolerance, so a full task graph team is justified.'
        : 'The work appears independent with low file overlap, so isolated worktree workers are appropriate.',
    )
  }

  if (rationale.length === 0) {
    rationale.push('The task does not show enough independence to justify a larger team.')
  }

  rationale.push(
    `Considered file overlap risk=${fileOverlapRisk}, independence=${taskIndependence}, permissions=${permissionsRequired.join(
      ', ',
    )}, token cost=${likelyTokenCost}, test cost=${expectedTestCost}, user risk=${userRiskSetting}.`,
  )

  return ok({
    recommendation,
    rationale,
    considered: {
      fileOverlapRisk,
      taskIndependence,
      permissionsRequired,
      likelyTokenCost,
      expectedTestCost,
      userRiskSetting,
    },
  })
}
