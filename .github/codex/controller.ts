import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import { GitHub, output, type StateRecord, type Issue } from './github'
import { Git } from './git'
import {
  AuditResult,
  CODEX_VERSION,
  CHECKPOINTS_PER_WINDOW,
  FixResult,
  NAMES,
  Operation,
  PlanResult,
  ReviewResult,
  Snapshot,
  TicketsResult,
  WorkResult,
  active,
  auditPasses,
  authorized,
  benchmarkOnly,
  executionWindow,
  hash,
  nextWave,
  parseCommand,
  readyToPresent,
  transition,
  validateTickets,
  validateWork,
  type QueueState,
} from './model'
import { Interrupted, command, runCodex } from './process'
import { Storage, stateKey, validateAuth, writeBackAuth } from './storage'
import { diagnoseCheckpoint } from './diagnostics'

type Event = {
  action?: string
  label?: { name: string }
  issue?: Issue
  comment?: { body: string }
  sender?: { login: string; type: string }
  inputs?: Record<string, string>
  repository: { default_branch: string }
}

export function requestedOperation(event: Event, eventName: string): Operation | null {
  if (event.issue?.pull_request) return null
  if (
    eventName === 'issues' &&
    event.action === 'labeled' &&
    event.label?.name === 'codex-team-sdlc'
  )
    return 'plan'
  if (eventName === 'issue_comment' && event.action === 'created')
    return parseCommand(event.comment?.body ?? '')
  if (eventName === 'workflow_dispatch')
    return Operation.safeParse(event.inputs?.operation).data ?? null
  return null
}

export function eligible(queue: QueueState, now = Date.now()): boolean {
  return (
    ['queued', 'waiting-quota'].includes(queue.status) &&
    queue.notBefore <= now &&
    (queue.deadline === null || queue.deadline > now)
  )
}

export async function subscriptionWaitUntil(github: GitHub): Promise<number> {
  let until = 0
  for (const issue of await github.tracked()) {
    if (issue.pull_request) continue
    const record = await github.state(issue.number)
    if (record?.state.status === 'waiting-quota') until = Math.max(until, record.state.notBefore)
  }
  return until
}

export async function gate(github: GitHub, event: Event): Promise<void> {
  await output('execute', 'false')
  const issue = event.issue?.number ?? Number(event.inputs?.issue_number)
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error('A positive issue number is required.')
  const actor = process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR ?? ''
  if (event.inputs?.operation === 'diagnose') {
    if (!authorized(await github.permission(actor)))
      throw new Error('Only repository maintainers may diagnose Codex SDLC.')
    const record = await github.state(issue)
    if (!record?.state.checkpoint) throw new Error('The issue has no saved checkpoint to diagnose.')
    await output('issue', String(issue))
    await output('diagnose', 'true')
    return
  }
  if (event.inputs?.operation === 'continue') {
    // Only dispatches from the companion workflow (or an authorized maintainer)
    // can wake a previously authorized pipeline. No state is accepted as input.
    if (!(actor === 'github-actions[bot]' || authorized(await github.permission(actor))))
      throw new Error('Unauthorized continuation.')
    const record = await github.state(issue)
    if (!record || record.state.pipelineId !== event.inputs.pipeline_id || !eligible(record.state))
      return
    if (
      record.state.activeRunId &&
      record.state.activeRunId !== Number(process.env.GITHUB_RUN_ID)
    ) {
      if ((await github.run(record.state.activeRunId)).status !== 'completed') return
    }
    await github.save(
      { ...record.state, activeRunId: Number(process.env.GITHUB_RUN_ID) },
      record.commentId,
    )
    await output('issue', String(issue))
    await output('pipeline', record.state.pipelineId)
    await output('execute', 'true')
    return
  }
  const operation = requestedOperation(event, process.env.GITHUB_EVENT_NAME ?? '')
  if (!operation) return
  if (!authorized(await github.permission(actor)))
    throw new Error('Only repository maintainers may operate Codex SDLC.')
  const target = await github.issue(issue)
  if (target.pull_request || target.state !== 'open')
    throw new Error('SDLC requires an open issue, not a pull request.')
  let record = await github.state(issue)
  let state: QueueState
  try {
    state = transition(record?.state ?? null, operation, issue, actor)
  } catch (error) {
    await github.comment(issue, `Codex SDLC command ignored: ${(error as Error).message}`)
    return
  }
  if (operation !== 'cancel') state.activeRunId = Number(process.env.GITHUB_RUN_ID)
  if (operation !== 'cancel') {
    const until = await subscriptionWaitUntil(github)
    if (until > Date.now()) {
      state = {
        ...state,
        status: 'waiting-quota',
        notBefore: until,
        activeRunId: null,
        reason: 'Waiting for the shared subscription allowance.',
      }
    }
  }
  await github.track(issue)
  record = await github.save(state, record?.commentId)
  const canonical = await github.state(issue)
  if (canonical?.commentId !== record.commentId) {
    // Resolve racing first commands by the immutable oldest comment ID.
    await github.call(`/repos/${github.repo}/issues/comments/${record.commentId}`, 'DELETE')
    return
  }
  if (operation === 'cancel') {
    if (state.activeRunId) {
      const run = await github.run(state.activeRunId)
      if (run.status !== 'completed')
        await github.call(`/repos/${github.repo}/actions/runs/${state.activeRunId}/cancel`, 'POST')
    }
    return
  }
  if (!eligible(state)) return
  await output('issue', String(issue))
  await output('pipeline', state.pipelineId)
  await output('execute', 'true')
}

export async function continueQueue(github: GitHub, branch: string): Promise<void> {
  const candidates: StateRecord[] = []
  let busy = false
  for (const issue of await github.tracked()) {
    if (issue.pull_request) continue
    const record = await github.state(issue.number)
    if (!record || !active(record.state)) continue
    const state = record.state
    if (state.status === 'waiting-quota' && state.notBefore > Date.now()) busy = true
    if ((state.status === 'running' || state.status === 'queued') && state.activeRunId) {
      const run = await github.run(state.activeRunId)
      if (run.status !== 'completed') {
        busy = true
        continue
      }
      if (run.conclusion === 'cancelled' && state.status === 'running') {
        await github.save(
          {
            ...state,
            status: 'cancelled',
            reason: 'The active Actions run was cancelled; resume requires a maintainer.',
          },
          record.commentId,
        )
        continue
      }
      if (state.status === 'queued' && run.conclusion === 'cancelled') {
        state.activeRunId = null
        await github.save(state, record.commentId)
        if (eligible(state)) candidates.push(record)
        continue
      }
      // A crashed worker may not reach its finally block. The last complete
      // checkpoint is authoritative; never manufacture successful stage output.
      state.status = state.checkpoint ? 'queued' : 'blocked'
      state.reason = state.checkpoint
        ? 'Recovering the last saved checkpoint after runner failure.'
        : 'Runner stopped before its first checkpoint. Start the operation again.'
      state.activeRunId = null
      await github.save(state, record.commentId)
    }
    if (state.deadline !== null && state.deadline <= Date.now()) {
      await github.save(
        {
          ...state,
          status: 'blocked',
          reason: 'Five-day deadline reached. A maintainer may resume with a new window.',
        },
        record.commentId,
      )
      continue
    }
    if (eligible(state)) candidates.push(record)
  }
  if (busy) return
  const next = candidates.sort((a, b) => a.state.requestedAt - b.state.requestedAt)[0]
  if (next) await github.dispatch(next.state.issue, next.state.pipelineId, branch)
}

class Pipeline {
  readonly root = '/tmp/codex-sdlc-work'
  readonly home = join(this.root, 'auth')
  readonly records = join(this.root, 'records')
  readonly repoDir = join(this.root, 'repo')
  readonly worktrees = join(this.root, 'worktrees')
  readonly git: Git
  readonly storage: Storage
  readonly signal = new AbortController()
  snapshot!: Snapshot
  record: StateRecord
  private paths = new Map<string, string>()
  private authReady = false
  private authWriteFailed = false
  private interruptedBy: 'time' | 'cancelled' = 'time'
  private readonly runId = Number(process.env.GITHUB_RUN_ID)
  private readonly branch: string
  private readonly started = Date.now()
  private checkpointCount = 0

  constructor(
    readonly github: GitHub,
    record: StateRecord,
    readonly defaultBranch: string,
    private readonly token: string,
  ) {
    this.record = record
    this.branch = `codex/sdlc-issue-${record.state.issue}`
    this.git = new Git(this.repoDir, github.repo, token)
    this.storage = new Storage(
      join(this.root, 'storage'),
      stateKey(required('CODEX_SDLC_STATE_KEY')),
      github,
      token,
    )
  }

  private async update(patch: Partial<QueueState>): Promise<void> {
    const latest = await this.github.state(this.record.state.issue)
    if (!latest || latest.state.pipelineId !== this.record.state.pipelineId)
      throw new Error('Pipeline ownership changed.')
    if (latest.state.status === 'cancelled')
      if (patch.status === 'complete') throw new Interrupted('cancelled', latest.state.reason)
    if (latest.state.status === 'cancelled')
      patch = { ...patch, status: 'cancelled', reason: latest.state.reason }
    this.record = await this.github.save({ ...latest.state, ...patch }, latest.commentId)
  }

  private async persistAuth(): Promise<void> {
    if (!this.authReady) return
    try {
      await writeBackAuth(this.home, this.github.repo, required('CODEX_AUTH_WRITE_TOKEN'))
    } catch (error) {
      this.authWriteFailed = true
      throw error
    }
  }

  private async checkpoint(): Promise<void> {
    if (!this.snapshot) return
    // Preserve incomplete edits as WIP commits, without claiming ticket success.
    for (const [name, path] of this.paths)
      await this.git.commit(`wip: preserve ${name} for #${this.snapshot.issue}`, path)
    await this.git.commit(`wip: preserve SDLC stage for #${this.snapshot.issue}`)
    this.snapshot.headSha = await this.git.head()
    this.snapshot.revision++
    const bundle = join(this.root, 'checkpoint.bundle')
    await rm(bundle, { force: true })
    await this.git.bundle(
      bundle,
      [this.branch, ...this.snapshot.assignments.map((a) => a.branch)],
      this.snapshot.baseSha,
    )
    const ref = await this.storage.save(
      this.snapshot,
      this.home,
      this.records,
      bundle,
      this.runId,
      required('GITHUB_SHA'),
    )
    this.checkpointCount++
    await this.update({ checkpoint: ref, stage: this.snapshot.stage })
  }

  private async initialize(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
    for (const path of [this.home, this.records, this.worktrees, join(this.root, 'storage')])
      await mkdir(path, { recursive: true })
    const auth = required('CODEX_AUTH_JSON')
    validateAuth(auth)
    await chmod(this.home, 0o700)
    await writeFile(join(this.home, 'auth.json'), auth, { mode: 0o600 })
    this.authReady = true
    const version = await command(['codex', '--version'], { cwd: this.root })
    if (version.code !== 0 || version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
      throw new Error(`Expected Codex CLI ${CODEX_VERSION}.`)
    await this.git.initialize(this.defaultBranch)
    const issue = await this.github.issue(this.record.state.issue)
    if (issue.pull_request || issue.state !== 'open')
      throw new Error('The SDLC issue is no longer open.')
    const requirements = `# ${issue.title}\n\n${issue.body ?? ''}`
    if (!issue.body?.trim())
      throw new Error('The issue must contain feature requirements or a PRD.')
    const comments = (await this.github.comments(issue.number)).filter(
      (c) => c.user.type !== 'Bot' && !parseCommand(c.body),
    )
    const issueContext =
      `${requirements}\n\n## Issue discussion (reference data)\n\n` +
      comments.map((c) => `### ${c.user.login}\n${c.body}`).join('\n\n')
    if (this.record.state.checkpoint) {
      const restored = await this.storage.restore(
        this.record.state,
        this.home,
        this.records,
        this.defaultBranch,
      )
      this.snapshot = restored.snapshot
      if (this.snapshot.requirementsHash !== hash(requirements)) {
        throw new Error(
          'Issue requirements changed after checkpointing. Request a new plan and approve it.',
        )
      }
      await this.git.restoreBundle(restored.bundle, [
        this.branch,
        ...this.snapshot.assignments.map((a) => a.branch),
      ])
      const local = await this.git.run(
        ['show-ref', '--verify', `refs/heads/${this.branch}`],
        this.repoDir,
        true,
      )
      if (local) await this.git.run(['checkout', this.branch])
      else await this.git.checkout(this.branch, this.defaultBranch)
      if ((await this.git.head()) !== this.snapshot.headSha)
        throw new Error('Checkpoint branch SHA mismatch.')
      const remote = await this.git.run([
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${this.branch}`,
      ])
      if (remote) {
        await this.git.run(['fetch', 'origin', this.branch])
        const check = await command(
          ['git', 'merge-base', '--is-ancestor', `origin/${this.branch}`, 'HEAD'],
          { cwd: this.repoDir },
        )
        if (check.code !== 0)
          throw new Error(
            'The SDLC branch changed outside this checkpoint. Use review-only or re-plan.',
          )
      }
      if (this.record.state.operation === 'approve' && this.snapshot.stage === 'plan') {
        await this.git.sync(this.defaultBranch)
        this.snapshot.baseSha = await this.git.run(['rev-parse', `origin/${this.defaultBranch}`])
        this.snapshot.headSha = await this.git.head()
        this.snapshot.stage = 'tickets'
        this.snapshot.approvedRequirementsHash = hash(
          `${issueContext}\n${this.snapshot.plan?.markdown ?? ''}`,
        )
      }
      if (
        this.record.state.operation === 'resume' &&
        this.snapshot.approvedAt !== this.record.state.approvedAt
      ) {
        this.snapshot.fixAttempts = {}
      }
      this.snapshot.approvedAt = this.record.state.approvedAt
      this.snapshot.deadline = this.record.state.deadline
    } else {
      await this.git.checkout(
        this.branch,
        this.defaultBranch,
        this.record.state.operation === 'review',
      )
      await this.git.sync(this.defaultBranch)
      const headSha = await this.git.head()
      const baseSha = await this.git.run(['rev-parse', `origin/${this.defaultBranch}`])
      if (this.record.state.operation === 'review' && headSha === baseSha)
        throw new Error('The SDLC branch has no implementation to review.')
      this.snapshot = {
        version: 1,
        issue: issue.number,
        pipelineId: this.record.state.pipelineId,
        mode:
          this.record.state.operation === 'review'
            ? 'review'
            : this.record.state.operation === 'implement'
              ? 'existing'
              : 'full',
        stage: this.record.state.stage,
        issueTitle: issue.title,
        requirements,
        requirementsHash: hash(requirements),
        approvedRequirementsHash: this.record.state.approvedAt ? hash(requirements) : null,
        baseSha,
        headSha,
        defaultBranch: this.defaultBranch,
        plan: null,
        tickets: [],
        ticketIssues: {},
        completed: [],
        assignments: [],
        session: null,
        audit: null,
        review: null,
        auditSha: null,
        reviewSha: null,
        verifiedSha: null,
        verifyOutput: '',
        fixAttempts: {},
        approvedAt: this.record.state.approvedAt,
        deadline: this.record.state.deadline,
        revision: 0,
      }
      // Both shortcut paths normalize existing issue bodies into the manifest;
      // neither generates or implements new tickets in review-only mode.
      if (['implement', 'review'].includes(this.record.state.operation)) {
        this.snapshot.stage = 'tickets'
        const subIssues = await this.github.pages<Issue>(
          `/repos/${this.github.repo}/issues/${issue.number}/sub_issues`,
        )
        if (!subIssues.length && this.record.state.operation === 'implement')
          throw new Error('Implement-now requires existing sub-issues.')
        await writeFile(
          join(this.records, 'existing-tickets.json'),
          JSON.stringify(subIssues.length ? subIssues : [issue]),
        )
      }
      await this.git.push(this.branch)
    }
    if (!this.record.state.checkpoint || this.record.state.operation === 'approve') {
      await writeFile(join(this.records, 'issue-context.md'), issueContext)
      await this.attachments(issueContext)
    }
    // Already-approved plan checkpoints may have returned before any code commit.
    await this.prepare(this.repoDir)
    for (const assignment of this.snapshot.assignments) {
      const path = await this.git.worktree(this.worktrees, assignment.name, assignment.branch, true)
      this.paths.set(assignment.name, path)
      await this.prepare(path)
    }
    await this.checkpoint()
  }

  private async prepare(path: string): Promise<void> {
    const install = await command(['bun', 'install', '--frozen-lockfile'], {
      cwd: path,
      signal: this.signal.signal,
    })
    if (install.code !== 0)
      throw new Error('Dependency installation failed; see runner setup and lockfile.')
  }

  private async attachments(context: string): Promise<void> {
    const urls = [
      ...new Set(
        context.match(
          /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[A-Za-z0-9%._/~+-]+/g,
        ) ?? [],
      ),
    ].slice(0, 20)
    const directory = join(this.records, 'attachments')
    await mkdir(directory, { recursive: true })
    const manifest: Array<{ url: string; file?: string; status: string }> = []
    for (const [index, url] of urls.entries()) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok || !response.body) throw new Error('Unavailable attachment')
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.byteLength
          if (size > 20 * 1024 * 1024) throw new Error('Attachment exceeds 20 MB')
          chunks.push(chunk)
        }
        const contentType = response.headers.get('content-type') ?? ''
        const extension = contentType.includes('png')
          ? '.png'
          : contentType.includes('jpeg')
            ? '.jpg'
            : contentType.includes('pdf')
              ? '.pdf'
              : '.bin'
        const file = `attachment-${index + 1}${extension}`
        await writeFile(join(directory, file), Buffer.concat(chunks))
        manifest.push({ url, file, status: 'downloaded' })
      } catch {
        manifest.push({
          url,
          status: 'unavailable; consult the issue or ask for accessible requirements',
        })
      }
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
  }

  private async infer<T>(phase: string, resultSchema: z.ZodType<T>, extra = ''): Promise<T> {
    const key = `${phase}:${this.snapshot.assignments.map((a) => a.ticketId).join(',')}`
    const sessionId = this.snapshot.session?.key === key ? this.snapshot.session.id : undefined
    const common = await readFile(join(import.meta.dir, 'prompts', 'common.md'), 'utf8')
    const prompt = await readFile(join(import.meta.dir, 'prompts', `${phase}.md`), 'utf8')
    const context =
      `\nIssue #${this.snapshot.issue}. Repository: ${this.github.repo}.\n` +
      `Working checkout: ${this.repoDir}\nInput records: ${this.records}\n` +
      `Approved requirements:\n${this.snapshot.requirements}\n\nImplementation plan:\n${this.snapshot.plan?.markdown ?? 'Use the approved issue PRD.'}\n` +
      `\nTicket manifest:\n${JSON.stringify(this.snapshot.tickets)}\n\n${extra}`
    try {
      return await runCodex({
        cwd: this.repoDir,
        home: this.home,
        workDir: join(this.records, `stage-${this.snapshot.revision}-${phase}`),
        prompt: `${common}\n\n${prompt}\n\n${context}`,
        resultSchema,
        model: process.env.CODEX_MODEL || 'gpt-5.6-sol',
        effort: process.env.CODEX_EFFORT || 'xhigh',
        readOnly: ['plan', 'tickets', 'audit', 'review'].includes(phase),
        sessionId,
        extraDirs: [...this.paths.values()],
        signal: this.signal.signal,
        onSession: (id) => {
          this.snapshot.session = { key, id }
        },
        workerIds:
          phase === 'implement'
            ? (result) => WorkResult.parse(result).workers.map((worker) => worker.sessionId)
            : undefined,
      })
    } finally {
      await this.persistAuth()
    }
  }

  private async changed(): Promise<string[]> {
    return (await this.git.run(['diff', '--name-only', `${this.snapshot.baseSha}...HEAD`]))
      .split('\n')
      .filter(Boolean)
  }

  private async step(): Promise<void> {
    const s = this.snapshot
    switch (s.stage) {
      case 'plan': {
        s.plan = await this.infer('plan', PlanResult)
        await writeFile(join(this.records, 'implementation-plan.md'), s.plan.markdown)
        await this.github.comment(
          s.issue,
          `${s.plan.markdown}\n\nReview the plan and answer any questions, then comment \`/approve-team-sdlc\`.`,
        )
        // Keep stage=plan in the checkpoint; approval advances it on the next run.
        await this.checkpoint()
        await this.update({
          status: 'waiting-approval',
          reason: 'Plan ready for human approval.',
          activeRunId: null,
        })
        return
      }
      case 'tickets': {
        const existingPath = join(this.records, 'existing-tickets.json')
        const existing = await Bun.file(existingPath).exists()
        if (!s.tickets.length) {
          const result = await this.infer(
            'tickets',
            TicketsResult,
            existing
              ? `Existing-ticket mode: normalize exactly these issues, preserving their acceptance criteria and dependencies. Do not invent work. Include issue-N in each ticket ID.\n${await readFile(existingPath, 'utf8')}`
              : '',
          )
          validateTickets(result.tickets)
          s.tickets = result.tickets
          s.session = null
          await this.checkpoint()
        }
        if (existing) {
          const issues = JSON.parse(await readFile(existingPath, 'utf8')) as Issue[]
          for (const ticket of s.tickets) {
            const number = Number(/^issue-(\d+)$/.exec(ticket.id)?.[1])
            if (!issues.some((i) => i.number === number))
              throw new Error('Existing ticket mapping must use exact issue-N IDs.')
            s.ticketIssues[ticket.id] = number
          }
          if (s.tickets.length !== issues.length)
            throw new Error('Existing ticket normalization omitted an issue.')
        } else {
          for (const ticket of s.tickets) {
            const body = `${ticket.body}\n\n## Acceptance criteria\n${ticket.criteria.map((c) => `- [ ] ${c.id}: ${c.text}`).join('\n')}\n\nDepends on: ${ticket.dependencies.join(', ') || 'None'}`
            s.ticketIssues[ticket.id] = await this.github.subIssue(s.issue, { ...ticket, body })
          }
        }
        await writeFile(join(this.records, 'tickets.json'), JSON.stringify(s.tickets, null, 2))
        if (s.mode === 'review') {
          s.completed = s.tickets.map((t) => t.id)
          s.stage = 'audit'
        } else s.stage = 'implement'
        break
      }
      case 'implement': {
        if (!s.assignments.length) {
          const wave = nextWave(s.tickets, s.completed)
          if (!wave.length) {
            s.stage = 'audit'
            break
          }
          for (let i = 0; i < wave.length; i++) {
            const name = NAMES[i]!
            const branch = `${this.branch}-worker-${name.toLowerCase()}`
            const path = await this.git.worktree(this.worktrees, name, branch, false)
            this.paths.set(name, path)
            s.assignments.push({ name, ticketId: wave[i]!.id, branch })
            await this.prepare(path)
          }
          await this.checkpoint()
        }
        const result = await this.infer(
          'implement',
          WorkResult,
          `Assignments (spawn one native Codex subagent per entry; do not run separate Codex processes):\n` +
            JSON.stringify(s.assignments.map((a) => ({ ...a, worktree: this.paths.get(a.name) }))),
        )
        if (await this.git.run(['status', '--porcelain']))
          throw new Error('A worker edited the main checkout instead of its assigned worktree.')
        validateWork(result, s.assignments, s.tickets)
        // Check in every worker's edits before attempting any merge. Conflicts
        // leave all branches in the encrypted checkpoint, including unmerged ones.
        for (const assignment of s.assignments) {
          await this.git.commit(
            `feat: ${assignment.ticketId} (#${s.issue})`,
            this.paths.get(assignment.name)!,
          )
        }
        for (const assignment of s.assignments) await this.git.merge(assignment.branch)
        const integrated = s.assignments
          .map((assignment) => {
            const ticket = s.tickets.find((ticket) => ticket.id === assignment.ticketId)!
            return `- #${s.ticketIssues[ticket.id]}: ${ticket.title}`
          })
          .join('\n')
        for (const assignment of s.assignments) {
          s.completed.push(assignment.ticketId)
          await this.git.removeWorktree(this.paths.get(assignment.name)!)
          this.paths.delete(assignment.name)
        }
        s.assignments = []
        await this.github.comment(
          s.issue,
          `Codex implementation progress: **${s.completed.length}/${s.tickets.length} tickets integrated**. Audit and verification are still required.\n\n${integrated}`,
        )
        break
      }
      case 'audit': {
        s.audit = await this.infer('audit', AuditResult)
        await writeFile(join(this.records, 'feature-audit.json'), JSON.stringify(s.audit, null, 2))
        if (auditPasses(s.audit, s.tickets)) {
          s.auditSha = await this.git.head()
          s.stage = 'review'
        } else {
          s.auditSha = null
          s.stage = 'fix-audit'
        }
        break
      }
      case 'review': {
        s.review = await this.infer(
          'review',
          ReviewResult,
          `Review git diff ${s.baseSha}...HEAD. This is an independent review of all implementation changes.`,
        )
        await writeFile(join(this.records, 'code-review.json'), JSON.stringify(s.review, null, 2))
        if (s.review.findings.some((f) => f.severity !== 'suggestion')) {
          s.reviewSha = null
          s.stage = 'fix-review'
        } else {
          s.reviewSha = await this.git.head()
          s.stage = 'verify'
        }
        break
      }
      case 'fix-audit':
      case 'fix-review':
      case 'fix-verify': {
        if ((s.fixAttempts[s.stage] ?? 0) >= 3)
          throw new Error(`Three ${s.stage} attempts did not resolve the failures.`)
        const report =
          s.stage === 'fix-audit' ? s.audit : s.stage === 'fix-review' ? s.review : s.verifyOutput
        const result = await this.infer(
          'fix',
          FixResult,
          `Fix the following ${s.stage} findings without weakening tests or requirements:\n${JSON.stringify(report)}`,
        )
        s.fixAttempts[s.stage] = (s.fixAttempts[s.stage] ?? 0) + 1
        if (result.status !== 'completed') throw new Error('Codex reported blocked fixes.')
        await this.git.commit(`fix: address ${s.stage} findings for #${s.issue}`)
        s.auditSha = s.reviewSha = s.verifiedSha = null
        s.stage = 'audit'
        break
      }
      case 'verify': {
        await this.prepare(this.repoDir)
        const paths = await this.changed()
        const commands = benchmarkOnly(paths)
          ? [
              ['bun', 'run', 'lint'],
              ['bun', 'run', 'ts-check'],
              ['bun', 'run', 'test:cli'],
            ]
          : [
              ['bash', join(import.meta.dir, 'prepare-cli.sh'), this.repoDir],
              ['xvfb-run', '--auto-servernum', 'bun', 'run', 'verify'],
            ]
        // Benchmark-specific tests are required in addition to the repo's exception.
        if (benchmarkOnly(paths)) {
          const roots = [...new Set(paths.map((p) => p.split('/').slice(0, 2).join('/')))]
          for (const root of roots) {
            if (await Bun.file(join(this.repoDir, root, 'package.json')).exists()) {
              const pkg = await Bun.file(join(this.repoDir, root, 'package.json')).json()
              if (pkg.scripts?.test) commands.unshift(['bun', '--cwd', root, 'run', 'test'])
              else
                throw new Error(
                  `Benchmark ${root} has no test script; provide applicable verification before resuming.`,
                )
            } else throw new Error(`Benchmark ${root} needs an explicit applicable test command.`)
          }
        }
        const testedSha = await this.git.head()
        s.verifyOutput = ''
        let passed = true
        for (const args of commands) {
          const result = await command(args, { cwd: this.repoDir, signal: this.signal.signal })
          s.verifyOutput += `\n$ ${args.join(' ')}\n${result.stdout}\n${result.stderr}\nExit: ${result.code}\n`
          await writeFile(join(this.records, 'verification.txt'), s.verifyOutput)
          if (this.signal.signal.aborted)
            throw new Interrupted('time', 'Execution window ended during verification.')
          if (result.code !== 0) {
            passed = false
            break
          }
        }
        if ((await this.git.head()) !== testedSha) throw new Error('Verification changed HEAD.')
        if (await this.git.run(['status', '--porcelain']))
          throw new Error(
            'Verification modified tracked or unignored files; resolve the dirty checkout before presentation.',
          )
        if (passed) {
          s.verifiedSha = testedSha
          s.stage = 'present'
        } else {
          s.verifiedSha = null
          s.stage = 'fix-verify'
        }
        break
      }
      case 'present': {
        s.headSha = await this.git.head()
        if (!readyToPresent(s))
          throw new Error(
            'Final audit, review, or verification does not cover the exact presented commit.',
          )
        await this.publish(false)
        await this.update({
          status: 'complete',
          activeRunId: null,
          reason: 'All checks passed. Pull request ready for human review.',
        })
        return
      }
    }
    s.session = null
    s.headSha = await this.git.head()
    await this.git.push(this.branch)
    await this.checkpoint()
  }

  private async publish(draft: boolean): Promise<void> {
    const s = this.snapshot
    if (!(await this.changed()).length) {
      if (!draft) throw new Error('There are no implementation changes to present in a PR.')
      return
    }
    await this.git.push(this.branch)
    const publication = new GitHub(this.github.repo, process.env.CODEX_GITHUB_TOKEN || this.token)
    const prs = await publication.call<
      Array<{ number: number; html_url: string; draft: boolean; node_id: string }>
    >(
      `/repos/${this.github.repo}/pulls?state=open&head=${this.github.repo.split('/')[0]}:${this.branch}`,
    )
    const closing = [...new Set([s.issue, ...Object.values(s.ticketIssues)])]
      .map((number) => `Closes #${number}`)
      .join('\n')
    const body =
      `${s.plan?.summary ?? s.issueTitle}\n\n${draft ? 'Implementation is incomplete; see the issue for the saved checkpoint and blocker.' : closing}\n\n` +
      `## Verification\n\nCommit: \`${s.headSha}\`\n\n` +
      `- Tickets integrated: ${s.completed.length}/${s.tickets.length}\n- Feature audit: ${s.auditSha === s.headSha ? 'passed' : 'incomplete'}\n` +
      `- Code review: ${s.reviewSha === s.headSha ? 'passed' : 'incomplete'}\n- Verification: ${s.verifiedSha === s.headSha ? 'passed' : 'incomplete'}\n\n` +
      `[Workflow run](https://github.com/${this.github.repo}/actions/runs/${this.runId}). Detailed records are in the encrypted checkpoint artifact.`
    let pr = prs[0]
    if (pr) {
      await publication.call(`/repos/${this.github.repo}/pulls/${pr.number}`, 'PATCH', { body })
    } else {
      pr = await publication.call(`/repos/${this.github.repo}/pulls`, 'POST', {
        title: s.plan?.title ?? s.issueTitle,
        head: this.branch,
        base: this.defaultBranch,
        body,
        draft: true,
      })
    }
    if (!pr) throw new Error('GitHub did not return the published pull request.')
    const ensureReady = async () => {
      const latest = await this.github.state(s.issue)
      if (latest?.state.pipelineId !== s.pipelineId || latest.state.status !== 'running')
        throw new Interrupted('cancelled', 'Pipeline stopped before PR promotion.')
      if (this.signal.signal.aborted || (s.deadline !== null && Date.now() >= s.deadline))
        throw new Interrupted('time', 'Execution window ended before PR promotion.')
      await publication.validatePrHead(pr!.number, s.headSha, this.defaultBranch, this.branch)
    }
    if (!draft) await ensureReady()
    if (pr.draft !== draft) {
      const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'
      await publication.call('/graphql', 'POST', {
        query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id}}}`,
        variables: { id: pr.node_id },
      })
    }
    if (!draft) await ensureReady()
    await this.github.comment(
      s.issue,
      `${draft ? 'Work saved in a draft' : 'Ready for human review'}: ${pr!.html_url}`,
    )
  }

  async execute(): Promise<void> {
    const stop = () => {
      this.interruptedBy = 'cancelled'
      this.signal.abort()
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    const remaining =
      this.record.state.deadline === null
        ? executionWindow(process.env.CODEX_SDLC_WINDOW_MINUTES)
        : Math.min(
            executionWindow(process.env.CODEX_SDLC_WINDOW_MINUTES),
            this.record.state.deadline - this.started,
          )
    const timer = setTimeout(() => this.signal.abort(), Math.max(1, remaining))
    let polling = false
    const poll = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const latest = await this.github.state(this.record.state.issue)
        if (latest?.state.status === 'cancelled') stop()
      } catch {
        /* checkpoint ownership checks fail closed before advancing */
      } finally {
        polling = false
      }
    }, 30_000)
    try {
      await this.update({ status: 'running', activeRunId: this.runId, reason: '' })
      await this.initialize()
      while (this.record.state.status === 'running') {
        if (this.checkpointCount >= CHECKPOINTS_PER_WINDOW) {
          throw new Interrupted(
            'time',
            'Checkpoint budget reached; continuing in a fresh Actions job.',
          )
        }
        if (this.signal.signal.aborted) throw new Interrupted('time', 'Execution window ended.')
        await this.step()
      }
    } catch (error) {
      let status: QueueState['status'] = 'blocked'
      let reason = error instanceof Error ? error.message : 'Unexpected controller failure.'
      let notBefore = Date.now()
      if (error instanceof Interrupted) {
        if (error.kind === 'quota') {
          status = 'waiting-quota'
          notBefore = error.notBefore
        }
        if (error.kind === 'time') status = 'queued'
        if (error.kind === 'cancelled') status = 'cancelled'
      }
      if (this.signal.signal.aborted)
        status = this.interruptedBy === 'cancelled' ? 'cancelled' : 'queued'
      if (this.record.state.deadline !== null && Date.now() >= this.record.state.deadline) {
        status = 'blocked'
        reason = 'Five-day deadline reached; explicit maintainer resume is required.'
      }
      if (this.authWriteFailed) {
        status = 'blocked'
        reason = 'Subscription credential write-back failed. Reseed before resuming.'
      }
      try {
        if (this.snapshot) {
          await this.checkpoint()
          await this.publish(true)
        }
      } catch {
        status = 'blocked'
        reason +=
          ' Saving or publishing the latest work failed; inspect the last checkpoint before resuming.'
      }
      await this.update({ status, reason, notBefore, activeRunId: null })
      console.log(`Codex SDLC stopped: ${status}. ${reason}`)
      if (status === 'blocked') process.exitCode = 1
    } finally {
      clearTimeout(timer)
      clearInterval(poll)
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      try {
        await this.persistAuth()
      } catch {
        if (this.snapshot) {
          try {
            await this.publish(true)
          } catch {
            /* retain the existing checkpoint and block */
          }
        }
        await this.update({
          status: 'blocked',
          activeRunId: null,
          reason: 'Subscription credential write-back failed. Reseed before resuming.',
        })
        process.exitCode = 1
      }
      await rm(this.home, { recursive: true, force: true })
    }
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required workflow configuration is missing: ${name}`)
  return value
}

export async function main(): Promise<void> {
  const event = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8')) as Event
  const branch = event.repository.default_branch
  if (process.env.GITHUB_REF !== `refs/heads/${branch}`)
    throw new Error('SDLC control code must run from the default branch.')
  const token = required('GITHUB_TOKEN')
  const github = new GitHub(required('GITHUB_REPOSITORY'), token)
  const operation = process.argv[2]
  if (operation === 'gate') return gate(github, event)
  if (operation === 'continue') return continueQueue(github, branch)
  if (operation === 'diagnose') {
    const actor = process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR ?? ''
    if (!authorized(await github.permission(actor)))
      throw new Error('Only repository maintainers may diagnose Codex SDLC.')
    const issue = Number(required('SDLC_ISSUE'))
    if (!Number.isSafeInteger(issue) || issue < 1)
      throw new Error('A positive issue number is required.')
    return diagnoseCheckpoint(github, issue, token, required('CODEX_SDLC_STATE_KEY'), branch)
  }
  if (operation !== 'execute') throw new Error('Unknown controller operation.')
  const issue = Number(required('SDLC_ISSUE'))
  const record = await github.state(issue)
  if (!record || record.state.pipelineId !== required('SDLC_PIPELINE') || !eligible(record.state))
    return
  if (record.state.activeRunId && record.state.activeRunId !== Number(required('GITHUB_RUN_ID')))
    return
  const until = await subscriptionWaitUntil(github)
  if (until > Date.now()) {
    await github.save(
      {
        ...record.state,
        status: 'waiting-quota',
        notBefore: until,
        activeRunId: null,
        reason: 'Waiting for the shared subscription allowance.',
      },
      record.commentId,
    )
    return
  }
  try {
    if (!authorized(await github.permission(record.state.requestedBy)))
      throw new Error('The approving maintainer no longer has write access.')
    await new Pipeline(github, record, branch, token).execute()
  } catch (error) {
    const latest = await github.state(issue)
    if (latest?.state.pipelineId !== record.state.pipelineId) throw error
    await github.save(
      {
        ...latest.state,
        status: latest.state.status === 'cancelled' ? 'cancelled' : 'blocked',
        activeRunId: null,
        reason: error instanceof Error ? error.message : 'Controller setup failed.',
      },
      latest.commentId,
    )
    throw error
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'SDLC controller failed.')
    process.exitCode = 1
  })
