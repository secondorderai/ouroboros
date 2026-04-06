/**
 * JSON-RPC Transport Layer
 *
 * Reads newline-delimited JSON from stdin and writes NDJSON to stdout.
 * Each line is one JSON-RPC message (request, response, or notification).
 */

import type { JsonRpcResponse, JsonRpcNotification } from './types'

// ── Writer ──────────────────────────────────────────────────────────

/**
 * Write a JSON-RPC response or notification to stdout as a single NDJSON line.
 */
export function writeMessage(message: JsonRpcResponse | JsonRpcNotification): void {
  const line = JSON.stringify(message)
  process.stdout.write(line + '\n')
}

/**
 * Write a debug message to stderr (not part of the JSON-RPC protocol).
 */
export function debugLog(message: string): void {
  process.stderr.write(`[json-rpc] ${message}\n`)
}

// ── Reader ──────────────────────────────────────────────────────────

export type LineHandler = (line: string) => void

/**
 * Start reading newline-delimited lines from stdin.
 * Calls `onLine` for each complete line received.
 * Keeps the process alive indefinitely.
 *
 * Returns a cleanup function to stop reading.
 */
export function startLineReader(onLine: LineHandler): () => void {
  let buffer = ''

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf-8')

    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (line.length > 0) {
        onLine(line)
      }
    }
  }

  const onEnd = (): void => {
    // stdin closed — shut down gracefully
    process.exit(0)
  }

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', onData)
  process.stdin.on('end', onEnd)
  process.stdin.resume()

  return () => {
    process.stdin.off('data', onData)
    process.stdin.off('end', onEnd)
  }
}
