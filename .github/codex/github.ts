import { appendFile } from 'node:fs/promises'
import { QueueState, STATE_LABEL, STATE_MARKER, WORKFLOW } from './model'

export interface Issue {
  number: number
  title: string
  body: string | null
  state: string
  pull_request?: unknown
}
export interface Comment {
  id: number
  body: string
  user: { login: string; type: string }
}
export interface StateRecord {
  commentId: number
  state: QueueState
}
interface Run {
  id: number
  status: string
  conclusion: string | null
  head_branch: string
  path: string
  name: string
}

export function parseState(comment: Comment, issue: number): QueueState | null {
  if (
    comment.user.login !== 'github-actions[bot]' ||
    comment.user.type !== 'Bot' ||
    !comment.body.startsWith(STATE_MARKER)
  )
    return null
  const match = /```json\n([\s\S]*?)\n```/.exec(comment.body)
  if (!match) return null
  try {
    const state = QueueState.parse(JSON.parse(match[1]!))
    return state.issue === issue ? state : null
  } catch {
    return null
  }
}

export class GitHub {
  constructor(
    readonly repo: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository.')
  }

  async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/')) throw new Error('GitHub API paths must be relative.')
    const response = await this.request(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path.split('?')[0]} failed (${response.status}).`)
    const result = response.status === 204 ? undefined : await response.json()
    if (path === '/graphql' && (result as { errors?: unknown[] })?.errors?.length) {
      throw new Error('GitHub GraphQL mutation failed.')
    }
    return result as T
  }

  async pages<T>(path: string): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; ; page++) {
      const items = await this.call<T[]>(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      )
      all.push(...items)
      if (items.length < 100) return all
    }
  }

  issue(number: number): Promise<Issue> {
    return this.call(`/repos/${this.repo}/issues/${number}`)
  }
  comments(number: number): Promise<Comment[]> {
    return this.pages(`/repos/${this.repo}/issues/${number}/comments`)
  }
  async permission(actor: string): Promise<string> {
    const result = await this.call<{ permission: string }>(
      `/repos/${this.repo}/collaborators/${encodeURIComponent(actor)}/permission`,
    )
    return result.permission
  }
  async state(issue: number): Promise<StateRecord | null> {
    const comments = await this.comments(issue)
    // The first canonical record wins. Subsequent runs update it in place.
    for (const comment of comments.sort((a, b) => a.id - b.id)) {
      const state = parseState(comment, issue)
      if (state) return { commentId: comment.id, state }
    }
    return null
  }

  async save(state: QueueState, commentId?: number): Promise<StateRecord> {
    const body =
      `${STATE_MARKER}\n## Codex SDLC\n\n**${state.status}** · ${state.stage}\n\n${state.reason}\n\n` +
      `Workflow: [Actions](https://github.com/${this.repo}/actions/workflows/${WORKFLOW})\n\n` +
      `<details><summary>Workflow checkpoint metadata</summary>\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\n</details>`
    const comment = await this.call<Comment>(
      commentId
        ? `/repos/${this.repo}/issues/comments/${commentId}`
        : `/repos/${this.repo}/issues/${state.issue}/comments`,
      commentId ? 'PATCH' : 'POST',
      { body },
    )
    return { commentId: comment.id, state }
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.call(`/repos/${this.repo}/issues/${issue}/comments`, 'POST', {
      body: body.slice(0, 60_000),
    })
  }

  async track(issue: number): Promise<void> {
    const labels = await this.pages<{ name: string }>(`/repos/${this.repo}/labels`)
    if (!labels.some((label) => label.name === STATE_LABEL)) {
      try {
        await this.call(`/repos/${this.repo}/labels`, 'POST', {
          name: STATE_LABEL,
          color: '3567b8',
          description: 'Codex SDLC queue and checkpoint tracking',
        })
      } catch {
        // Concurrent first requests may both try to create the same label.
        if (
          !(await this.pages<{ name: string }>(`/repos/${this.repo}/labels`)).some(
            (l) => l.name === STATE_LABEL,
          )
        ) {
          throw new Error('Cannot create SDLC tracking label.')
        }
      }
    }
    await this.call(`/repos/${this.repo}/issues/${issue}/labels`, 'POST', { labels: [STATE_LABEL] })
  }

  tracked(): Promise<Issue[]> {
    return this.pages(`/repos/${this.repo}/issues?state=open&labels=${STATE_LABEL}`)
  }
  run(id: number): Promise<Run> {
    return this.call(`/repos/${this.repo}/actions/runs/${id}`)
  }

  async dispatch(issue: number, pipelineId: string, branch: string): Promise<void> {
    await this.call(`/repos/${this.repo}/actions/workflows/${WORKFLOW}/dispatches`, 'POST', {
      ref: branch,
      inputs: { issue_number: String(issue), operation: 'continue', pipeline_id: pipelineId },
    })
  }

  async validatePrHead(number: number, sha: string, base: string, branch: string): Promise<void> {
    const pr = await this.call<{
      state: string
      head: { sha: string; ref: string; repo: { full_name: string } }
      base: { ref: string }
    }>(`/repos/${this.repo}/pulls/${number}`)
    if (
      pr.state !== 'open' ||
      pr.head.sha !== sha ||
      pr.head.ref !== branch ||
      pr.head.repo.full_name !== this.repo ||
      pr.base.ref !== base
    ) {
      throw new Error('Published PR does not match the exact verified commit and branch.')
    }
  }

  async validateArtifact(
    ref: NonNullable<QueueState['checkpoint']>,
    defaultBranch: string,
  ): Promise<void> {
    const run = await this.run(ref.runId)
    // GitHub's run.name is the custom run-name, not the workflow identity.
    // Trust the workflow source path and default branch, then bind the artifact
    // to this run and its controller commit below.
    if (run.path !== `.github/workflows/${WORKFLOW}` || run.head_branch !== defaultBranch)
      throw new Error('Checkpoint workflow provenance mismatch.')
    const artifact = await this.call<{
      id: number
      name: string
      expired: boolean
      workflow_run: { id: number; head_sha: string }
    }>(`/repos/${this.repo}/actions/artifacts/${ref.artifactId}`)
    if (
      artifact.expired ||
      artifact.name !== ref.name ||
      artifact.workflow_run.id !== ref.runId ||
      artifact.workflow_run.head_sha !== ref.controllerSha
    )
      throw new Error('Checkpoint artifact provenance mismatch.')
  }

  async subIssue(
    parent: number,
    ticket: { id: string; title: string; body: string },
  ): Promise<number> {
    const marker = `<!-- codex-sdlc-ticket: ${parent}/${ticket.id} -->`
    const linked = await this.pages<Issue & { id: number }>(
      `/repos/${this.repo}/issues/${parent}/sub_issues`,
    )
    let issue = linked.find((i) => i.body?.includes(marker))
    if (!issue) {
      // Recover a POST that created an issue but failed before linking it.
      const all = await this.pages<Issue & { id: number }>(
        `/repos/${this.repo}/issues?state=all&creator=github-actions%5Bbot%5D`,
      )
      issue = all.find((i) => !i.pull_request && i.body?.includes(marker))
    }
    if (!issue)
      issue = await this.call<Issue & { id: number }>(`/repos/${this.repo}/issues`, 'POST', {
        title: ticket.title,
        body: `${ticket.body}\n\n${marker}`,
      })
    else if (issue.title !== ticket.title || issue.body !== `${ticket.body}\n\n${marker}`) {
      await this.call(`/repos/${this.repo}/issues/${issue.number}`, 'PATCH', {
        title: ticket.title,
        body: `${ticket.body}\n\n${marker}`,
      })
    }
    if (!linked.some((i) => i.number === issue!.number)) {
      await this.call(`/repos/${this.repo}/issues/${parent}/sub_issues`, 'POST', {
        sub_issue_id: issue.id,
      })
    }
    return issue.number
  }
}

export async function output(name: string, value: string): Promise<void> {
  if (!/^[a-z_]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid Actions output.')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
