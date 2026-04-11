import { describe, expect, test } from 'bun:test'
import type { CLIProcessManager } from '../src/main/cli-process'
import { RpcClient, RpcTimeoutError } from '../src/main/rpc-client'

class FakeCliProcess {
  public readonly writes: string[] = []

  writeLine(line: string): void {
    this.writes.push(line)
  }
}

function getLastRequestId(fakeCli: FakeCliProcess): number {
  const request = JSON.parse(fakeCli.writes.at(-1) ?? '{}') as { id?: number }
  if (typeof request.id !== 'number') {
    throw new Error('Expected RPC request with numeric id')
  }
  return request.id
}

describe('RpcClient', () => {
  test('does not apply the default timeout to agent/run requests', async () => {
    const client = new RpcClient()
    const fakeCli = new FakeCliProcess()
    client.attach(fakeCli as unknown as CLIProcessManager)

    const runPromise = client.send('agent/run', { message: 'Hello from desktop' })
    const requestId = getLastRequestId(fakeCli)

    await Bun.sleep(40)
    expect(client.pendingCount).toBe(1)

    client.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          text: 'Completed after a delayed response',
          iterations: 1,
          maxIterationsReached: false,
        },
      }),
    )

    await expect(runPromise).resolves.toEqual({
      text: 'Completed after a delayed response',
      iterations: 1,
      maxIterationsReached: false,
    })
    expect(client.pendingCount).toBe(0)
  })

  test('still times out ordinary RPC requests when an explicit timeout is provided', async () => {
    const client = new RpcClient()
    const fakeCli = new FakeCliProcess()
    client.attach(fakeCli as unknown as CLIProcessManager)

    const request = client.send('config/get', {}, 10)

    await expect(request).rejects.toBeInstanceOf(RpcTimeoutError)
    expect(client.pendingCount).toBe(0)
  })
})
