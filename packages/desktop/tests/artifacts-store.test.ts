import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  useArtifactsStore,
  selectCurrentArtifacts,
  selectCurrentArtifact,
  selectCurrentHtml,
} from '../src/renderer/stores/artifactsStore'
import type { AgentArtifactCreatedNotification } from '../src/shared/protocol'

interface RpcCall {
  method: string
  params?: unknown
}

interface MockOuroboros {
  rpc(method: string, params?: unknown): Promise<unknown>
}

function installMockRpc(handler: (method: string, params?: unknown) => unknown): RpcCall[] {
  const calls: RpcCall[] = []
  const win = (globalThis as { window?: { ouroboros?: MockOuroboros } }).window ?? (globalThis as { window?: { ouroboros?: MockOuroboros } })
  ;(globalThis as { window?: { ouroboros?: MockOuroboros } }).window = win as { ouroboros?: MockOuroboros }
  win.ouroboros = {
    rpc: async (method, params) => {
      calls.push({ method, params })
      return handler(method, params)
    },
  }
  return calls
}

function uninstallMockRpc(): void {
  const win = (globalThis as { window?: { ouroboros?: MockOuroboros } }).window
  if (win) delete win.ouroboros
}

function notification(
  sessionId: string,
  artifactId: string,
  version: number,
  title = 't',
): AgentArtifactCreatedNotification {
  return {
    sessionId,
    artifactId,
    version,
    title,
    description: `${title} v${version}`,
    path: `/tmp/${artifactId}.v${version}.html`,
    bytes: 100,
    createdAt: new Date(2026, 0, 1, 0, 0, version).toISOString(),
  }
}

beforeEach(() => {
  useArtifactsStore.getState().reset()
})

afterEach(() => {
  uninstallMockRpc()
})

describe('artifacts store', () => {
  test('handleArtifactCreated appends per-session and dedupes by (id,version)', () => {
    useArtifactsStore.getState().handleArtifactCreated(notification('s1', 'a', 1))
    useArtifactsStore.getState().handleArtifactCreated(notification('s1', 'a', 1, 't-updated'))
    useArtifactsStore.getState().handleArtifactCreated(notification('s2', 'a', 1))

    const all = useArtifactsStore.getState().artifactsBySession
    expect(all['s1']).toHaveLength(1)
    expect(all['s1'][0].title).toBe('t-updated')
    expect(all['s2']).toHaveLength(1)
  })

  test('setSession loads via artifacts/list and selects latest when followLatest is true', async () => {
    installMockRpc((method) => {
      if (method === 'artifacts/list') {
        return {
          artifacts: [
            {
              artifactId: 'a',
              version: 1,
              sessionId: 's1',
              title: 'A',
              path: '/p/a.v1.html',
              bytes: 1,
              createdAt: '2026-01-01T00:00:01Z',
            },
            {
              artifactId: 'a',
              version: 2,
              sessionId: 's1',
              title: 'A',
              path: '/p/a.v2.html',
              bytes: 1,
              createdAt: '2026-01-01T00:00:02Z',
            },
          ],
        }
      }
      if (method === 'artifacts/read') {
        return { html: '<html>read</html>', artifact: {} }
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await useArtifactsStore.getState().setSession('s1')

    const state = useArtifactsStore.getState()
    expect(state.selectedArtifactId).toBe('a')
    expect(state.selectedVersion).toBe(2)
    expect(selectCurrentHtml(state)).toBe('<html>read</html>')
  })

  test('selectArtifact caches html and avoids redundant artifacts/read calls', async () => {
    const calls = installMockRpc((method) => {
      if (method === 'artifacts/list') return { artifacts: [] }
      return { html: '<html>x</html>', artifact: {} }
    })

    useArtifactsStore.getState().reset()
    await useArtifactsStore.getState().setSession('s1')
    useArtifactsStore.getState().setFollowLatest(false)

    useArtifactsStore.getState().handleArtifactCreated(notification('s1', 'a', 1))
    await useArtifactsStore.getState().selectArtifact('a', 1)
    await useArtifactsStore.getState().selectArtifact('a', 1)

    const reads = calls.filter((c) => c.method === 'artifacts/read')
    expect(reads).toHaveLength(1)
  })

  test('followLatest=false does not auto-switch on a new artifact notification', async () => {
    installMockRpc((method) => {
      if (method === 'artifacts/list') return { artifacts: [] }
      return { html: '<html>1</html>', artifact: {} }
    })

    await useArtifactsStore.getState().setSession('s1')
    useArtifactsStore.getState().handleArtifactCreated(notification('s1', 'a', 1))
    await useArtifactsStore.getState().selectArtifact('a', 1)

    useArtifactsStore.getState().setFollowLatest(false)
    useArtifactsStore.getState().handleArtifactCreated(notification('s1', 'a', 2))

    const state = useArtifactsStore.getState()
    expect(state.selectedVersion).toBe(1)
  })

  test('selectors return current session view', () => {
    useArtifactsStore.setState({
      artifactsBySession: {
        s1: [
          {
            artifactId: 'a',
            version: 1,
            sessionId: 's1',
            title: 'A',
            path: '/p/a.v1.html',
            bytes: 1,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      selectedSessionId: 's1',
      selectedArtifactId: 'a',
      selectedVersion: 1,
      htmlCache: { 's1:a:v1': '<html>cached</html>' },
    })
    const state = useArtifactsStore.getState()
    expect(selectCurrentArtifacts(state)).toHaveLength(1)
    expect(selectCurrentArtifact(state)?.artifactId).toBe('a')
    expect(selectCurrentHtml(state)).toBe('<html>cached</html>')
  })

  test('reset clears all state', () => {
    useArtifactsStore.setState({
      artifactsBySession: { s1: [] },
      selectedSessionId: 's1',
      selectedArtifactId: 'a',
      selectedVersion: 1,
      htmlCache: { x: 'y' },
      followLatest: false,
    })
    useArtifactsStore.getState().reset()
    const s = useArtifactsStore.getState()
    expect(s.artifactsBySession).toEqual({})
    expect(s.selectedSessionId).toBeNull()
    expect(s.followLatest).toBe(true)
  })
})
