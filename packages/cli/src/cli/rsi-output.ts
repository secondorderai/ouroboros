import type { RSIEvent } from '@src/rsi/types'

interface OutputStream {
  write(chunk: string): boolean
}

interface RSIOutputStreams {
  stdout: OutputStream
  stderr: OutputStream
}

const defaultStreams: RSIOutputStreams = {
  stdout: process.stdout,
  stderr: process.stderr,
}

export function writeRSIEvent(event: RSIEvent, streams: RSIOutputStreams = defaultStreams): void {
  switch (event.type) {
    case 'rsi-reflection':
      streams.stdout.write(
        `[RSI] Reflecting on task... novelty: ${event.reflection.novelty.toFixed(2)}, generalizability: ${event.reflection.generalizability.toFixed(2)}\n`,
      )
      break

    case 'rsi-crystallization':
      if (event.result.outcome === 'promoted') {
        const skillName = event.result.skillName ?? 'unknown'
        streams.stdout.write(`[RSI] Skill crystallized and promoted: ${skillName}\n`)
      } else if (event.result.outcome === 'no-crystallization') {
        streams.stdout.write('[RSI] Reflection complete — no crystallization needed.\n')
      } else {
        streams.stdout.write(`[RSI] Crystallization ${event.result.outcome}\n`)
      }
      break

    case 'rsi-dream':
      streams.stdout.write(
        `[RSI] Dream: ${event.result.topicsMerged} merged, ${event.result.topicsCreated} created, ${event.result.topicsPruned} pruned\n`,
      )
      break

    case 'rsi-error':
      streams.stderr.write(`[RSI] Error in ${event.stage}: ${event.error.message}\n`)
      break
  }
}

export function createRSIEventHandler(
  enabled: boolean,
  streams?: RSIOutputStreams,
): (event: RSIEvent) => void {
  if (!enabled) {
    return () => {}
  }

  return (event: RSIEvent) => {
    writeRSIEvent(event, streams)
  }
}
