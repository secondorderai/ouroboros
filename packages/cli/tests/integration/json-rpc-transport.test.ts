/**
 * JSON-RPC transport test.
 *
 * Spawns the CLI in `--json-rpc` mode as a real subprocess and exercises the
 * stdin/stdout NDJSON transport end-to-end. Catches regressions in parsing,
 * error framing, request/response correlation, and the line reader.
 *
 * Handler-level behavior is covered by `json-rpc.test.ts`; this file owns
 * *only* transport concerns.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSON_RPC_ERRORS } from '@src/json-rpc/types'

type PendingResponse = {
  resolve: (msg: Record<string, unknown>) => void
  reject: (err: Error) => void
}

class RpcClient {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>
  private buffer = ''
  private pending = new Map<number | string, PendingResponse>()
  private readerDone: Promise<void>
  /** All unsolicited messages (notifications, id=null errors) seen so far. */
  public unsolicited: Array<Record<string, unknown>> = []

  constructor(configDir: string) {
    const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli.ts')
    this.proc = spawn({
      cmd: ['bun', 'run', cliEntry, '--json-rpc', '--config', configDir],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, OUROBOROS_DISABLE_RSI: '1' },
    }) as Subprocess<'pipe', 'pipe', 'pipe'>

    this.readerDone = this.pumpStdout()
  }

  private writeLine(line: string): void {
    this.proc.stdin.write(line + '\n')
    this.proc.stdin.flush()
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      this.buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (line.length === 0) continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const id = parsed.id as number | string | null | undefined
        if (id != null && this.pending.has(id)) {
          this.pending.get(id)!.resolve(parsed)
          this.pending.delete(id)
        } else {
          this.unsolicited.push(parsed)
        }
      }
    }
  }

  async sendRaw(rawLine: string): Promise<void> {
    this.writeLine(rawLine)
  }

  sendRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Timed out waiting for response to id=${id} method=${method}`))
        }
      }, 15000)
    })
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end()
    } catch {
      // writer may already be closed
    }
    this.proc.kill()
    await this.readerDone.catch(() => {})
    await this.proc.exited
  }
}

describe('json-rpc transport', () => {
  let configDir: string
  let client: RpcClient

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'ouroboros-transport-'))
    // Write a minimal .ouroboros config so the CLI can boot without interaction.
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        model: { provider: 'anthropic', name: 'claude-3-5-sonnet-latest' },
      }),
    )
  })

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    if (client) await client.close()
    client = new RpcClient(configDir)
    // Smoke: wait for server to be ready by poking a cheap method.
    await waitForReady(client)
  })

  test('happy path: skills/list round-trips over NDJSON', async () => {
    const resp = await client.sendRequest(1, 'skills/list', {})
    expect(resp.jsonrpc).toBe('2.0')
    expect(resp.id).toBe(1)
    expect(resp.error).toBeUndefined()
    expect(resp.result).toBeDefined()
    const result = resp.result as { skills: unknown[] }
    expect(Array.isArray(result.skills)).toBe(true)
  })

  test('unknown method → METHOD_NOT_FOUND', async () => {
    const resp = await client.sendRequest(2, 'nonexistent/method', {})
    expect(resp.id).toBe(2)
    const error = resp.error as { code: number; message: string }
    expect(error).toBeDefined()
    expect(error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND.code)
  })

  test('malformed JSON → PARSE_ERROR with id=null', async () => {
    await client.sendRaw('{ not valid json')
    await sleep(200)
    const parseError = client.unsolicited.find((m) => {
      const err = m.error as { code?: number } | undefined
      return err?.code === JSON_RPC_ERRORS.PARSE_ERROR.code
    })
    expect(parseError).toBeDefined()
    expect(parseError!.id).toBeNull()
  })

  test('invalid request shape → INVALID_REQUEST with id=null', async () => {
    // Valid JSON but not a valid JSON-RPC request (missing `method`).
    await client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 99 }))
    await sleep(200)
    const invalid = client.unsolicited.find((m) => {
      const err = m.error as { code?: number } | undefined
      return err?.code === JSON_RPC_ERRORS.INVALID_REQUEST.code
    })
    expect(invalid).toBeDefined()
  })

  test('concurrent requests with distinct ids are correlated correctly', async () => {
    const [a, b, c] = await Promise.all([
      client.sendRequest('a', 'skills/list', {}),
      client.sendRequest('b', 'config/get', {}),
      client.sendRequest('c', 'skills/list', {}),
    ])
    expect(a.id).toBe('a')
    expect(b.id).toBe('b')
    expect(c.id).toBe('c')
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
    expect(c.error).toBeUndefined()
  })

  afterAll(async () => {
    if (client) await client.close()
  })
})

async function waitForReady(client: RpcClient, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await Promise.race([
        client.sendRequest(`ready-${i}`, 'skills/list', {}),
        sleep(500).then(() => null),
      ])
      if (resp && (resp as Record<string, unknown>).result !== undefined) return
    } catch {
      // keep polling
    }
    await sleep(100)
  }
  throw new Error('CLI did not become ready')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
