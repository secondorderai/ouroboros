import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { command, childEnvironment } from './process'

export class Git {
  constructor(
    readonly cwd: string,
    readonly repo: string,
    private readonly token: string,
  ) {}
  async run(args: string[], cwd = this.cwd, allowFailure = false): Promise<string> {
    const result = await command(['git', ...args], {
      cwd,
      env: {
        ...childEnvironment(),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`,
      },
    })
    if (result.code !== 0 && !allowFailure)
      throw new Error(`git ${args[0]} failed; no force-push was attempted.`)
    return result.stdout.trim()
  }
  async initialize(defaultBranch: string): Promise<void> {
    await mkdir(this.cwd, { recursive: true })
    await this.run(['clone', '--branch', defaultBranch, `https://github.com/${this.repo}.git`, '.'])
    await this.run(['config', 'user.name', 'github-actions[bot]'])
    await this.run([
      'config',
      'user.email',
      '41898282+github-actions[bot]@users.noreply.github.com',
    ])
  }
  async checkout(branch: string, defaultBranch: string, required = false): Promise<void> {
    const remote = await this.run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
    if (remote) {
      await this.run(['fetch', 'origin', branch])
      await this.run(['checkout', '-B', branch, `origin/${branch}`])
    } else {
      if (required) throw new Error('Review-only requires an existing SDLC branch.')
      await this.run(['checkout', '-b', branch, `origin/${defaultBranch}`])
    }
  }
  async sync(defaultBranch: string): Promise<void> {
    await this.merge(`origin/${defaultBranch}`)
  }
  async merge(branch: string): Promise<void> {
    const result = await command(['git', 'merge', '--no-edit', branch], {
      cwd: this.cwd,
      env: childEnvironment(),
    })
    if (result.code !== 0) {
      await this.run(['merge', '--abort'], this.cwd, true)
      throw new Error(
        `Merge conflict integrating ${branch}; work is preserved for maintainer resolution.`,
      )
    }
  }
  head(cwd = this.cwd): Promise<string> {
    return this.run(['rev-parse', 'HEAD'], cwd)
  }
  async commit(message: string, cwd = this.cwd): Promise<void> {
    if (!(await this.run(['status', '--porcelain'], cwd))) return
    await this.run(['add', '--all'], cwd)
    const staged = await this.run(['diff', '--cached', '--name-only'], cwd)
    if (staged) await this.run(['commit', '-m', message], cwd)
  }
  async push(branch: string): Promise<void> {
    await this.run(['push', 'origin', `HEAD:refs/heads/${branch}`])
  }
  async worktree(root: string, name: string, branch: string, resume: boolean): Promise<string> {
    const path = join(root, name)
    if (
      resume &&
      (await this.run(['show-ref', '--verify', `refs/heads/${branch}`], this.cwd, true))
    ) {
      await this.run(['worktree', 'add', path, branch])
    } else {
      await this.run(['worktree', 'add', '-B', branch, path, 'HEAD'])
    }
    return path
  }
  async removeWorktree(path: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', path])
  }
  async bundle(path: string, branches: string[], base: string): Promise<void> {
    const refs = [...new Set(branches)]
    const commits = await this.run(['rev-list', ...refs, `^${base}`])
    if (!commits) return
    await this.run(['bundle', 'create', path, ...refs, `^${base}`])
  }
  async restoreBundle(path: string, branches: string[]): Promise<void> {
    if (!(await Bun.file(path).exists())) return
    await this.run(['bundle', 'verify', path])
    for (const branch of branches) {
      // Restore only checkpoint-owned refs, never refs supplied by an artifact.
      await this.run(['fetch', path, `refs/heads/${branch}:refs/heads/${branch}`])
    }
  }
}
