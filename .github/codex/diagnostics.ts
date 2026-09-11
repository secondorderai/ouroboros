import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureSignals } from './failure-signals'
import type { GitHub } from './github'
import { Storage, stateKey } from './storage'

// Public Actions logs may only contain these fixed diagnostic labels, never
// arbitrary model/server messages, prompts, token values or session transcripts.
export function safeDiagnostics(
  stdout: string,
  stderr: string,
): {
  events: string[]
  signals: string[]
} {
  const events = new Set<string>()
  const errors: string[] = []
  const allowedEvents = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error']
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (allowedEvents.includes(event.type)) events.add(event.type)
      if (event.type === 'error' || event.type === 'turn.failed') errors.push(JSON.stringify(event))
    } catch {
      /* ignore tool output and non-JSON text */
    }
  }
  const diagnostic = [...errors, stderr].join('\n')

  return {
    events: [...events],
    signals: failureSignals(diagnostic),
  }
}

export async function diagnoseCheckpoint(
  github: GitHub,
  issue: number,
  token: string,
  key: string,
  branch: string,
): Promise<void> {
  const record = await github.state(issue)
  if (!record?.state.checkpoint) throw new Error('The issue has no saved checkpoint to diagnose.')
  const directory = await mkdtemp(join(tmpdir(), 'codex-sdlc-diagnostic-'))
  try {
    const home = join(directory, 'sessions')
    const records = join(directory, 'records')
    const storageDirectory = join(directory, 'storage')
    for (const path of [home, records, storageDirectory]) await mkdir(path)
    const storage = new Storage(storageDirectory, stateKey(key), github, token)
    const { snapshot } = await storage.restore(record.state, home, records, branch)
    console.log(`Checkpoint stage: ${snapshot.stage}; revision: ${snapshot.revision}`)
    for (const entry of await readdir(records)) {
      if (!/^stage-\d+-(?:plan|tickets|implement|audit|review|fix)$/.test(entry)) continue
      const read = async (name: string) => {
        try {
          return await readFile(join(records, entry, name), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        }
      }
      console.log(
        `${entry}: ${JSON.stringify(safeDiagnostics(await read('execution.jsonl'), await read('stderr.txt')))}`,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
