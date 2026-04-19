import { describe, expect, test } from 'bun:test'
import {
  useConversationStore,
  normalizeTextContent,
  normalizeToolName,
} from '../src/renderer/stores/conversationStore'

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
    useConversationStore.setState({
      messages: [],
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      isAgentRunning: false,
      nextId: 1,
      currentSessionId: null,
      sessions: [],
      workspace: null,
      modelName: null,
      contextUsage: null,
    })

    useConversationStore.getState().handleContextUsage({
      estimatedTotalTokens: 12_345,
      contextWindowTokens: 200_000,
      usageRatio: 0.061725,
      threshold: 'within-budget',
    })

    expect(useConversationStore.getState().contextUsage).toEqual({
      estimatedTotalTokens: 12_345,
      contextWindowTokens: 200_000,
      usageRatio: 0.061725,
      threshold: 'within-budget',
    })

    useConversationStore.getState().createNewSession('session-1')
    expect(useConversationStore.getState().contextUsage).toBeNull()
  })
})

describe('loadSession image preview hydration', () => {
  function resetStore(): void {
    useConversationStore.setState({
      messages: [],
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
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
