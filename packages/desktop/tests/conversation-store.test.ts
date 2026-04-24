import { describe, expect, test } from 'bun:test'
import {
  useConversationStore,
  normalizeTextContent,
  normalizeToolName,
} from '../src/renderer/stores/conversationStore'

function resetStore(): void {
  useConversationStore.setState({
    messages: [],
    streamingText: null,
    activeToolCalls: new Map(),
    pendingToolCalls: [],
    pendingSubagentRuns: [],
    isAgentRunning: false,
    activeRunSessionId: null,
    nextId: 1,
    currentSessionId: null,
    sessions: [],
    workspace: null,
    modelName: null,
    contextUsage: null,
  })
}

describe('conversation store normalization', () => {
  test('normalizes structured text payloads into readable strings', () => {
    expect(normalizeTextContent({ text: 'Hello desktop' })).toBe('Hello desktop')
    expect(normalizeTextContent({ message: 'Something failed' })).toBe('Something failed')
    expect(normalizeTextContent([{ type: 'text', text: 'Hello' }, { text: ' world' }])).toBe(
      'Hello world',
    )
  })

  test('falls back to pretty JSON for opaque objects', () => {
    expect(normalizeTextContent({ ok: true, nested: { value: 1 } })).toBe(
      JSON.stringify({ ok: true, nested: { value: 1 } }, null, 2),
    )
  })

  test('normalizes wrapped tool names', () => {
    expect(normalizeToolName('web-search')).toBe('web-search')
    expect(normalizeToolName({ name: 'web-search' })).toBe('web-search')
    expect(normalizeToolName({ toolName: 'bash' })).toBe('bash')
  })

  test('stores and clears context usage across session changes', () => {
    resetStore()

    useConversationStore.getState().handleContextUsage({
      estimatedTotalTokens: 12_345,
      contextWindowTokens: 200_000,
      usageRatio: 0.061725,
      threshold: 'within-budget',
      breakdown: {
        systemPromptTokens: 8000,
        toolPromptTokens: 1000,
        agentsInstructionsTokens: 2000,
        memoryTokens: 300,
        conversationTokens: 45,
        toolResultTokens: 0,
      },
      contextWindowSource: 'model-registry',
    })

    expect(useConversationStore.getState().contextUsage).toEqual({
      estimatedTotalTokens: 12_345,
      contextWindowTokens: 200_000,
      usageRatio: 0.061725,
      threshold: 'within-budget',
      breakdown: {
        systemPromptTokens: 8000,
        toolPromptTokens: 1000,
        agentsInstructionsTokens: 2000,
        memoryTokens: 300,
        conversationTokens: 45,
        toolResultTokens: 0,
      },
      contextWindowSource: 'model-registry',
    })

    useConversationStore.getState().createNewSession('session-1')
    expect(useConversationStore.getState().contextUsage).toBeNull()
  })
})

describe('conversation store sessions', () => {
  test('creates a persisted session before the first agent run when none is active', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (method === 'session/new') {
            return Promise.resolve({ sessionId: 'session-first-message' })
          }
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    useConversationStore.getState().sendMessage('What materials are good for use in wet areas?')

    await Promise.resolve()
    await Promise.resolve()

    expect(calls.map((call) => call.method)).toEqual(['session/new', 'agent/run'])
    expect(useConversationStore.getState().currentSessionId).toBe('session-first-message')
    expect(useConversationStore.getState().activeRunSessionId).toBe('session-first-message')
    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-first-message',
        title: 'Wet areas materials',
        titleSource: 'auto',
        messageCount: 1,
        runStatus: 'running',
      }),
    )
  })

  test('refreshes weak automatic titles after the assistant turn completes', () => {
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'session-title',
      activeRunSessionId: 'session-title',
      isAgentRunning: true,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Implement the recommended direction - option 1 and 2',
          timestamp: '2026-04-23T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-title',
          title: 'Recommended direction option 1',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      text: 'Implemented the desktop session title rename flow.',
    })

    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        title: 'Desktop session title rename',
        titleSource: 'auto',
        runStatus: 'idle',
      }),
    )
  })

  test('keeps manual titles when assistant turns complete', () => {
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'session-manual-title',
      activeRunSessionId: 'session-manual-title',
      isAgentRunning: true,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Implement the recommended title changes',
          timestamp: '2026-04-23T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-manual-title',
          title: 'Pinned Sidebar Title',
          titleSource: 'manual',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      text: 'Updated the sidebar search experience.',
    })

    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        title: 'Pinned Sidebar Title',
        titleSource: 'manual',
        runStatus: 'idle',
      }),
    )
  })

  test('renames sessions locally as manual titles', () => {
    resetStore()

    useConversationStore.setState({
      sessions: [
        {
          id: 'session-rename',
          title: 'Auto Title',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
        },
      ],
    })

    useConversationStore.getState().renameSession('session-rename', '  My renamed session  ')

    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        title: 'My renamed session',
        titleSource: 'manual',
      }),
    )
  })

  test('keeps the active local session when a stale session list response arrives', () => {
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'session-new',
      activeRunSessionId: 'session-new',
      sessions: [
        {
          id: 'session-new',
          title: 'Fresh question',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().setSessions([])

    expect(useConversationStore.getState().sessions).toEqual([
      expect.objectContaining({
        id: 'session-new',
        title: 'Fresh question',
        runStatus: 'running',
      }),
    ])
  })
})

describe('loadSession image preview hydration', () => {
  test('fills previewDataUrl on loaded messages by calling validateImageAttachments', async () => {
    resetStore()

    let resolveValidate: (result: {
      accepted: Array<Record<string, unknown>>
      rejected: unknown[]
    }) => void = () => {}
    const validatePromise = new Promise<{
      accepted: Array<Record<string, unknown>>
      rejected: unknown[]
    }>((resolve) => {
      resolveValidate = resolve
    })
    const calls: string[][] = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        validateImageAttachments: (paths: string[]) => {
          calls.push(paths)
          return validatePromise
        },
      },
    }

    useConversationStore.getState().loadSession(
      'session-with-image',
      [
        {
          role: 'user',
          content: 'What is in this image?',
          timestamp: '2025-01-01T00:00:00Z',
          imageAttachments: [
            {
              path: '/tmp/watermark2.webp',
              name: 'watermark2.webp',
              mediaType: 'image/webp',
              sizeBytes: 1234,
            },
          ],
        },
      ],
      null,
    )

    const before = useConversationStore.getState().messages[0]
    expect(before.imageAttachments?.[0].previewDataUrl).toBeUndefined()
    expect(calls).toEqual([['/tmp/watermark2.webp']])

    resolveValidate({
      accepted: [
        {
          path: '/tmp/watermark2.webp',
          name: 'watermark2.webp',
          mediaType: 'image/webp',
          sizeBytes: 1234,
          previewDataUrl: 'data:image/webp;base64,AAA=',
        },
      ],
      rejected: [],
    })

    await validatePromise
    await Promise.resolve()

    const after = useConversationStore.getState().messages[0]
    expect(after.imageAttachments?.[0].previewDataUrl).toBe('data:image/webp;base64,AAA=')
  })

  test('attaches toolCalls from SessionMessage onto loaded agent messages', () => {
    resetStore()

    useConversationStore.getState().loadSession(
      'session-with-tools',
      [
        {
          role: 'user',
          content: 'What does foo.ts do?',
          timestamp: '2025-01-01T00:00:00Z',
        },
        {
          role: 'assistant',
          content: 'Let me read it.',
          timestamp: '2025-01-01T00:00:01Z',
          toolCalls: [
            {
              id: 'tc-1',
              toolName: 'file-read',
              input: { path: 'foo.ts' },
              output: { text: 'console.log(1)' },
            },
          ],
        },
        {
          role: 'assistant',
          content: 'It logs 1.',
          timestamp: '2025-01-01T00:00:02Z',
        },
      ],
      null,
    )

    const messages = useConversationStore.getState().messages
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('agent')
    expect(messages[1].toolCalls).toEqual([
      {
        id: 'tc-1',
        toolName: 'file-read',
        input: { path: 'foo.ts' },
        output: { text: 'console.log(1)' },
      },
    ])
    expect(messages[2].toolCalls).toBeUndefined()
  })

  test('discards hydration result if the active session changed during validation', async () => {
    resetStore()

    let resolveValidate: (result: {
      accepted: Array<Record<string, unknown>>
      rejected: unknown[]
    }) => void = () => {}
    const validatePromise = new Promise<{
      accepted: Array<Record<string, unknown>>
      rejected: unknown[]
    }>((resolve) => {
      resolveValidate = resolve
    })
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        validateImageAttachments: () => validatePromise,
      },
    }

    useConversationStore.getState().loadSession(
      'session-a',
      [
        {
          role: 'user',
          content: 'image from A',
          timestamp: '2025-01-01T00:00:00Z',
          imageAttachments: [
            {
              path: '/tmp/a.png',
              name: 'a.png',
              mediaType: 'image/png',
              sizeBytes: 10,
            },
          ],
        },
      ],
      null,
    )

    useConversationStore.getState().setCurrentSessionId('session-b')

    resolveValidate({
      accepted: [
        {
          path: '/tmp/a.png',
          name: 'a.png',
          mediaType: 'image/png',
          sizeBytes: 10,
          previewDataUrl: 'data:image/png;base64,BBB=',
        },
      ],
      rejected: [],
    })

    await validatePromise
    await Promise.resolve()

    const messages = useConversationStore.getState().messages
    expect(messages[0].imageAttachments?.[0].previewDataUrl).toBeUndefined()
  })
})
