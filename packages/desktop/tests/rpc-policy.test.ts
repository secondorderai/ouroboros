import { describe, expect, test, beforeEach } from 'bun:test'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { RpcPolicyGate, type ShowConfirmation } from '../src/main/rpc-policy'
import type { RpcClient } from '../src/main/rpc-client'
import type { ApprovalRequestNotification } from '../src/shared/protocol'
import type { ImageGrantStore } from '../src/main/image-grant-store'

class FakeImageGrants implements Pick<ImageGrantStore, 'has' | 'forget'> {
  private readonly grants = new WeakMap<BrowserWindow, Set<string>>()

  preGrant(window: BrowserWindow, paths: string[]): void {
    let set = this.grants.get(window)
    if (!set) {
      set = new Set()
      this.grants.set(window, set)
    }
    for (const path of paths) set.add(path)
  }

  has(window: BrowserWindow | null, path: string): boolean {
    if (!window) return false
    return this.grants.get(window)?.has(path) ?? false
  }

  forget(window: BrowserWindow): void {
    this.grants.delete(window)
  }
}

interface RecordedConfirmation {
  message: string
  detail: string | undefined
}

class FakeWindow {
  public destroyed = false
  public readonly webContents: { id: number }

  constructor(webContentsId = 1) {
    this.webContents = { id: webContentsId }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

interface FakeFrame {
  parent: FakeFrame | null
}

function makeEvent(opts: {
  parent?: FakeFrame | null
  webContentsId?: number
}): IpcMainInvokeEvent {
  const top: FakeFrame = { parent: null }
  const senderFrame =
    opts.parent === undefined ? top : ({ parent: opts.parent } as FakeFrame)
  return {
    senderFrame,
    sender: { id: opts.webContentsId ?? 1 },
  } as unknown as IpcMainInvokeEvent
}

function makeFakeRpcClient(): {
  client: RpcClient
  emitApprovalRequest: (params: ApprovalRequestNotification) => void
} {
  const listeners = new Set<(params: unknown) => void>()
  const client = {
    onNotification: (_method: string, callback: (params: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  } as unknown as RpcClient
  return {
    client,
    emitApprovalRequest: (params) => {
      for (const listener of listeners) listener(params)
    },
  }
}

interface GateHarness {
  gate: RpcPolicyGate
  window: FakeWindow
  imageGrants: FakeImageGrants
  confirmations: RecordedConfirmation[]
  setConfirmationOutcome: (outcome: boolean | ((req: RecordedConfirmation) => boolean)) => void
  emitApprovalRequest: (params: ApprovalRequestNotification) => void
}

function createHarness(initialOutcome = false): GateHarness {
  const window = new FakeWindow()
  const confirmations: RecordedConfirmation[] = []
  let nextOutcome: boolean | ((req: RecordedConfirmation) => boolean) = initialOutcome

  const showConfirmation: ShowConfirmation = async (request) => {
    const recorded = { message: request.message, detail: request.detail }
    confirmations.push(recorded)
    return typeof nextOutcome === 'function' ? nextOutcome(recorded) : nextOutcome
  }

  const { client, emitApprovalRequest } = makeFakeRpcClient()
  const imageGrants = new FakeImageGrants()
  const gate = new RpcPolicyGate({
    rpcClient: client,
    getMainWindow: () => window as unknown as BrowserWindow,
    showConfirmation,
    imageGrants: imageGrants as unknown as ImageGrantStore,
  })
  gate.attachApprovalSubscription()

  return {
    gate,
    window,
    imageGrants,
    confirmations,
    setConfirmationOutcome: (outcome) => {
      nextOutcome = outcome
    },
    emitApprovalRequest,
  }
}

let harness: GateHarness

beforeEach(() => {
  harness = createHarness(false)
})

describe('RpcPolicyGate — Layer 1', () => {
  test('rejects unknown methods with PolicyError', async () => {
    const result = await harness.gate.evaluate(makeEvent({}), 'evil/method', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('PolicyError')
      expect(result.error.message.startsWith('PolicyError:')).toBe(true)
      expect(result.error.message).toContain('unknown method')
    }
    expect(harness.confirmations).toHaveLength(0)
  })

  test('rejects calls from sub-frames', async () => {
    const subFrameEvent = makeEvent({ parent: { parent: null } })
    const result = await harness.gate.evaluate(subFrameEvent, 'config/get', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('sub-frames')
    }
  })

  test('rejects calls with non-object params', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'config/get',
      'not-an-object' as unknown,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('params must be an object')
    }
  })

  test('allows read-class methods without prompting', async () => {
    const result = await harness.gate.evaluate(makeEvent({}), 'config/get', {})
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })

  test('allows write-low methods (e.g. agent/run) without prompting', async () => {
    const result = await harness.gate.evaluate(makeEvent({}), 'agent/run', { message: 'hi' })
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })
})

describe('RpcPolicyGate — Layer 2 (sensitive)', () => {
  test('first sensitive call shows a confirmation; cancel returns PolicyError', async () => {
    harness.setConfirmationOutcome(false)
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'workspace/set',
      { dir: '/tmp/foo' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('user cancelled')
    }
    expect(harness.confirmations).toHaveLength(1)
    expect(harness.confirmations[0]!.message).toContain('/tmp/foo')
  })

  test('second sensitive call to same method on same window does not prompt again', async () => {
    harness.setConfirmationOutcome(true)
    const first = await harness.gate.evaluate(
      makeEvent({}),
      'workspace/set',
      { dir: '/tmp/foo' },
    )
    expect(first.ok).toBe(true)

    const second = await harness.gate.evaluate(
      makeEvent({}),
      'workspace/set',
      { dir: '/tmp/bar' },
    )
    expect(second.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(1)
  })

  test('forgetWindow clears the per-window confirmation cache', async () => {
    harness.setConfirmationOutcome(true)
    await harness.gate.evaluate(makeEvent({}), 'session/delete', { id: 's1' })
    expect(harness.confirmations).toHaveLength(1)

    harness.gate.forgetWindow(harness.window as unknown as BrowserWindow)

    await harness.gate.evaluate(makeEvent({}), 'session/delete', { id: 's2' })
    expect(harness.confirmations).toHaveLength(2)
  })

  test('config/set with non-sensitive path bypasses the prompt', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'theme', value: 'dark' },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })

  test('config/set with model.* path triggers the prompt', async () => {
    harness.setConfirmationOutcome(true)
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'model.baseUrl', value: 'https://attacker.example' },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(1)
    expect(harness.confirmations[0]!.message).toContain('model.baseUrl')
  })

  test('config/set with apiKey-bearing path triggers the prompt', async () => {
    harness.setConfirmationOutcome(false)
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'integrations.someApiKey', value: 'leaked' },
    )
    expect(result.ok).toBe(false)
    expect(harness.confirmations).toHaveLength(1)
  })

  test('different sensitive subtrees of config/set each require their own confirmation', async () => {
    harness.setConfirmationOutcome(true)
    await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'model.baseUrl', value: 'https://example' },
    )
    await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'model.name', value: 'gpt-x' },
    )
    await harness.gate.evaluate(
      makeEvent({}),
      'config/set',
      { path: 'mcp.servers.foo.command', value: '/bin/evil' },
    )
    // model triggers once, second model.* call cached, mcp.* triggers again.
    expect(harness.confirmations).toHaveLength(2)
  })
})

describe('RpcPolicyGate — Layer 3 (critical)', () => {
  test('approval/respond for high-risk approval triggers a confirmation', async () => {
    harness.emitApprovalRequest({
      id: 'approval-high-1',
      type: 'permission-lease',
      description: 'allow bash everywhere',
      risk: 'high',
    })
    harness.setConfirmationOutcome(true)

    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { id: 'approval-high-1', approved: true },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(1)
    expect(harness.confirmations[0]!.detail).toContain('approval-high-1')
  })

  test('approval/respond for high-risk approval with cancel returns PolicyError', async () => {
    harness.emitApprovalRequest({
      id: 'approval-high-2',
      type: 'permission-lease',
      description: 'allow bash everywhere',
      risk: 'high',
    })
    harness.setConfirmationOutcome(false)

    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { id: 'approval-high-2', approved: true },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('high-risk approval')
    }
  })

  test('approval/respond for low-risk approval passes without prompting', async () => {
    harness.emitApprovalRequest({
      id: 'approval-low-1',
      type: 'permission-lease',
      description: 'something benign',
      risk: 'low',
    })
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { id: 'approval-low-1', approved: true },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })

  test('approval/respond for medium-risk approval passes without prompting', async () => {
    harness.emitApprovalRequest({
      id: 'approval-med-1',
      type: 'permission-lease',
      description: 'medium risk',
      risk: 'medium',
    })
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { id: 'approval-med-1', approved: true },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })

  test('approval/respond for unknown id passes (CLI may have sent before subscription)', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { id: 'unknown-id', approved: true },
    )
    expect(result.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(0)
  })

  test('approval/respond rejects calls without an id', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'approval/respond',
      { approved: true },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('approval id is required')
    }
  })

  test('approval/respond cache forgets the id after one call', async () => {
    harness.emitApprovalRequest({
      id: 'approval-high-3',
      type: 'permission-lease',
      description: 'one-shot',
      risk: 'high',
    })
    harness.setConfirmationOutcome(true)

    await harness.gate.evaluate(makeEvent({}), 'approval/respond', {
      id: 'approval-high-3',
      approved: true,
    })

    const second = await harness.gate.evaluate(makeEvent({}), 'approval/respond', {
      id: 'approval-high-3',
      approved: true,
    })
    expect(second.ok).toBe(true)
    expect(harness.confirmations).toHaveLength(1)
  })
})

describe('RpcPolicyGate — image attachment gate', () => {
  test('agent/run with no images bypasses the image gate', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      { message: 'hi' },
    )
    expect(result.ok).toBe(true)
  })

  test('agent/run rejects when params.images contains an ungranted path', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      {
        message: 'with image',
        images: [{ path: '/etc/passwd.png', mediaType: 'image/png', name: 'p', sizeBytes: 1 }],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('PolicyError')
      expect(result.error.message).toContain('not authorised')
    }
  })

  test('agent/run accepts images whose paths were pre-granted', async () => {
    const path = '/Users/test/photo.jpg'
    harness.imageGrants.preGrant(harness.window as unknown as BrowserWindow, [path])
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      {
        message: 'with image',
        images: [{ path, mediaType: 'image/jpeg', name: 'photo.jpg', sizeBytes: 1024 }],
      },
    )
    expect(result.ok).toBe(true)
  })

  test('agent/steer also enforces the image grant', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/steer',
      {
        text: 'pull this in',
        images: [{ path: '/private/photo.png', mediaType: 'image/png', name: 'x.png', sizeBytes: 1 }],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('not authorised')
    }
  })

  test('agent/run rejects when params.images is not an array', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      { message: 'x', images: 'oops' as unknown },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('must be an array')
    }
  })

  test('agent/run rejects images entries without a string path', async () => {
    const result = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      {
        message: 'x',
        images: [{ path: 0 as unknown, mediaType: 'image/png', name: 'p', sizeBytes: 1 }],
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('must be a non-empty string')
    }
  })

  test('forgetWindow clears image grants for the closed window', async () => {
    const path = '/Users/test/photo.png'
    harness.imageGrants.preGrant(harness.window as unknown as BrowserWindow, [path])

    const before = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      { message: 'x', images: [{ path, mediaType: 'image/png', name: 'p', sizeBytes: 1 }] },
    )
    expect(before.ok).toBe(true)

    harness.gate.forgetWindow(harness.window as unknown as BrowserWindow)

    const after = await harness.gate.evaluate(
      makeEvent({}),
      'agent/run',
      { message: 'x', images: [{ path, mediaType: 'image/png', name: 'p', sizeBytes: 1 }] },
    )
    expect(after.ok).toBe(false)
  })
})
