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
        model: { provider: 'anthropic', name: 'claude-sonnet-4-20250514' },
        permissions: { tier0: true, tier1: true, tier2: true, tier3: true, tier4: false },
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

  test('agent/run emits subagent started and completed notifications over NDJSON', async () => {
    await client.close()

    const mockServer = createMockOpenAICompatibleServer([
      [
        {
          toolCallId: 'spawn_1',
          toolName: 'spawn_agent',
          args: {
            agentId: 'review',
            task: 'Review delegated context.',
            outputFormat: 'summary',
          },
        },
      ],
      [{ text: validSubagentResultText() }],
      [{ text: 'Parent received the subagent result.' }],
    ])
    const subagentConfigDir = mkdtempSync(join(tmpdir(), 'ouroboros-transport-subagent-'))
    mkdirSync(subagentConfigDir, { recursive: true })
    writeFileSync(
      join(subagentConfigDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-compatible',
          name: 'mock-chat',
          baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
          apiMode: 'chat',
          apiKey: 'test-key',
        },
        permissions: {
          tier0: true,
          tier1: true,
          tier2: true,
          tier3: true,
          tier4: false,
        },
        agent: {
          definitions: [
            {
              id: 'explore',
              description: 'Read-only explorer',
              mode: 'primary',
              prompt: 'Explore and delegate read-only review.',
              permissions: {
                tier0: true,
                tier1: false,
                tier2: false,
                tier3: true,
                tier4: false,
                canInvokeAgents: ['review'],
              },
            },
          ],
        },
      }),
    )

    const subagentClient = new RpcClient(subagentConfigDir)
    try {
      await waitForReady(subagentClient)
      const resp = await subagentClient.sendRequest(10, 'agent/run', {
        message: 'Spawn a reviewer.',
        maxSteps: 3,
      })
      expect(resp.error).toBeUndefined()

      const started = subagentClient.unsolicited.find(
        (message) => message.method === 'agent/subagentStarted',
      )
      const completed = subagentClient.unsolicited.find(
        (message) => message.method === 'agent/subagentCompleted',
      )

      expect(started).toBeDefined()
      expect(completed).toBeDefined()
      expect((started?.params as Record<string, unknown>).agentId).toBe('review')
      expect((completed?.params as Record<string, unknown>).agentId).toBe('review')
      expect((completed?.params as Record<string, unknown>).runId).toBe(
        (started?.params as Record<string, unknown>).runId,
      )
    } finally {
      await subagentClient.close()
      mockServer.stop()
      rmSync(subagentConfigDir, { recursive: true, force: true })
      client = new RpcClient(configDir)
      await waitForReady(client)
    }
  })

  test('agent/run emits subagent failed notification over NDJSON', async () => {
    await client.close()

    const mockServer = createMockOpenAICompatibleServer([
      [
        {
          toolCallId: 'spawn_1',
          toolName: 'spawn_agent',
          args: {
            agentId: 'review',
            task: 'Fail delegated review.',
            outputFormat: 'summary',
          },
        },
      ],
      [{ errorStatus: 401, errorMessage: 'Authentication failed for child model' }],
      [{ text: 'Parent handled the subagent failure.' }],
    ])
    const subagentConfigDir = mkdtempSync(join(tmpdir(), 'ouroboros-transport-subagent-fail-'))
    mkdirSync(subagentConfigDir, { recursive: true })
    writeFileSync(
      join(subagentConfigDir, '.ouroboros'),
      JSON.stringify({
        model: {
          provider: 'openai-compatible',
          name: 'mock-chat',
          baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
          apiMode: 'chat',
          apiKey: 'test-key',
        },
        permissions: {
          tier0: true,
          tier1: true,
          tier2: true,
          tier3: true,
          tier4: false,
        },
        agent: {
          definitions: [
            {
              id: 'explore',
              description: 'Read-only explorer',
              mode: 'primary',
              prompt: 'Explore and delegate read-only review.',
              permissions: {
                tier0: true,
                tier1: false,
                tier2: false,
                tier3: true,
                tier4: false,
                canInvokeAgents: ['review'],
              },
            },
          ],
        },
      }),
    )

    const subagentClient = new RpcClient(subagentConfigDir)
    try {
      await waitForReady(subagentClient)
      const resp = await subagentClient.sendRequest(11, 'agent/run', {
        message: 'Spawn a failing reviewer.',
        maxSteps: 3,
      })
      expect(resp.error).toBeUndefined()

      const failed = subagentClient.unsolicited.find(
        (message) => message.method === 'agent/subagentFailed',
      )

      expect(failed).toBeDefined()
      expect(failed?.params).toMatchObject({
        agentId: 'review',
        task: 'Fail delegated review.',
        status: 'failed',
        error: {
          message: 'Child agent stopped with reason: error',
        },
      })
    } finally {
      await subagentClient.close()
      mockServer.stop()
      rmSync(subagentConfigDir, { recursive: true, force: true })
      client = new RpcClient(configDir)
      await waitForReady(client)
    }
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

type MockChatTurn =
  | { text: string }
  | { toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { errorStatus: number; errorMessage: string }

function createMockOpenAICompatibleServer(turns: MockChatTurn[][]): {
  port: number
  stop: () => void
} {
  let requestCount = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      const turn = turns[requestCount++] ?? [{ text: '[No scripted turn]' }]
      const error = turn.find(
        (part): part is Extract<MockChatTurn, { errorStatus: number }> => 'errorStatus' in part,
      )
      if (error) {
        return Response.json(
          { error: { message: error.errorMessage, type: 'mock_error' } },
          { status: error.errorStatus },
        )
      }

      return new Response(toOpenAIChatSse(turn), {
        headers: {
          'content-type': 'text/event-stream',
        },
      })
    },
  })

  return {
    port: server.port ?? 0,
    stop: () => server.stop(true),
  }
}

function toOpenAIChatSse(turn: MockChatTurn[]): string {
  const lines: string[] = []
  for (const part of turn) {
    if ('text' in part) {
      lines.push(
        `data: ${JSON.stringify({
          id: crypto.randomUUID(),
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock-chat',
          choices: [
            { index: 0, delta: { role: 'assistant', content: part.text }, finish_reason: null },
          ],
        })}`,
      )
      lines.push(
        `data: ${JSON.stringify({
          id: crypto.randomUUID(),
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}`,
      )
      continue
    }

    if ('toolCallId' in part) {
      lines.push(
        `data: ${JSON.stringify({
          id: crypto.randomUUID(),
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock-chat',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: part.toolCallId,
                    type: 'function',
                    function: {
                      name: part.toolName,
                      arguments: JSON.stringify(part.args),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}`,
      )
      lines.push(
        `data: ${JSON.stringify({
          id: crypto.randomUUID(),
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock-chat',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}`,
      )
    }
  }
  lines.push('data: [DONE]')
  return `${lines.join('\n\n')}\n\n`
}

function validSubagentResultText(): string {
  return JSON.stringify({
    summary: 'Child summary.',
    claims: [
      {
        claim: 'The child reviewed delegated context.',
        evidence: [{ type: 'output', excerpt: 'Reviewed.' }],
        confidence: 0.8,
      },
    ],
    uncertainty: [],
    suggestedNextSteps: ['Continue.'],
  })
}
