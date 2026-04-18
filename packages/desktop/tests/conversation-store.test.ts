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
