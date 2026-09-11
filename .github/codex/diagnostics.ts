import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const patterns: Record<string, RegExp> = {
    unavailable_model:
      /model_not_found|model[^\n]*(?:not found|not available|not supported|does not exist)|(?:unknown|invalid|unsupported)[^\n]*model/i,
    unsupported_reasoning:
      /(?:reasoning|xhigh)[^\n]*(?:not supported|unsupported|invalid)|unsupported[^\n]*(?:reasoning|xhigh)/i,
    invalid_schema: /invalid_json_schema|invalid schema|response_format|text\.format\.schema/i,
    schema_required_fields:
      /additionalProperties|required.*(?:supplied|false|property)|minLength|anyOf/i,
    authentication: /refresh_token|unauthorized|authentication|\b401\b/i,
    subscription_allowance:
      /usage_limit_reached|usage limit|rate_limit_exceeded|rate limit|\b429\b/i,
    forbidden: /\b403\b|forbidden|access denied/i,
    configuration:
      /error loading config|failed to (?:load|parse).*config|invalid (?:value|type).*config/i,
    cli_arguments: /unexpected argument|unrecognized option|required arguments|invalid value/i,
    sandbox: /sandbox|bwrap|bubblewrap|landlock|operation not permitted|permission denied/i,
    network:
      /failed to connect|connection (?:refused|reset|closed)|dns|certificate|tls|websocket|stream disconnected/i,
    http_bad_request: /\b400\b|bad request/i,
    server_failure: /\b50[0234]\b|internal server error|service unavailable/i,
    context_limit: /context_length_exceeded|context (?:length|window)|too many tokens/i,
    missing_session: /session[^\n]*(?:not found|does not exist)|no session found/i,
  }
  return {
    events: [...events],
    signals: Object.entries(patterns)
      .filter(([, pattern]) => pattern.test(diagnostic))
      .map(([key]) => key),
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
