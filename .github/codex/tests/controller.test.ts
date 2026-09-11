import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { parse } from 'yaml'
import {
  AuditResult,
  FIVE_DAYS,
  NAMES,
  QueueState,
  Snapshot,
  WorkResult,
  auditPasses,
  authorized,
  benchmarkOnly,
  executionWindow,
  hash,
  nextWave,
  parseCommand,
  readyToPresent,
  retryAt,
  transition,
  validateTickets,
  validateWork,
} from '../model'
import { GitHub, parseState } from '../github'
import { Git } from '../git'
import {
  continueQueue,
  eligible,
  gate,
  requestedOperation,
  subscriptionWaitUntil,
} from '../controller'
import {
  Interrupted,
  availableSession,
  childEnvironment,
  classifyFailure,
  command,
  runCodex,
} from '../process'
import {
  Storage,
  decrypt,
  encrypt,
  sessionEntry,
  stateKey,
  validateAuth,
  writeBackAuth,
} from '../storage'

const directories: string[] = []
async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-sdlc-test-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const sha = 'a'.repeat(40)
const tickets = [
  {
    id: 'contract',
    title: 'Contract',
    body: 'Implement shared type.',
    dependencies: [],
    criteria: [{ id: 'typed', text: 'Round trips through the typed protocol.' }],
  },
  {
    id: 'cli',
    title: 'CLI',
    body: 'Implement method.',
    dependencies: ['contract'],
    criteria: [{ id: 'tested', text: 'Method has regression coverage.' }],
  },
  {
    id: 'desktop',
    title: 'Desktop',
    body: 'Implement screen.',
    dependencies: ['contract'],
    criteria: [{ id: 'visible', text: 'The screen presents the method result.' }],
  },
]
function snapshot(): Snapshot {
  return Snapshot.parse({
    version: 1,
    issue: 12,
    pipelineId: '11111111-1111-4111-8111-111111111111',
    mode: 'full',
    stage: 'implement',
    issueTitle: 'Feature',
    requirements: 'Implement feature',
    requirementsHash: hash('Implement feature'),
    approvedRequirementsHash: hash('Implement feature'),
    baseSha: sha,
    headSha: sha,
    defaultBranch: 'main',
    plan: null,
    tickets,
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
    approvedAt: 100,
    deadline: 100 + FIVE_DAYS,
    revision: 0,
  })
}
function audit() {
  return AuditResult.parse({
    summary: 'All criteria inspected.',
    criteria: tickets.flatMap((t) =>
      t.criteria.map((c) => ({
        ticketId: t.id,
        criterionId: c.id,
        status: 'PASS',
        evidence: 'src/module.ts:12 and tests/module.test.ts:20',
      })),
    ),
  })
}

describe('commands and authorization', () => {
  test('matches only complete trimmed commands', () => {
    expect(parseCommand(' \t/approve-team-sdlc\r\n')).toBe('approve')
    for (const text of [
      'Please /approve-team-sdlc',
      '/approve-team-sdlc tomorrow',
      '`/approve-team-sdlc`',
      '/codex-team-resume\nextra',
      '/claude-team-review-now',
    ])
      expect(parseCommand(text)).toBeNull()
    for (const operation of ['implement', 'review'] as const)
      expect(parseCommand(`/codex-team-${operation}-now`)).toBe(operation)
    expect(parseCommand('/codex-team-resume')).toBe('resume')
    expect(parseCommand('/codex-team-cancel')).toBe('cancel')
  })
  test('only write, maintain, and admin can authorize work', () => {
    for (const permission of ['write', 'maintain', 'admin'])
      expect(authorized(permission)).toBe(true)
    for (const permission of ['read', 'triage', 'none', 'OWNER', 'MEMBER'])
      expect(authorized(permission)).toBe(false)
  })
  test('ignores PR comments and unrelated events', () => {
    const event = {
      repository: { default_branch: 'main' },
      action: 'created',
      comment: { body: '/approve-team-sdlc' },
      issue: { number: 12, title: '', body: '', state: 'open', pull_request: {} },
    }
    expect(requestedOperation(event, 'issue_comment')).toBeNull()
    expect(requestedOperation({ repository: event.repository }, 'push')).toBeNull()
    expect(
      requestedOperation(
        { repository: event.repository, inputs: { operation: 'approve' } },
        'workflow_dispatch',
      ),
    ).toBe('approve')
  })
  test('rejects duplicate active pipelines, allows cancellation', () => {
    const initial = transition(null, 'approve', 12, 'maintainer', 100)
    for (const status of ['queued', 'running', 'waiting-quota'] as const) {
      expect(() => transition({ ...initial, status }, 'plan', 12, 'maintainer', 200)).toThrow(
        'already active',
      )
    }
    expect(transition(initial, 'cancel', 12, 'maintainer', 200).status).toBe('cancelled')
  })
  test('the command gate rejects unauthorized requests before any GitHub mutation', async () => {
    const output = join(await temp(), 'outputs')
    const saved = {
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_TRIGGERING_ACTOR: process.env.GITHUB_TRIGGERING_ACTOR,
    }
    Object.assign(process.env, {
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_TRIGGERING_ACTOR: 'reader',
    })
    const mutations: string[] = []
    const github = new GitHub('owner/repo', 'token', (async (url: string, init?: RequestInit) => {
      if (init?.method !== 'GET') mutations.push(url)
      return new Response(JSON.stringify({ permission: 'read' }))
    }) as typeof fetch)
    try {
      await expect(
        gate(github, {
          repository: { default_branch: 'main' },
          inputs: { issue_number: '12', operation: 'approve' },
        }),
      ).rejects.toThrow('maintainers')
      expect(mutations).toHaveLength(0)
      expect(await readFile(output, 'utf8')).toBe('execute=false\n')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  test('continuation cannot steal an issue from an existing queued Actions run', async () => {
    const output = join(await temp(), 'outputs')
    const saved = {
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_TRIGGERING_ACTOR: process.env.GITHUB_TRIGGERING_ACTOR,
    }
    Object.assign(process.env, {
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '11',
      GITHUB_TRIGGERING_ACTOR: 'github-actions[bot]',
    })
    const state = { ...transition(null, 'approve', 12, 'writer'), activeRunId: 10 }
    const mutations: string[] = []
    const github = new GitHub('owner/repo', 'token', (async (url: string, init?: RequestInit) => {
      if (init?.method !== 'GET') mutations.push(url)
      if (url.includes('/actions/runs/')) return new Response(JSON.stringify({ status: 'queued' }))
      return new Response(
        JSON.stringify([
          {
            id: 1,
            body: `<!-- codex-sdlc-state:v1 -->\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ]),
      )
    }) as typeof fetch)
    try {
      await gate(github, {
        repository: { default_branch: 'main' },
        inputs: { issue_number: '12', operation: 'continue', pipeline_id: state.pipelineId },
      })
      expect(mutations).toHaveLength(0)
      expect(await readFile(output, 'utf8')).toBe('execute=false\n')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  test('approval advances a saved plan; automatic scheduling never extends its deadline', () => {
    const initial = transition(null, 'plan', 12, 'maintainer', 100)
    const previous = {
      ...initial,
      status: 'waiting-approval' as const,
      checkpoint: {
        artifactId: 3,
        runId: 4,
        name: 'codex-sdlc-12-test',
        digest: 'b'.repeat(64),
        controllerSha: sha,
      },
    }
    const approved = transition(previous, 'approve', 12, 'maintainer', 500)
    expect(approved.pipelineId).toBe(initial.pipelineId)
    expect(approved.stage).toBe('tickets')
    expect(approved.deadline).toBe(500 + FIVE_DAYS)
    expect(eligible(approved, 501)).toBe(true)
    expect(eligible(approved, approved.deadline!)).toBe(false)
    expect(approved.deadline).toBe(500 + FIVE_DAYS)
    expect(eligible({ ...approved, status: 'waiting-quota', notBefore: 1000 }, 999)).toBe(false)
  })
  test('only explicit resume gives a stopped checkpoint a new window', () => {
    const previous = transition(null, 'approve', 12, 'maintainer', 100)
    expect(() =>
      transition({ ...previous, status: 'blocked' }, 'resume', 12, 'maintainer'),
    ).toThrow('checkpoint')
    const resumed = transition(
      {
        ...previous,
        status: 'blocked',
        checkpoint: {
          artifactId: 3,
          runId: 4,
          name: 'codex-sdlc-12-test',
          digest: 'b'.repeat(64),
          controllerSha: sha,
        },
      },
      'resume',
      12,
      'maintainer',
      900,
    )
    expect(resumed.deadline).toBe(900 + FIVE_DAYS)
    expect(resumed.pipelineId).toBe(previous.pipelineId)
  })
})

describe('completion gates', () => {
  test('orders dependency waves and limits parallelism to three', () => {
    expect(nextWave(tickets, []).map((t) => t.id)).toEqual(['contract'])
    expect(nextWave(tickets, ['contract']).map((t) => t.id)).toEqual(['cli', 'desktop'])
    const independent = Array.from({ length: 7 }, (_, i) => ({ ...tickets[0]!, id: `ticket-${i}` }))
    expect(nextWave(independent, [])).toHaveLength(3)
  })
  test('rejects missing dependencies, cycles, duplicate IDs and criteria', () => {
    expect(() => validateTickets([{ ...tickets[0]!, dependencies: ['missing'] }])).toThrow(
      'Unknown',
    )
    expect(() => validateTickets([{ ...tickets[0]!, dependencies: ['contract'] }])).toThrow(
      'Circular',
    )
    expect(() => validateTickets([tickets[0]!, tickets[0]!])).toThrow('Duplicate')
    expect(() =>
      validateTickets([
        { ...tickets[0]!, criteria: [tickets[0]!.criteria[0]!, tickets[0]!.criteria[0]!] },
      ]),
    ).toThrow('Duplicate')
  })
  test('requires exactly one completed worker with evidence per assigned criterion', () => {
    const assignments = [{ name: NAMES[0], ticketId: 'contract', branch: 'codex/worker-sam' }]
    const result = WorkResult.parse({
      workers: [
        {
          name: 'Sam',
          sessionId: '11111111-1111-4111-8111-111111111111',
          ticketId: 'contract',
          status: 'completed',
          summary: 'Done',
          criteria: [{ id: 'typed', status: 'pass', evidence: 'Passing contract regression.' }],
        },
      ],
    })
    expect(() => validateWork(result, assignments, tickets)).not.toThrow()
    expect(() => validateWork({ workers: [] }, assignments, tickets)).toThrow('Missing')
    expect(() =>
      validateWork({ workers: [result.workers[0]!, result.workers[0]!] }, assignments, tickets),
    ).toThrow()
    result.workers[0]!.criteria[0]!.status = 'unverified'
    expect(() => validateWork(result, assignments, tickets)).toThrow('incomplete')
  })
  test('missing, malformed, or partial audits never pass', () => {
    expect(auditPasses(audit(), tickets)).toBe(true)
    expect(() => AuditResult.parse(null)).toThrow()
    expect(() => auditPasses({ summary: 'No gaps', criteria: [] }, tickets)).toThrow(
      'every criterion',
    )
    const partial = audit()
    partial.criteria[0]!.status = 'PARTIAL'
    expect(auditPasses(partial, tickets)).toBe(false)
    const duplicate = audit()
    duplicate.criteria[0] = duplicate.criteria[1]!
    expect(() => auditPasses(duplicate, tickets)).toThrow('exactly once')
  })
  test('presentation requires every independent gate at the exact HEAD', () => {
    const state = snapshot()
    state.completed = tickets.map((t) => t.id)
    state.audit = audit()
    state.review = { summary: 'Reviewed', findings: [] }
    state.auditSha = state.reviewSha = state.verifiedSha = sha
    expect(readyToPresent(state)).toBe(true)
    for (const field of ['auditSha', 'reviewSha', 'verifiedSha'] as const) {
      expect(readyToPresent({ ...state, [field]: 'b'.repeat(40) })).toBe(false)
    }
    expect(readyToPresent({ ...state, completed: [] })).toBe(false)
    expect(
      readyToPresent({
        ...state,
        review: {
          summary: 'Found issue',
          findings: [
            {
              id: 'bug',
              severity: 'warning',
              file: 'src/file.ts',
              detail: 'Bug',
            },
          ],
        },
      }),
    ).toBe(false)
  })
  test('benchmark exception cannot skip desktop checks for mixed changes', () => {
    expect(benchmarkOnly(['benchmarks/arc/test.ts'])).toBe(true)
    expect(benchmarkOnly([])).toBe(false)
    expect(benchmarkOnly(['benchmarks/arc/test.ts', 'packages/shared/index.ts'])).toBe(false)
  })

  test('smoke-test windows can be shorter but never exceed five hours', () => {
    expect(executionWindow()).toBe(5 * 60 * 60 * 1000)
    expect(executionWindow('1')).toBe(60_000)
    for (const value of ['0', '301', '1.5', 'invalid'])
      expect(() => executionWindow(value)).toThrow()
  })
})

describe('continuation scheduler', () => {
  function backend(state: QueueState, run: { status: string; conclusion: string | null }) {
    const dispatched: unknown[] = []
    const client = new GitHub('owner/repo', 'token', (async (url: string, init?: RequestInit) => {
      if (url.includes('/dispatches')) {
        dispatched.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }
      if (init?.method === 'PATCH') {
        const parsed = JSON.parse(String(init.body)) as { body: string }
        state = parseState(
          { id: 1, body: parsed.body, user: { login: 'github-actions[bot]', type: 'Bot' } },
          state.issue,
        )!
        return new Response(JSON.stringify({ id: 1 }))
      }
      if (url.includes('/comments'))
        return new Response(
          JSON.stringify([
            {
              id: 1,
              body: `<!-- codex-sdlc-state:v1 -->\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            },
          ]),
        )
      if (url.includes('/actions/runs/')) return new Response(JSON.stringify(run))
      return new Response(JSON.stringify([{ number: state.issue }]))
    }) as typeof fetch)
    return { client, dispatched, state: () => state }
  }
  const checkpoint = {
    artifactId: 3,
    runId: 4,
    name: 'codex-sdlc-12-test',
    digest: 'b'.repeat(64),
    controllerSha: sha,
  }
  test('dispatches eligible work but never dispatches before a quota reset', async () => {
    const state = transition(null, 'approve', 12, 'maintainer')
    const pending = backend(state, { status: 'completed', conclusion: 'success' })
    await continueQueue(pending.client, 'main')
    expect(pending.dispatched).toHaveLength(1)
    expect(pending.dispatched[0]).toEqual({
      ref: 'main',
      inputs: { issue_number: '12', operation: 'continue', pipeline_id: state.pipelineId },
    })
    const limited = backend(
      { ...state, status: 'waiting-quota', notBefore: Date.now() + 60_000 },
      { status: 'completed', conclusion: 'success' },
    )
    await continueQueue(limited.client, 'main')
    expect(limited.dispatched).toHaveLength(0)
  })
  test('waits for the existing runner instead of dispatching another copy', async () => {
    const state = {
      ...transition(null, 'approve', 12, 'maintainer'),
      status: 'running' as const,
      activeRunId: 10,
    }
    const running = backend(state, { status: 'in_progress', conclusion: null })
    await continueQueue(running.client, 'main')
    expect(running.dispatched).toHaveLength(0)
  })
  test('quota waits pause other issues sharing the same subscription', async () => {
    const waiting = {
      ...transition(null, 'approve', 12, 'maintainer'),
      status: 'waiting-quota' as const,
      notBefore: Date.now() + 3_600_000,
    }
    const queued = transition(null, 'approve', 13, 'maintainer')
    const dispatched: string[] = []
    const github = new GitHub('owner/repo', 'token', (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        dispatched.push(url)
        return new Response(null, { status: 204 })
      }
      if (url.includes('/comments')) {
        const state = url.includes('/issues/12/') ? waiting : queued
        return new Response(
          JSON.stringify([
            {
              id: state.issue,
              body: `<!-- codex-sdlc-state:v1 -->\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
              user: { login: 'github-actions[bot]', type: 'Bot' },
            },
          ]),
        )
      }
      return new Response(JSON.stringify([{ number: 12 }, { number: 13 }]))
    }) as typeof fetch)
    expect(await subscriptionWaitUntil(github)).toBe(waiting.notBefore)
    await continueQueue(github, 'main')
    expect(dispatched).toHaveLength(0)
  })
  test('recovers a failed runner from its checkpoint', async () => {
    const state = {
      ...transition(null, 'approve', 12, 'maintainer'),
      status: 'running' as const,
      activeRunId: 10,
      checkpoint,
    }
    const crashed = backend(state, { status: 'completed', conclusion: 'failure' })
    await continueQueue(crashed.client, 'main')
    expect(crashed.state().status).toBe('queued')
    expect(crashed.state().deadline).toBe(state.deadline)
    expect(crashed.dispatched).toHaveLength(1)
  })
  test('cancellation of active work stops it; a displaced pending job remains queued', async () => {
    const state = { ...transition(null, 'approve', 12, 'maintainer'), activeRunId: 10, checkpoint }
    const active = backend(
      { ...state, status: 'running' },
      { status: 'completed', conclusion: 'cancelled' },
    )
    await continueQueue(active.client, 'main')
    expect(active.state().status).toBe('cancelled')
    expect(active.dispatched).toHaveLength(0)
    const displaced = backend(state, { status: 'completed', conclusion: 'cancelled' })
    await continueQueue(displaced.client, 'main')
    expect(displaced.state().status).toBe('queued')
    expect(displaced.dispatched).toHaveLength(1)
  })
  test('failed setup and expired five-day windows stop rather than retry forever', async () => {
    const state = { ...transition(null, 'approve', 12, 'maintainer'), activeRunId: 10 }
    const failed = backend(state, { status: 'completed', conclusion: 'failure' })
    await continueQueue(failed.client, 'main')
    expect(failed.state().status).toBe('blocked')
    expect(failed.dispatched).toHaveLength(0)
    const expired = backend(
      { ...state, activeRunId: null, deadline: Date.now() - 1 },
      { status: 'completed', conclusion: 'success' },
    )
    await continueQueue(expired.client, 'main')
    expect(expired.state().status).toBe('blocked')
    expect(expired.dispatched).toHaveLength(0)
  })
})

describe('Codex subprocess boundary', () => {
  test('drops GitHub, artifact, and credential-write secrets from model and build environments', () => {
    expect(
      childEnvironment({
        PATH: '/bin',
        HOME: '/home/runner',
        GITHUB_TOKEN: 'secret',
        CODEX_AUTH_JSON: 'auth',
        CODEX_AUTH_WRITE_TOKEN: 'writer',
        ACTIONS_RUNTIME_TOKEN: 'artifact',
        CODEX_GITHUB_TOKEN: 'pat',
        CODEX_SDLC_STATE_KEY: 'key',
        OPENAI_API_KEY: 'api',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/home/runner' })
  })
  test('classifies quota resets and auth failure without treating them as success', () => {
    expect(classifyFailure('usage_limit_reached resets_at: 1900000000', 1000)?.notBefore).toBe(
      1900000000000 + 60000,
    )
    expect(classifyFailure('429 rate limit', 1000)?.notBefore).toBe(3601000)
    expect(classifyFailure('refresh_token_reused')?.kind).toBe('auth')
    expect(classifyFailure('model is not available')).toBeNull()
    expect(retryAt('usage limit', 10)).toBe(3600010)
  })
  test('fake Codex captures session ID and resumes it with structured output', async () => {
    const dir = await temp()
    const binary = join(dir, 'fake-codex')
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\n` +
        `if(process.env.GITHUB_TOKEN || process.env.CODEX_AUTH_WRITE_TOKEN) process.exit(9);\n` +
        `await Bun.write(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));\n` +
        `await Bun.write(args[args.indexOf('--output-last-message')+1], JSON.stringify({ok:true}));\n` +
        `console.log(JSON.stringify({type:'thread.started',thread_id:'saved-session'}));\n`,
    )
    await chmod(binary, 0o755)
    const options = {
      cwd: dir,
      home: dir,
      workDir: join(dir, 'stage'),
      prompt: 'Test',
      resultSchema: z.object({ ok: z.boolean() }).strict(),
      model: 'test-model',
      effort: 'xhigh',
      signal: new AbortController().signal,
      onSession: (_id: string) => {},
      binary,
    }
    let session = ''
    expect(
      await runCodex({
        ...options,
        onSession: (id) => {
          session = id
        },
      }),
    ).toEqual({ ok: true })
    expect(session).toBe('saved-session')
    await mkdir(join(dir, 'sessions'))
    await writeFile(join(dir, 'sessions', 'rollout-saved-session.jsonl'), '{}\n')
    await runCodex({ ...options, sessionId: session })
    const args = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8')) as string[]
    expect(args.slice(args.indexOf('exec'), args.indexOf('exec') + 3)).toEqual([
      'exec',
      'resume',
      session,
    ])
    await rm(join(dir, 'sessions'), { recursive: true })
    await runCodex({ ...options, sessionId: session })
    expect(JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'))).not.toContain('resume')
    expect(await availableSession(dir, session)).toBeUndefined()
  })
  test('native completion events must substantiate every reported worker', async () => {
    const dir = await temp()
    const binary = join(dir, 'native-workers')
    const options = {
      cwd: dir,
      home: dir,
      workDir: join(dir, 'stage'),
      prompt: 'Test',
      resultSchema: z.object({ worker: z.string() }),
      model: 'test',
      effort: 'xhigh',
      signal: new AbortController().signal,
      onSession: () => {},
      binary,
      workerIds: (result: { worker: string }) => [result.worker],
    }
    const script = async (status?: string) => {
      const event = {
        type: 'item.completed',
        item: {
          id: 'wait',
          type: 'collab_tool_call',
          tool: 'wait',
          receiver_thread_ids: ['sam'],
          agents_states: { sam: { status } },
          status: 'completed',
        },
      }
      await writeFile(
        binary,
        '#!/usr/bin/env bun\n' +
          `const args = process.argv.slice(2);\n` +
          `await Bun.write(args[args.indexOf('--output-last-message')+1], JSON.stringify({worker:'sam'}));\n` +
          (status ? `console.log(${JSON.stringify(JSON.stringify(event))});\n` : ''),
      )
      await chmod(binary, 0o755)
    }
    await script()
    await expect(runCodex(options)).rejects.toThrow('matching native')
    await script('running')
    await expect(runCodex(options)).rejects.toThrow('unfinished')
    await script('errored')
    await expect(runCodex(options)).rejects.toThrow('matching native')
    await script('completed')
    expect(await runCodex(options)).toEqual({ worker: 'sam' })
  })
  test('unavailable models fail clearly without exposing raw diagnostics', async () => {
    const dir = await temp()
    const binary = join(dir, 'unavailable')
    await writeFile(
      binary,
      '#!/bin/sh\necho "model is not available sensitive-diagnostic" >&2\nexit 1\n',
    )
    await chmod(binary, 0o755)
    await expect(
      runCodex({
        cwd: dir,
        home: dir,
        workDir: join(dir, 'stage'),
        prompt: 'Test',
        resultSchema: z.object({ ok: z.boolean() }),
        model: 'gpt-unavailable',
        effort: 'xhigh',
        signal: new AbortController().signal,
        onSession: () => {},
        binary,
      }),
    ).rejects.toThrow(
      'Configured Codex model gpt-unavailable or reasoning effort xhigh is unavailable',
    )
  })
  test('a successful exit with no report cannot reuse a stale result', async () => {
    const dir = await temp()
    const binary = join(dir, 'no-result')
    await writeFile(binary, '#!/bin/sh\nexit 0\n')
    await chmod(binary, 0o755)
    await mkdir(join(dir, 'stage'))
    await writeFile(join(dir, 'stage', 'result.json'), '{"ok":true}')
    await expect(
      runCodex({
        cwd: dir,
        home: dir,
        workDir: join(dir, 'stage'),
        prompt: 'Test',
        resultSchema: z.object({ ok: z.boolean() }),
        model: 'test',
        effort: 'high',
        signal: new AbortController().signal,
        onSession: () => {},
        binary,
      }),
    ).rejects.toThrow('structured report')
  })
  test('interruption terminates the process and remains resumable', async () => {
    const dir = await temp()
    const signal = new AbortController()
    const timer = setTimeout(() => signal.abort(), 100)
    const result = await command(['bash', '-c', 'sleep 30'], { cwd: dir, signal: signal.signal })
    clearTimeout(timer)
    expect(result.code).not.toBe(0)
    expect(signal.signal.aborted).toBe(true)
    expect(new Interrupted('time', 'Window ended').kind).toBe('time')
  })
})

describe('encrypted storage and GitHub provenance', () => {
  test('encryption binds checkpoints to their pipeline and detects tampering', () => {
    const key = Buffer.alloc(32, 7)
    const encrypted = encrypt(Buffer.from('private session'), key, 'repo/12/pipeline')
    expect(encrypted.includes(Buffer.from('private session'))).toBe(false)
    expect(decrypt(encrypted, key, 'repo/12/pipeline').toString()).toBe('private session')
    expect(() => decrypt(encrypted, key, 'repo/13/pipeline')).toThrow()
    encrypted[40] = encrypted[40]! ^ 1
    expect(() => decrypt(encrypted, key, 'repo/12/pipeline')).toThrow()
    expect(() => stateKey('bad')).toThrow('32-byte')
  })
  test('never checkpoints auth, plugins, config, or arbitrary Codex home entries', () => {
    for (const path of ['auth.json', 'config.toml', 'plugins', 'credentials', '../auth.json'])
      expect(sessionEntry(path)).toBe(false)
    for (const path of ['sessions', 'archived_sessions', 'state_5.sqlite', 'state_5.sqlite-wal'])
      expect(sessionEntry(path)).toBe(true)
  })
  test('writes refreshed auth from disk, not the original environment seed', async () => {
    const dir = await temp()
    const auth = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'new-access', refresh_token: 'new-refresh' },
    })
    await writeFile(join(dir, 'auth.json'), auth)
    let seen = ''
    await writeBackAuth(dir, 'owner/repo', 'writer', async (_args, options) => {
      seen = await readFile(options.env!.SDLC_AUTH_FILE!, 'utf8')
      expect(options.env!.GH_TOKEN).toBe('writer')
      expect(options.env!.CODEX_AUTH_JSON).toBeUndefined()
      return { code: 0, stdout: '', stderr: '' }
    })
    expect(seen).toBe(auth)
    expect(() => validateAuth('{"auth_mode":"apikey"}')).toThrow('managed ChatGPT')
    await expect(
      writeBackAuth(dir, 'owner/repo', 'writer', async () => ({ code: 1, stdout: '', stderr: '' })),
    ).rejects.toThrow('persist')
  })
  test('ignores spoofed state comments and mismatched issue identities', () => {
    const state = transition(null, 'plan', 12, 'maintainer', 100)
    const body = `<!-- codex-sdlc-state:v1 -->\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``
    expect(parseState({ id: 1, body, user: { login: 'attacker', type: 'User' } }, 12)).toBeNull()
    expect(
      parseState({ id: 1, body, user: { login: 'github-actions[bot]', type: 'Bot' } }, 13),
    ).toBeNull()
    expect(
      parseState({ id: 1, body, user: { login: 'github-actions[bot]', type: 'Bot' } }, 12),
    ).toEqual(state)
  })
  test('artifact restoration verifies workflow, branch, run, and controller commit', async () => {
    let branch = 'main'
    const client = new GitHub(
      'owner/repo',
      'token',
      (async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/artifacts/')
              ? {
                  name: 'codex-sdlc-12-test',
                  expired: false,
                  workflow_run: { id: 4, head_sha: sha },
                }
              : {
                  id: 4,
                  name: 'Codex Team SDLC',
                  path: '.github/workflows/codex-team-sdlc.yml',
                  head_branch: branch,
                },
          ),
          { status: 200 },
        )) as typeof fetch,
    )
    const ref = {
      artifactId: 3,
      runId: 4,
      name: 'codex-sdlc-12-test',
      digest: 'b'.repeat(64),
      controllerSha: sha,
    }
    await client.validateArtifact(ref, 'main')
    branch = 'untrusted'
    await expect(client.validateArtifact(ref, 'main')).rejects.toThrow('provenance')
  })

  test('sub-issue creation recovers an unlinked issue instead of creating duplicates', async () => {
    let linked = false
    const mutations: string[] = []
    const issue = {
      id: 900,
      number: 91,
      title: 'Old ticket',
      body: '<!-- codex-sdlc-ticket: 12/contract -->',
    }
    let updates = 0
    const github = new GitHub('owner/repo', 'token', (async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        Object.assign(issue, JSON.parse(String(init.body)))
        updates++
        return new Response(JSON.stringify(issue))
      }
      if (init?.method === 'POST') {
        mutations.push(url)
        if (url.includes('/sub_issues')) linked = true
        return new Response(JSON.stringify(issue))
      }
      if (url.includes('/sub_issues')) return new Response(JSON.stringify(linked ? [issue] : []))
      return new Response(JSON.stringify([issue]))
    }) as typeof fetch)
    expect(await github.subIssue(12, tickets[0]!)).toBe(91)
    expect(await github.subIssue(12, tickets[0]!)).toBe(91)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toContain('/sub_issues')
    expect(updates).toBe(1)
    expect(issue.title).toBe(tickets[0]!.title)
    expect(issue.body).toContain(tickets[0]!.body)
  })

  test('PR promotion rejects a changed head, fork, or target branch', async () => {
    const pr = {
      state: 'open',
      head: { sha, ref: 'codex/sdlc-issue-12', repo: { full_name: 'owner/repo' } },
      base: { ref: 'main' },
    }
    const github = new GitHub(
      'owner/repo',
      'token',
      (async (_url: string) => new Response(JSON.stringify(pr))) as typeof fetch,
    )
    await github.validatePrHead(7, sha, 'main', 'codex/sdlc-issue-12')
    pr.head.sha = 'b'.repeat(40)
    await expect(github.validatePrHead(7, sha, 'main', 'codex/sdlc-issue-12')).rejects.toThrow(
      'exact verified',
    )
    pr.head.sha = sha
    pr.head.repo.full_name = 'fork/repo'
    await expect(github.validatePrHead(7, sha, 'main', 'codex/sdlc-issue-12')).rejects.toThrow(
      'exact verified',
    )
    pr.head.repo.full_name = 'owner/repo'
    pr.base.ref = 'other'
    await expect(github.validatePrHead(7, sha, 'main', 'codex/sdlc-issue-12')).rejects.toThrow(
      'exact verified',
    )
  })

  test('GraphQL HTTP 200 errors still fail PR promotion', async () => {
    const github = new GitHub(
      'owner/repo',
      'token',
      (async (_url: string) =>
        new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }))) as typeof fetch,
    )
    await expect(github.call('/graphql', 'POST', {})).rejects.toThrow('mutation failed')
  })
  test('checkpoint round trip restores records and sessions without replacing refreshed auth', async () => {
    const dir = await temp()
    const home = join(dir, 'home')
    const records = join(dir, 'records')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(records)
    await mkdir(join(dir, 'storage'))
    await writeFile(join(home, 'auth.json'), 'must-not-archive')
    await writeFile(join(home, 'sessions', 'session.jsonl'), 'saved session')
    await writeFile(join(records, 'plan.md'), 'Saved plan')
    let stored = ''
    let name = ''
    const store = {
      async uploadArtifact(artifactName: string, files: string[]) {
        name = artifactName
        stored = join(dir, 'uploaded.enc')
        await cp(files[0]!, stored)
        return { id: 9 }
      },
      async downloadArtifact(_id: number, options: { path: string }) {
        await cp(stored, join(options.path, 'checkpoint.enc'))
      },
    }
    const github = new GitHub(
      'owner/repo',
      'token',
      (async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/artifacts/')
              ? { name, expired: false, workflow_run: { id: 4, head_sha: sha } }
              : {
                  name: 'Codex Team SDLC',
                  path: '.github/workflows/codex-team-sdlc.yml',
                  head_branch: 'main',
                },
          ),
        )) as typeof fetch,
    )
    const storage = new Storage(join(dir, 'storage'), Buffer.alloc(32, 1), github, 'token', store)
    const state = snapshot()
    const ref = await storage.save(state, home, records, join(dir, 'absent.bundle'), 4, sha)
    await writeFile(join(home, 'auth.json'), 'new-current-auth')
    const queue = QueueState.parse({
      ...transition(null, 'approve', 12, 'maintainer'),
      pipelineId: state.pipelineId,
      checkpoint: ref,
    })
    const restored = await storage.restore(queue, home, records, 'main')
    expect(restored.snapshot).toEqual(state)
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('new-current-auth')
    expect(await readFile(join(home, 'sessions', 'session.jsonl'), 'utf8')).toBe('saved session')
  })
})

describe('worktree integration', () => {
  async function repository() {
    const dir = await temp()
    const git = new Git(dir, 'owner/repo', 'unused')
    await git.run(['init', '-b', 'main'])
    await git.run(['config', 'user.name', 'Test'])
    await git.run(['config', 'user.email', 'test@example.com'])
    await writeFile(join(dir, 'file.txt'), 'base\n')
    await git.commit('base')
    return { dir, git }
  }
  test('merges completed worktrees and preserves conflicting worker commits', async () => {
    const { dir, git } = await repository()
    const root = await temp()
    const sam = await git.worktree(root, 'Sam', 'codex/sam', false)
    const tim = await git.worktree(root, 'Tim', 'codex/tim', false)
    await writeFile(join(sam, 'file.txt'), 'Sam\n')
    await git.commit('Sam implements', sam)
    await writeFile(join(tim, 'file.txt'), 'Tim\n')
    await git.commit('Tim implements', tim)
    const timHead = await git.head(tim)
    await git.merge('codex/sam')
    await expect(git.merge('codex/tim')).rejects.toThrow('Merge conflict')
    expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('Sam\n')
    expect(await git.head(tim)).toBe(timHead)
    expect(await git.run(['status', '--porcelain'])).toBe('')
  })
  test('bundles incomplete worktree commits for restoration on a fresh checkout', async () => {
    const { dir, git } = await repository()
    const base = await git.head()
    const root = await temp()
    const sam = await git.worktree(root, 'Sam', 'codex/sam', false)
    await writeFile(join(sam, 'new.ts'), 'export const checkpoint = true\n')
    await git.commit('WIP', sam)
    const bundle = join(await temp(), 'state.bundle')
    await git.bundle(bundle, ['codex/sam'], base)
    const fresh = await temp()
    await command(['git', 'clone', '--branch', 'main', dir, fresh], { cwd: dir })
    const recovered = new Git(fresh, 'owner/repo', 'unused')
    await recovered.restoreBundle(bundle, ['codex/sam'])
    expect(await recovered.run(['show', 'codex/sam:new.ts'])).toBe('export const checkpoint = true')
  })
})

describe('workflow contracts', () => {
  const root = join(import.meta.dir, '..', '..')
  test('secret-bearing work is gated, serialized, bounded, and uses Blacksmith', async () => {
    const workflow = parse(await readFile(join(root, 'workflows/codex-team-sdlc.yml'), 'utf8'))
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.permissions).toEqual({})
    expect(workflow.jobs.execute.needs).toBe('command-gate')
    expect(workflow.jobs.execute.environment).toBe('codex-sdlc')
    expect(workflow.jobs.execute.timeout_minutes).toBeUndefined()
    expect(workflow.jobs.execute['timeout-minutes']).toBe(330)
    expect(workflow.jobs.execute.concurrency['cancel-in-progress']).toBe(false)
    expect(workflow.jobs.execute['runs-on']).toBe('blacksmith-8vcpu-ubuntu-2404')
    expect(workflow.jobs['command-gate'].permissions.contents).toBe('read')
    expect(JSON.stringify(workflow)).not.toMatch(/CLAUDE_CODE|FLY_API_TOKEN|OPENAI_API_KEY|leesy/i)
  })
  test('ordinary CI tests the controller without subscription credentials', async () => {
    const workflow = parse(await readFile(join(root, 'workflows/build.yml'), 'utf8'))
    expect(workflow.on.pull_request.paths).toContain('.github/codex/**')
    expect(workflow.on.pull_request.types).toContain('ready_for_review')
    const checks = JSON.stringify(workflow.jobs['sdlc-checks'])
    expect(checks).toContain('npm --prefix .github/codex test')
    expect(checks).not.toContain('secrets.')
    const continuation = parse(
      await readFile(join(root, 'workflows/codex-team-sdlc-continue.yml'), 'utf8'),
    )
    expect(continuation.on.schedule[0].cron).toBe('*/15 * * * *')
    expect(continuation.on.workflow_run.workflows).toEqual(['Codex Team SDLC'])
    expect(JSON.stringify(continuation)).not.toContain('secrets.')
  })
})
