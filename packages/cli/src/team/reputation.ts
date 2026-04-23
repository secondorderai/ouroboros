import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { DurableMemoryCandidate, SkillCandidate } from '@src/rsi/types'
import { err, ok, type Result } from '@src/types'

export const AGENT_OUTCOME_CATEGORIES = ['task', 'finding', 'patch', 'test', 'override'] as const

export type AgentOutcomeCategory = (typeof AGENT_OUTCOME_CATEGORIES)[number]

export interface AgentOutcomeMetrics {
  completedTasks: number
  failedTasks: number
  acceptedFindings: number
  rejectedFindings: number
  acceptedPatches: number
  rejectedPatches: number
  testsPassed: number
  testsFailed: number
  userOverrides: number
}

export interface AgentOutcomeInput {
  projectId: string
  role: string
  agentId?: string
  runId?: string
  workflowPattern?: string
  workflowSteps?: string[]
  categories?: AgentOutcomeCategory[]
  metrics?: Partial<AgentOutcomeMetrics>
  notes?: string
  recordedAt?: string
}

export interface AgentOutcomeRecord extends AgentOutcomeInput {
  id: string
  recordedAt: string
  categories: AgentOutcomeCategory[]
  metrics: AgentOutcomeMetrics
}

export interface ReputationScoreBreakdown {
  task: number
  finding: number
  patch: number
  test: number
  override: number
  overall: number
}

export interface ReputationSummary {
  projectId: string
  role: string
  updatedAt: string
  runs: number
  metrics: AgentOutcomeMetrics
  scores: ReputationScoreBreakdown
}

export interface ReputationSnapshot {
  updatedAt: string
  summaries: ReputationSummary[]
}

export interface WorkflowRSICandidateExtraction {
  durableMemoryCandidates: DurableMemoryCandidate[]
  skillCandidates: SkillCandidate[]
  sourceOutcomeIds: string[]
}

export interface WorkflowRSICandidateOptions {
  minimumSuccessfulRuns?: number
  observedAt?: string
}

const EMPTY_METRICS: AgentOutcomeMetrics = {
  completedTasks: 0,
  failedTasks: 0,
  acceptedFindings: 0,
  rejectedFindings: 0,
  acceptedPatches: 0,
  rejectedPatches: 0,
  testsPassed: 0,
  testsFailed: 0,
  userOverrides: 0,
}

const outcomeMetricSchema = z
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

const outcomeInputSchema = z
  .object({
    projectId: z.string().trim().min(1),
    role: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    workflowPattern: z.string().trim().min(1).optional(),
    workflowSteps: z.array(z.string().trim().min(1)).optional(),
    categories: z.array(z.enum(AGENT_OUTCOME_CATEGORIES)).optional(),
    metrics: outcomeMetricSchema.optional(),
    notes: z.string().trim().min(1).optional(),
    recordedAt: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid ISO 8601 timestamp')
      .optional(),
  })
  .strict()

function resolveTeamMemoryDir(basePath?: string): string {
  return resolve(basePath ?? process.cwd(), 'memory', 'team')
}

function resolveOutcomeLogPath(basePath?: string): string {
  return resolve(resolveTeamMemoryDir(basePath), 'agent-outcomes.jsonl')
}

function resolveReputationSummaryPath(basePath?: string): string {
  return resolve(resolveTeamMemoryDir(basePath), 'reputation-summary.json')
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function formatZodError(prefix: string, error: z.ZodError): Error {
  return new Error(
    `${prefix}: ${error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ')}`,
  )
}

function normalizeMetrics(metrics?: Partial<AgentOutcomeMetrics>): AgentOutcomeMetrics {
  return { ...EMPTY_METRICS, ...(metrics ?? {}) }
}

function inferCategories(metrics: AgentOutcomeMetrics): AgentOutcomeCategory[] {
  const categories: AgentOutcomeCategory[] = []
  if (metrics.completedTasks > 0 || metrics.failedTasks > 0) categories.push('task')
  if (metrics.acceptedFindings > 0 || metrics.rejectedFindings > 0) categories.push('finding')
  if (metrics.acceptedPatches > 0 || metrics.rejectedPatches > 0) categories.push('patch')
  if (metrics.testsPassed > 0 || metrics.testsFailed > 0) categories.push('test')
  if (metrics.userOverrides > 0) categories.push('override')
  return categories.length > 0 ? categories : ['task']
}

function addMetrics(left: AgentOutcomeMetrics, right: AgentOutcomeMetrics): AgentOutcomeMetrics {
  return {
    completedTasks: left.completedTasks + right.completedTasks,
    failedTasks: left.failedTasks + right.failedTasks,
    acceptedFindings: left.acceptedFindings + right.acceptedFindings,
    rejectedFindings: left.rejectedFindings + right.rejectedFindings,
    acceptedPatches: left.acceptedPatches + right.acceptedPatches,
    rejectedPatches: left.rejectedPatches + right.rejectedPatches,
    testsPassed: left.testsPassed + right.testsPassed,
    testsFailed: left.testsFailed + right.testsFailed,
    userOverrides: left.userOverrides + right.userOverrides,
  }
}

function ratio(positive: number, negative: number): number {
  const total = positive + negative
  return total === 0 ? 0 : positive / total
}

function calculateScores(metrics: AgentOutcomeMetrics): ReputationScoreBreakdown {
  const task = ratio(metrics.completedTasks, metrics.failedTasks)
  const finding = ratio(metrics.acceptedFindings, metrics.rejectedFindings)
  const patch = ratio(metrics.acceptedPatches, metrics.rejectedPatches)
  const test = ratio(metrics.testsPassed, metrics.testsFailed)
  const override = metrics.userOverrides === 0 ? 1 : 1 / (1 + metrics.userOverrides)
  const weightedSignals = [
    { value: task, weight: metrics.completedTasks + metrics.failedTasks },
    { value: finding, weight: metrics.acceptedFindings + metrics.rejectedFindings },
    { value: patch, weight: metrics.acceptedPatches + metrics.rejectedPatches },
    { value: test, weight: metrics.testsPassed + metrics.testsFailed },
    { value: override, weight: metrics.userOverrides },
  ].filter((signal) => signal.weight > 0)
  const totalWeight = weightedSignals.reduce((sum, signal) => sum + signal.weight, 0)
  const overall =
    totalWeight === 0
      ? 0
      : weightedSignals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) / totalWeight

  return { task, finding, patch, test, override, overall }
}

function buildOutcomeRecord(input: AgentOutcomeInput): Result<AgentOutcomeRecord> {
  const parsed = outcomeInputSchema.safeParse(input)
  if (!parsed.success) {
    return err(formatZodError('Invalid agent outcome', parsed.error))
  }

  const metrics = normalizeMetrics(parsed.data.metrics)
  const categories = parsed.data.categories ?? inferCategories(metrics)
  return ok({
    ...parsed.data,
    id: crypto.randomUUID(),
    recordedAt: parsed.data.recordedAt ?? new Date().toISOString(),
    categories,
    metrics,
  })
}

function writeReputationSnapshot(snapshot: ReputationSnapshot, basePath?: string): Result<void> {
  try {
    const filePath = resolveReputationSummaryPath(basePath)
    ensureDir(filePath)
    const tempPath = resolve(dirname(filePath), `.reputation-summary.tmp.${Date.now()}.json`)
    writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    renameSync(tempPath, filePath)
    return ok(undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to write reputation summary: ${message}`))
  }
}

export function readAgentOutcomes(basePath?: string): Result<AgentOutcomeRecord[]> {
  try {
    const filePath = resolveOutcomeLogPath(basePath)
    if (!existsSync(filePath)) {
      return ok([])
    }

    const content = readFileSync(filePath, 'utf-8')
    if (content.trim().length === 0) {
      return ok([])
    }

    const records: AgentOutcomeRecord[] = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue

      try {
        const parsed = JSON.parse(line) as AgentOutcomeRecord
        records.push(parsed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return err(new Error(`Invalid agent outcome JSON on line ${index + 1}: ${message}`))
      }
    }

    return ok(records)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to read agent outcomes: ${message}`))
  }
}

export function buildReputationSnapshot(
  outcomes: AgentOutcomeRecord[],
  updatedAt = new Date().toISOString(),
): ReputationSnapshot {
  const byRoleProject = new Map<string, ReputationSummary>()

  for (const outcome of outcomes) {
    const key = `${outcome.projectId}\0${outcome.role}`
    const current =
      byRoleProject.get(key) ??
      ({
        projectId: outcome.projectId,
        role: outcome.role,
        updatedAt,
        runs: 0,
        metrics: { ...EMPTY_METRICS },
        scores: calculateScores(EMPTY_METRICS),
      } satisfies ReputationSummary)

    current.runs += 1
    current.metrics = addMetrics(current.metrics, outcome.metrics)
    current.scores = calculateScores(current.metrics)
    current.updatedAt = updatedAt
    byRoleProject.set(key, current)
  }

  return {
    updatedAt,
    summaries: [...byRoleProject.values()].sort((left, right) =>
      `${left.projectId}:${left.role}`.localeCompare(`${right.projectId}:${right.role}`),
    ),
  }
}

export function readReputationSnapshot(basePath?: string): Result<ReputationSnapshot> {
  try {
    const filePath = resolveReputationSummaryPath(basePath)
    if (!existsSync(filePath)) {
      return ok(buildReputationSnapshot([]))
    }

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as ReputationSnapshot
    return ok(parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to read reputation summary: ${message}`))
  }
}

export function recordAgentOutcome(
  input: AgentOutcomeInput,
  basePath?: string,
): Result<{ outcome: AgentOutcomeRecord; reputation: ReputationSnapshot }> {
  try {
    const recordResult = buildOutcomeRecord(input)
    if (!recordResult.ok) return recordResult

    const filePath = resolveOutcomeLogPath(basePath)
    ensureDir(filePath)
    appendFileSync(filePath, `${JSON.stringify(recordResult.value)}\n`, 'utf-8')

    const outcomesResult = readAgentOutcomes(basePath)
    if (!outcomesResult.ok) return outcomesResult

    const reputation = buildReputationSnapshot(outcomesResult.value, recordResult.value.recordedAt)
    const writeResult = writeReputationSnapshot(reputation, basePath)
    if (!writeResult.ok) return writeResult

    return ok({ outcome: recordResult.value, reputation })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to record agent outcome: ${message}`))
  }
}

function isSuccessfulWorkflowOutcome(outcome: AgentOutcomeRecord): boolean {
  return (
    !!outcome.workflowPattern &&
    outcome.metrics.completedTasks > 0 &&
    outcome.metrics.failedTasks === 0 &&
    outcome.metrics.rejectedPatches === 0 &&
    outcome.metrics.testsFailed === 0 &&
    outcome.metrics.userOverrides === 0
  )
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'successful-team-workflow'
}

function workflowCandidateName(pattern: string): string {
  const slug = slugify(pattern)
  return slug.endsWith('-workflow') ? slug : `${slug}-workflow`
}

export function extractWorkflowRSICandidates(
  outcomes: AgentOutcomeRecord[],
  options: WorkflowRSICandidateOptions = {},
): Result<WorkflowRSICandidateExtraction> {
  const minimumSuccessfulRuns = options.minimumSuccessfulRuns ?? 2
  if (!Number.isInteger(minimumSuccessfulRuns) || minimumSuccessfulRuns < 1) {
    return err(new Error('minimumSuccessfulRuns must be a positive integer'))
  }

  const groups = new Map<string, AgentOutcomeRecord[]>()
  for (const outcome of outcomes.filter(isSuccessfulWorkflowOutcome)) {
    const key = `${outcome.projectId}\0${outcome.workflowPattern}`
    const group = groups.get(key) ?? []
    group.push(outcome)
    groups.set(key, group)
  }

  const durableMemoryCandidates: DurableMemoryCandidate[] = []
  const skillCandidates: SkillCandidate[] = []
  const sourceOutcomeIds: string[] = []
  const observedAt = options.observedAt ?? new Date().toISOString()

  for (const group of groups.values()) {
    if (group.length < minimumSuccessfulRuns) continue

    const first = group[0]
    const pattern = first.workflowPattern ?? 'successful team workflow'
    const workflow = [
      ...new Set(
        group.flatMap((outcome) =>
          outcome.workflowSteps && outcome.workflowSteps.length > 0
            ? outcome.workflowSteps
            : [`Run ${pattern}`, 'Verify outputs', 'Record outcome'],
        ),
      ),
    ]
    const ids = group.map((outcome) => outcome.id)
    sourceOutcomeIds.push(...ids)

    durableMemoryCandidates.push({
      title: `Repeated successful workflow: ${pattern}`,
      summary: `${pattern} succeeded ${group.length} times for ${first.projectId}.`,
      content: `Use this workflow when similar team orchestration recurs:\n${workflow
        .map((step, index) => `${index + 1}. ${step}`)
        .join('\n')}`,
      kind: 'workflow',
      confidence: Math.min(0.95, 0.6 + group.length * 0.1),
      observedAt,
      tags: ['team', 'workflow', `project:${first.projectId}`, `pattern:${slugify(pattern)}`],
      evidence: ids,
    })

    skillCandidates.push({
      name: workflowCandidateName(pattern),
      summary: `Reusable team workflow for ${pattern}.`,
      trigger: `A future task matches the ${pattern} orchestration pattern.`,
      workflow,
      confidence: Math.min(0.95, 0.65 + group.length * 0.1),
      sourceObservationIds: ids,
      sourceSessionIds: [...new Set(group.map((outcome) => outcome.runId ?? outcome.id))],
    })
  }

  return ok({
    durableMemoryCandidates,
    skillCandidates,
    sourceOutcomeIds: [...new Set(sourceOutcomeIds)],
  })
}
