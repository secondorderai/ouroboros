import { join } from 'node:path'
import { childEnvironment, command } from './process'
import type { ArtifactStore } from './storage'

export function artifactEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    'GITHUB_SERVER_URL',
    'GITHUB_WORKSPACE',
    'GITHUB_RETENTION_DAYS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]
  return {
    ...childEnvironment(source),
    ...Object.fromEntries(
      keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
    ),
    ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000',
  }
}

export class NodeArtifactStore implements ArtifactStore {
  constructor(
    private readonly run = command,
    private readonly timeoutMs = 180_000,
  ) {}

  private async transfer(
    operation: 'upload' | 'download',
    args: unknown[],
  ): Promise<{ id?: number }> {
    const started = Date.now()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.timeoutMs)
    console.log(`Checkpoint ${operation} started (${this.timeoutMs / 1000}s deadline).`)
    try {
      const result = await this.run(
        [process.env.CODEX_SDLC_NODE || 'node', join(import.meta.dir, 'artifact-worker.mjs')],
        {
          cwd: import.meta.dir,
          env: artifactEnvironment(),
          input: JSON.stringify({ operation, args }),
          signal: abort.signal,
          onLine(line) {
            if (/^Uploaded bytes \d+$/.test(line)) console.log(`Checkpoint ${line.toLowerCase()}.`)
          },
        },
      )
      if (abort.signal.aborted) throw new Error(`Checkpoint ${operation} exceeded its time limit.`)
      const messages = result.stdout.split('\n').flatMap((line) => {
        try {
          const message = JSON.parse(line)
          return message !== null && typeof message === 'object' ? [message] : []
        } catch {
          return []
        }
      })
      if (result.code !== 0) {
        const stalled = messages.some(
          (message) => message.type === 'artifact-error' && message.reason === 'stalled',
        )
        throw new Error(
          `Checkpoint ${operation} ${stalled ? 'stalled for 60 seconds' : 'failed'}; the last finalized checkpoint is unchanged.`,
        )
      }
      const report = messages.findLast((message) => message.type === 'artifact-result')
      if (
        !report ||
        (operation === 'upload' && (!Number.isSafeInteger(report.id) || report.id < 1))
      )
        throw new Error(`Checkpoint ${operation} returned no valid completion report.`)
      console.log(
        `Checkpoint ${operation} completed in ${Math.ceil((Date.now() - started) / 1000)}s.`,
      )
      return operation === 'upload' ? { id: report.id } : {}
    } finally {
      clearTimeout(timer)
    }
  }

  uploadArtifact(...args: Parameters<ArtifactStore['uploadArtifact']>): Promise<{ id?: number }> {
    return this.transfer('upload', args)
  }

  downloadArtifact(...args: Parameters<ArtifactStore['downloadArtifact']>): Promise<unknown> {
    // The download token is passed on stdin, never in arguments or agent environments.
    return this.transfer('download', args)
  }
}
