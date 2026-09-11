import { createHash } from 'node:crypto'
import { z } from 'zod'

export const WORKFLOW = 'codex-team-sdlc.yml'
export const WORKFLOW_NAME = 'Codex Team SDLC'
export const STATE_MARKER = '<!-- codex-sdlc-state:v1 -->'
export const STATE_LABEL = 'codex-sdlc-tracked'
export const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000
export const WINDOW_MS = 5 * 60 * 60 * 1000
// Leave room for a wave's final upload and the interruption checkpoint even on
// artifact service configurations that limit a job to ten artifacts.
export const CHECKPOINTS_PER_WINDOW = 7
export const NAMES = ['Sam', 'Tim', 'Jack'] as const
export const CODEX_VERSION = '0.149.0'

export const Operation = z.enum(['plan', 'approve', 'implement', 'review', 'resume', 'cancel'])
export type Operation = z.infer<typeof Operation>
export const Stage = z.enum([
  'plan',
  'tickets',
  'implement',
  'audit',
  'fix-audit',
  'review',
  'fix-review',
  'verify',
  'fix-verify',
  'present',
])
export type Stage = z.infer<typeof Stage>
export const Status = z.enum([
  'queued',
  'running',
  'waiting-approval',
  'waiting-quota',
  'blocked',
  'cancelled',
  'complete',
])
export type Status = z.infer<typeof Status>

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const Sha = z.string().regex(/^[a-f0-9]{40}$/)
const Criterion = z.object({ id: Id, text: z.string().min(1) }).strict()
export const Ticket = z
  .object({
    id: Id,
    title: z.string().min(1),
    body: z.string().min(1),
    dependencies: z.array(Id),
    criteria: z.array(Criterion).min(1),
  })
  .strict()
export type Ticket = z.infer<typeof Ticket>
export const PlanResult = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    markdown: z.string().min(1),
    questions: z.array(z.string()),
  })
  .strict()
export const TicketsResult = z.object({ tickets: z.array(Ticket).min(1) }).strict()
export const WorkResult = z
  .object({
    workers: z.array(
      z
        .object({
          name: z.enum(NAMES),
          sessionId: z.string().uuid(),
          ticketId: Id,
          status: z.enum(['completed', 'blocked']),
          summary: z.string().min(1),
          criteria: z.array(
            z
              .object({
                id: Id,
                status: z.enum(['pass', 'fail', 'unverified']),
                evidence: z.string().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
export const AuditResult = z
  .object({
    summary: z.string().min(1),
    criteria: z.array(
      z
        .object({
          ticketId: Id,
          criterionId: Id,
          status: z.enum(['PASS', 'FAIL', 'PARTIAL', 'UNVERIFIED']),
          evidence: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
export const ReviewResult = z
  .object({
    summary: z.string().min(1),
    findings: z.array(
      z
        .object({
          id: Id,
          severity: z.enum(['critical', 'warning', 'suggestion']),
          file: z.string(),
          detail: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
export const FixResult = z
  .object({
    status: z.enum(['completed', 'blocked']),
    summary: z.string().min(1),
  })
  .strict()

export const CheckpointRef = z
  .object({
    artifactId: z.number().int().positive(),
    runId: z.number().int().positive(),
    name: z.string().regex(/^codex-sdlc-\d+-[a-zA-Z0-9-]+$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    controllerSha: Sha,
  })
  .strict()
export const QueueState = z
  .object({
    version: z.literal(1),
    issue: z.number().int().positive(),
    pipelineId: z.string().uuid(),
    operation: Operation,
    stage: Stage,
    status: Status,
    requestedBy: z.string().min(1),
    requestedAt: z.number(),
    approvedAt: z.number().nullable(),
    deadline: z.number().nullable(),
    activeRunId: z.number().int().positive().nullable(),
    notBefore: z.number(),
    checkpoint: CheckpointRef.nullable(),
    reason: z.string(),
  })
  .strict()
export type QueueState = z.infer<typeof QueueState>

export const Snapshot = z
  .object({
    version: z.literal(1),
    issue: z.number().int().positive(),
    pipelineId: z.string().uuid(),
    mode: z.enum(['full', 'existing', 'review']),
    stage: Stage,
    issueTitle: z.string(),
    requirements: z.string(),
    requirementsHash: z.string(),
    approvedRequirementsHash: z.string().nullable(),
    baseSha: Sha,
    headSha: Sha,
    defaultBranch: z.string(),
    plan: PlanResult.nullable(),
    tickets: z.array(Ticket),
    ticketIssues: z.record(z.string(), z.number().int().positive()),
    completed: z.array(z.string()),
    assignments: z.array(
      z
        .object({
          name: z.enum(NAMES),
          ticketId: Id,
          branch: z.string(),
        })
        .strict(),
    ),
    session: z.object({ id: z.string(), key: z.string() }).strict().nullable(),
    audit: AuditResult.nullable(),
    review: ReviewResult.nullable(),
    auditSha: Sha.nullable(),
    reviewSha: Sha.nullable(),
    verifiedSha: Sha.nullable(),
    verifyOutput: z.string(),
    fixAttempts: z.record(z.string(), z.number()),
    approvedAt: z.number().nullable(),
    deadline: z.number().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export type Snapshot = z.infer<typeof Snapshot>

export function hash(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export function parseCommand(body: string): Operation | null {
  const commands: Record<string, Operation> = {
    '/approve-team-sdlc': 'approve',
    '/codex-team-implement-now': 'implement',
    '/codex-team-review-now': 'review',
    '/codex-team-resume': 'resume',
    '/codex-team-cancel': 'cancel',
  }
  return commands[body.trim()] ?? null
}

export function authorized(permission: string): boolean {
  return ['write', 'maintain', 'admin'].includes(permission)
}

export function active(state: QueueState): boolean {
  return ['queued', 'running', 'waiting-quota'].includes(state.status)
}

export function transition(
  previous: QueueState | null,
  operation: Operation,
  issue: number,
  actor: string,
  now = Date.now(),
): QueueState {
  if (previous && active(previous) && operation !== 'cancel') {
    throw new Error('A pipeline is already active for this issue.')
  }
  if (operation === 'cancel') {
    if (!previous) throw new Error('There is no pipeline to cancel.')
    return { ...previous, status: 'cancelled', reason: `Cancelled by ${actor}.` }
  }
  if (operation === 'resume') {
    if (!previous?.checkpoint || !['blocked', 'cancelled'].includes(previous.status)) {
      throw new Error('Resume requires a stopped pipeline with a saved checkpoint.')
    }
    return {
      ...previous,
      operation,
      status: 'queued',
      activeRunId: null,
      notBefore: now,
      requestedBy: actor,
      reason: '',
      // Explicit resume is a new authorization for a five-day window; automatic
      // continuation never calls this transition and cannot extend the deadline.
      approvedAt: previous.approvedAt === null ? null : now,
      deadline: previous.approvedAt === null ? null : now + FIVE_DAYS,
    }
  }
  if (operation === 'approve' && previous?.status === 'waiting-approval' && previous.checkpoint) {
    return {
      ...previous,
      operation,
      stage: 'tickets',
      status: 'queued',
      activeRunId: null,
      approvedAt: now,
      deadline: now + FIVE_DAYS,
      requestedBy: actor,
      reason: '',
      notBefore: now,
    }
  }
  const approved = operation !== 'plan'
  return {
    version: 1,
    issue,
    pipelineId: crypto.randomUUID(),
    operation,
    stage: operation === 'plan' ? 'plan' : operation === 'review' ? 'review' : 'tickets',
    status: 'queued',
    requestedBy: actor,
    requestedAt: now,
    approvedAt: approved ? now : null,
    deadline: approved ? now + FIVE_DAYS : null,
    activeRunId: null,
    notBefore: now,
    checkpoint: null,
    reason: '',
  }
}

export function nextWave(tickets: Ticket[], completed: string[]): Ticket[] {
  validateTickets(tickets)
  const done = new Set(completed)
  return tickets
    .filter((t) => !done.has(t.id) && t.dependencies.every((id) => done.has(id)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 3)
}

export function validateTickets(tickets: Ticket[]): void {
  const ids = new Set(tickets.map((t) => t.id))
  if (ids.size !== tickets.length) throw new Error('Duplicate ticket IDs.')
  for (const t of tickets) {
    if (new Set(t.criteria.map((c) => c.id)).size !== t.criteria.length)
      throw new Error('Duplicate criteria.')
    for (const dependency of t.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`)
    }
  }
  const resolved = new Set<string>()
  while (resolved.size < tickets.length) {
    const ready = tickets.filter(
      (t) => !resolved.has(t.id) && t.dependencies.every((id) => resolved.has(id)),
    )
    if (!ready.length) throw new Error('Circular ticket dependencies.')
    ready.forEach((t) => resolved.add(t.id))
  }
}

export function validateWork(
  result: z.infer<typeof WorkResult>,
  assignments: Snapshot['assignments'],
  tickets: Ticket[],
): void {
  if (result.workers.length !== assignments.length) throw new Error('Missing worker results.')
  for (const assignment of assignments) {
    const matches = result.workers.filter(
      (w) => w.name === assignment.name && w.ticketId === assignment.ticketId,
    )
    if (matches.length !== 1) throw new Error('Missing or duplicate worker result.')
    const worker = matches[0]!
    const ticket = tickets.find((t) => t.id === assignment.ticketId)!
    if (
      worker.status !== 'completed' ||
      worker.criteria.length !== ticket.criteria.length ||
      ticket.criteria.some(
        (c) => worker.criteria.filter((r) => r.id === c.id && r.status === 'pass').length !== 1,
      )
    ) {
      throw new Error(`Worker ${worker.name} left ticket ${ticket.id} incomplete.`)
    }
  }
}

export function auditPasses(result: z.infer<typeof AuditResult>, tickets: Ticket[]): boolean {
  const expected = tickets.flatMap((t) => t.criteria.map((c) => `${t.id}/${c.id}`))
  const actual = result.criteria.map((c) => `${c.ticketId}/${c.criterionId}`)
  if (
    !expected.length ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((id) => !actual.includes(id))
  )
    throw new Error('Audit does not cover every criterion exactly once.')
  return result.criteria.every((c) => c.status === 'PASS')
}

export function readyToPresent(state: Snapshot): boolean {
  return (
    state.verifiedSha === state.headSha &&
    state.auditSha === state.headSha &&
    state.reviewSha === state.headSha &&
    state.audit !== null &&
    state.review !== null &&
    auditPasses(state.audit, state.tickets) &&
    state.review.findings.every((f) => f.severity === 'suggestion') &&
    state.tickets.every((t) => state.completed.includes(t.id))
  )
}

export function benchmarkOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((path) => path.startsWith('benchmarks/'))
}

export function retryAt(message: string, now = Date.now()): number {
  // Codex versions may supply resets_at as Unix seconds or an ISO timestamp.
  const seconds = /["']?(?:resets_at|reset_at)["']?\s*[:=]\s*(\d{10})(?!\d)/i.exec(message)
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/.exec(message)
  const reset = seconds ? Number(seconds[1]) * 1000 : iso ? Date.parse(iso[1]!) : NaN
  return Number.isFinite(reset) && reset > now ? reset + 60_000 : now + 60 * 60 * 1000
}

export function executionWindow(value = ''): number {
  if (!value) return WINDOW_MS
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 300) {
    throw new Error('CODEX_SDLC_WINDOW_MINUTES must be an integer from 1 to 300.')
  }
  return minutes * 60_000
}
