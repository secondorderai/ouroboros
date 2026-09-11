import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NodeArtifactStore } from './artifact-client'
import { GitHub } from './github'
import { hash, Snapshot, type QueueState } from './model'
import { childEnvironment, command } from './process'

export function stateKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32)
    throw new Error('CODEX_SDLC_STATE_KEY must be a base64-encoded 32-byte key.')
  return key
}
export function encrypt(data: Buffer, key: Buffer, context: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context))
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([Buffer.from('CSD1'), iv, cipher.getAuthTag(), ciphertext])
}
export function decrypt(data: Buffer, key: Buffer, context: string): Buffer {
  if (data.subarray(0, 4).toString() !== 'CSD1' || data.length < 32)
    throw new Error('Invalid checkpoint envelope.')
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16))
  cipher.setAAD(Buffer.from(context))
  cipher.setAuthTag(data.subarray(16, 32))
  return Buffer.concat([cipher.update(data.subarray(32)), cipher.final()])
}

export function sessionEntry(name: string): boolean {
  return (
    ['sessions', 'archived_sessions', 'session_index.jsonl'].includes(name) ||
    /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(name)
  )
}

export function validateAuth(value: string): void {
  let auth: { auth_mode?: string; tokens?: { refresh_token?: string; access_token?: string } }
  try {
    auth = JSON.parse(value)
  } catch {
    throw new Error('CODEX_AUTH_JSON must contain JSON.')
  }
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.refresh_token || !auth.tokens.access_token) {
    throw new Error('CODEX_AUTH_JSON must be managed ChatGPT auth with access and refresh tokens.')
  }
}

export async function writeBackAuth(
  home: string,
  repo: string,
  token: string,
  run = command,
): Promise<void> {
  const value = await readFile(join(home, 'auth.json'), 'utf8')
  validateAuth(value)
  // gh encrypts stdin with the environment public key; no credential is put in
  // an argument, artifact, GITHUB_OUTPUT, or model subprocess environment.
  const result = await run(
    [
      'bash',
      '-c',
      'gh secret set CODEX_AUTH_JSON --env codex-sdlc --repo "$SDLC_REPO" < "$SDLC_AUTH_FILE"',
    ],
    {
      cwd: home,
      env: {
        ...childEnvironment(),
        GH_TOKEN: token,
        SDLC_REPO: repo,
        SDLC_AUTH_FILE: join(home, 'auth.json'),
      },
    },
  )
  if (result.code !== 0)
    throw new Error(
      'Cannot persist refreshed subscription credentials; automatic continuation stopped.',
    )
}

export interface ArtifactStore {
  uploadArtifact(
    name: string,
    files: string[],
    root: string,
    options: { retentionDays: number },
  ): Promise<{ id?: number }>
  downloadArtifact(
    id: number,
    options: {
      path: string
      findBy: {
        token: string
        workflowRunId: number
        repositoryOwner: string
        repositoryName: string
      }
    },
  ): Promise<unknown>
}

export class Storage {
  constructor(
    readonly directory: string,
    private readonly key: Buffer,
    private readonly github: GitHub,
    private readonly token: string,
    private readonly artifacts: ArtifactStore = new NodeArtifactStore(),
  ) {}

  context(issue: number, pipelineId: string): string {
    return `${this.github.repo}/${issue}/${pipelineId}/v1`
  }

  async save(
    snapshot: Snapshot,
    home: string,
    records: string,
    bundle: string,
    runId: number,
    controllerSha: string,
  ): Promise<NonNullable<QueueState['checkpoint']>> {
    const stage = join(this.directory, 'pack')
    await rm(stage, { recursive: true, force: true })
    await mkdir(join(stage, 'sessions'), { recursive: true })
    await writeFile(join(stage, 'snapshot.json'), JSON.stringify(snapshot))
    if (await Bun.file(bundle).exists()) await cp(bundle, join(stage, 'git.bundle'))
    for (const entry of await readdir(home)) {
      if (sessionEntry(entry))
        await cp(join(home, entry), join(stage, 'sessions', entry), { recursive: true })
    }
    await cp(records, join(stage, 'records'), { recursive: true })
    const archive = join(this.directory, 'checkpoint.tar.gz')
    const result = await command(['tar', '-czf', archive, '-C', stage, '.'], {
      cwd: this.directory,
    })
    if (result.code !== 0) throw new Error('Cannot package checkpoint.')
    const encrypted = encrypt(
      await readFile(archive),
      this.key,
      this.context(snapshot.issue, snapshot.pipelineId),
    )
    const file = join(this.directory, 'checkpoint.enc')
    await writeFile(file, encrypted)
    console.log(`Encrypted checkpoint revision ${snapshot.revision}: ${encrypted.length} bytes.`)
    const name = `codex-sdlc-${snapshot.issue}-${snapshot.pipelineId}-${runId}-${snapshot.revision}-${Date.now()}`
    const upload = await this.artifacts.uploadArtifact(name, [file], this.directory, {
      retentionDays: 14,
    })
    if (!upload.id) throw new Error('Checkpoint upload returned no artifact ID.')
    return { artifactId: upload.id, runId, name, digest: hash(encrypted), controllerSha }
  }

  async restore(
    queue: QueueState,
    home: string,
    records: string,
    defaultBranch: string,
  ): Promise<{ snapshot: Snapshot; bundle: string }> {
    if (!queue.checkpoint) throw new Error('No checkpoint to restore.')
    await this.github.validateArtifact(queue.checkpoint, defaultBranch)
    const download = join(this.directory, 'download')
    await mkdir(download, { recursive: true })
    const [repositoryOwner, repositoryName] = this.github.repo.split('/')
    await this.artifacts.downloadArtifact(queue.checkpoint.artifactId, {
      path: download,
      findBy: {
        token: this.token,
        workflowRunId: queue.checkpoint.runId,
        repositoryOwner: repositoryOwner!,
        repositoryName: repositoryName!,
      },
    })
    const encrypted = await readFile(join(download, 'checkpoint.enc'))
    if (hash(encrypted) !== queue.checkpoint.digest) throw new Error('Checkpoint digest mismatch.')
    const tar = decrypt(encrypted, this.key, this.context(queue.issue, queue.pipelineId))
    const archive = join(this.directory, 'restore.tar.gz')
    await writeFile(archive, tar)
    const listing = await command(['tar', '-tzf', archive], { cwd: this.directory })
    if (
      listing.code !== 0 ||
      listing.stdout
        .split('\n')
        .filter(Boolean)
        .some((path) => path.startsWith('/') || path.split('/').includes('..'))
    )
      throw new Error('Invalid checkpoint paths.')
    const unpack = join(this.directory, 'unpack')
    await mkdir(unpack, { recursive: true })
    const extraction = await command(['tar', '-xzf', archive, '-C', unpack], {
      cwd: this.directory,
    })
    if (extraction.code !== 0) throw new Error('Cannot extract checkpoint.')
    const snapshot = Snapshot.parse(
      JSON.parse(await readFile(join(unpack, 'snapshot.json'), 'utf8')),
    )
    if (snapshot.issue !== queue.issue || snapshot.pipelineId !== queue.pipelineId)
      throw new Error('Checkpoint identity mismatch.')
    // Do not restore auth/config/plugins/hooks from an execution checkpoint.
    for (const name of await readdir(join(unpack, 'sessions'))) {
      if (sessionEntry(name))
        await cp(join(unpack, 'sessions', name), join(home, name), { recursive: true })
    }
    await cp(join(unpack, 'records'), records, { recursive: true })
    return { snapshot, bundle: resolve(unpack, 'git.bundle') }
  }
}
