import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { LaunchedApp } from './helpers'
import { launchTestApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

interface RpcEnvelope {
  ok: boolean
  result?: unknown
  error?: { name: string; message: string }
}

async function callRpc(launchedApp: LaunchedApp, method: string, params?: unknown): Promise<RpcEnvelope> {
  return launchedApp.page.evaluate(
    async ({ currentMethod, currentParams }) => {
      try {
        // Re-implement preload's envelope shape so we can observe PolicyError
        // rejections without going through the typed `rpc()` wrapper that
        // throws on failure.
        const ipcResponse = await (
          window as typeof window & {
            ouroboros: { rpc: (method: string, params?: unknown) => Promise<unknown> }
          }
        ).ouroboros.rpc(currentMethod as never, currentParams as never)
        return { ok: true as const, result: ipcResponse }
      } catch (error) {
        const err = error as { name?: string; message?: string }
        return { ok: false as const, error: { name: err.name ?? 'Error', message: err.message ?? '' } }
      }
    },
    { currentMethod: method, currentParams: params },
  )
}

test('synthetic renderer call to an unknown RPC method is denied with PolicyError', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)

  const response = await callRpc(launched, 'evil/method', { foo: 'bar' })

  expect(response.ok).toBe(false)
  if (!response.ok) {
    expect(response.error.message.startsWith('PolicyError:')).toBe(true)
    expect(response.error.message).toContain('unknown method')
  }

  // The mock CLI must not have seen the unknown method.
  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).not.toContain('"method":"evil/method"')
})

test('synthetic renderer call to a sensitive method without confirmation is denied', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    policyResponses: [false],
  })

  const response = await callRpc(launched, 'workspace/set', { dir: '/tmp/attacker' })

  expect(response.ok).toBe(false)
  if (!response.ok) {
    expect(response.error.message.startsWith('PolicyError:')).toBe(true)
    expect(response.error.message).toContain('user cancelled')
  }

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).not.toContain('"method":"workspace/set"')
})

test('synthetic renderer call to a sensitive method with confirmation is forwarded', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    policyResponses: [true],
  })

  const response = await callRpc(launched, 'workspace/set', { dir: '/tmp/legitimate' })

  expect(response.ok).toBe(true)

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"method":"workspace/set"')
})

test('synthetic renderer call to a high-risk approval/respond is denied without confirmation', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      startupNotifications: [
        {
          method: 'approval/request',
          params: {
            id: 'approval-x',
            type: 'permission-lease',
            description: 'allow bash everywhere',
            risk: 'high',
          },
        },
      ],
    },
    policyResponses: [false],
  })

  // Round-trip a benign RPC call to flush any pending stdout lines
  // through the rpc-client. The startup notification is written to
  // stdout before the response to this request, so by the time the
  // request resolves the gate has already cached `approval-x`'s risk.
  await launched.page.evaluate(() => window.ouroboros.rpc('config/get', {}))

  const response = await callRpc(launched, 'approval/respond', {
    id: 'approval-x',
    approved: true,
  })

  expect(response.ok).toBe(false)
  if (!response.ok) {
    expect(response.error.message.startsWith('PolicyError:')).toBe(true)
    expect(response.error.message).toContain('high-risk approval')
  }

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).not.toContain('"method":"approval/respond"')
})

test('read-class methods (config/get) pass through without confirmation', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)

  const response = await callRpc(launched, 'config/get', {})
  expect(response.ok).toBe(true)
})
