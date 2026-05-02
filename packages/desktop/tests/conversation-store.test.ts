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
    pendingActivatedSkills: [],
    pendingSubmittedPlan: null,
    activePlanDecision: null,
    isAgentRunning: false,
    activeRunSessionId: null,
    nextId: 1,
    currentSessionId: null,
    sessionRunSnapshots: new Map(),
    sessions: [],
    workspace: null,
    workspaceMode: 'simple',
    selectedWorkspacePath: null,
    workspaceModeError: null,
    modelName: null,
    contextUsage: null,
    reasoningEffort: null,
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

  test('renders a submitted plan into the completed agent message', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-plan',
      activeRunSessionId: 'session-plan',
      isAgentRunning: true,
      sessionRunSnapshots: new Map([
        [
          'session-plan',
          {
            messages: [],
            streamingText: '',
            activeToolCalls: new Map(),
            pendingToolCalls: [],
            pendingSubagentRuns: [],
            pendingActivatedSkills: [],
            pendingSubmittedPlan: null,
            isAgentRunning: true,
            contextUsage: null,
            nextId: 1,
          },
        ],
      ]),
    })

    useConversationStore.getState().handlePlanSubmitted({
      sessionId: 'session-plan',
      plan: {
        title: 'Desktop Plan Review Prompt',
        summary: 'Render the submitted plan in chat.',
        steps: [
          {
            description: 'Display the plan body',
            targetFiles: ['packages/desktop/src/renderer/App.tsx'],
            tools: ['file-edit'],
          },
        ],
        exploredFiles: ['packages/desktop/src/renderer/App.tsx'],
        status: 'submitted',
      },
    })
    useConversationStore.getState().handleTurnComplete({
      sessionId: 'session-plan',
      text: 'Plan submitted. Please review and let me know if you approve, reject, or cancel.',
      iterations: 1,
    })

    const state = useConversationStore.getState()
    expect(state.messages[0].text).toContain('## Desktop Plan Review Prompt')
    expect(state.messages[0].text).toContain('Display the plan body')
    expect(state.activePlanDecision?.plan.title).toBe('Desktop Plan Review Prompt')
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
    expect(calls[0].params).toEqual({ workspaceMode: 'simple' })
    expect(calls[1].params).toEqual(
      expect.objectContaining({ sessionId: 'session-first-message' }),
    )
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

  test('updates the session title immediately when sendMessage is called on a "New conversation" session', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    // Simulate a session that was just created (title is "New conversation")
    useConversationStore.setState({
      currentSessionId: 'session-new-title',
      sessions: [
        {
          id: 'session-new-title',
          title: 'New conversation',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 0,
          runStatus: 'idle',
        },
      ],
    })

    // Send the very first message — the title should update immediately,
    // not wait for handleTurnComplete.
    useConversationStore.getState().sendMessage('How to fix the login bug?')

    const state = useConversationStore.getState()
    expect(state.sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-new-title',
        title: 'Fix the login bug',
        titleSource: 'auto',
        runStatus: 'running',
      }),
    )
  })

  test('pins agent/run to the currently viewed session', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    useConversationStore.setState({
      currentSessionId: 'session-existing',
      sessions: [
        {
          id: 'session-existing',
          title: 'Existing chat',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 2,
          runStatus: 'idle',
        },
      ],
    })

    useConversationStore.getState().sendMessage('Continue this chat')

    await Promise.resolve()

    expect(calls).toEqual([
      {
        method: 'agent/run',
        params: expect.objectContaining({
          message: 'Continue this chat',
          sessionId: 'session-existing',
        }),
      },
    ])
  })

  test('workspace mode requires a selected folder before first send', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    useConversationStore.getState().setWorkspaceMode('workspace')
    useConversationStore.getState().sendMessage('Start in a workspace')

    await Promise.resolve()

    expect(calls).toEqual([])
    expect(useConversationStore.getState().workspaceModeError).toBe(
      'Select a workspace folder before starting a Workspace chat.',
    )
  })

  test('workspace mode sends selected folder to session/new', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (method === 'session/new') {
            return Promise.resolve({
              sessionId: 'session-workspace',
              workspacePath: '/tmp/project',
              workspaceMode: 'workspace',
            })
          }
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    useConversationStore.getState().setSelectedWorkspacePath('/tmp/project')
    useConversationStore.getState().setWorkspaceMode('workspace')
    useConversationStore.getState().sendMessage('Start in project')

    await Promise.resolve()
    await Promise.resolve()

    expect(calls[0]).toEqual({
      method: 'session/new',
      params: { workspaceMode: 'workspace', workspacePath: '/tmp/project' },
    })
    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-workspace',
        workspacePath: '/tmp/project',
        workspaceMode: 'workspace',
      }),
    )
  })

  test('loading a session displays that session workspace mode', () => {
    resetStore()
    useConversationStore.getState().setSelectedWorkspacePath('/tmp/project')
    useConversationStore.getState().setWorkspaceMode('workspace')

    useConversationStore
      .getState()
      .loadSession('simple-session', [], '/tmp/ouroboros-simple/1', 'simple')

    expect(useConversationStore.getState().workspaceMode).toBe('simple')

    useConversationStore
      .getState()
      .loadSession('workspace-session', [], '/tmp/project', 'workspace')

    expect(useConversationStore.getState().workspaceMode).toBe('workspace')
    expect(useConversationStore.getState().workspace).toBe('/tmp/project')
  })

  test('new empty sessions default to simple mode even after a workspace chat', () => {
    resetStore()

    useConversationStore.getState().setSelectedWorkspacePath('/tmp/project')
    useConversationStore.getState().setWorkspaceMode('workspace')
    useConversationStore.getState().createNewSession('session-simple')

    expect(useConversationStore.getState().workspaceMode).toBe('simple')
    expect(useConversationStore.getState().workspace).toBeNull()
    expect(useConversationStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-simple',
        workspaceMode: 'simple',
      }),
    )
  })

  test('workspace mode cannot change after a conversation starts', () => {
    resetStore()

    useConversationStore.getState().loadSession(
      'simple-session',
      [
        {
          role: 'user',
          content: 'Keep this session simple',
          timestamp: '2026-04-29T00:00:00.000Z',
        },
      ],
      '/tmp/ouroboros-simple/1',
      'simple',
    )

    useConversationStore.getState().setSelectedWorkspacePath('/tmp/project')
    useConversationStore.getState().setWorkspaceMode('workspace')

    expect(useConversationStore.getState().workspaceMode).toBe('simple')
  })

  test('does NOT overwrite a meaningful auto title on subsequent sendMessage', async () => {
    resetStore()

    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: { rpc: () => Promise.resolve({ text: 'ok' }) },
    }

    // Simulate a session that already has a derived title from a prior turn
    useConversationStore.setState({
      currentSessionId: 'session-existing',
      sessions: [
        {
          id: 'session-existing',
          title: 'Login bug fix',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 2,
          runStatus: 'idle',
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', text: 'How to fix the login bug?', timestamp: '2026-04-23T00:00:00.000Z' },
        { id: 'agent-1', role: 'agent', text: 'Here is the fix.', timestamp: '2026-04-23T00:00:01.000Z' },
      ],
    })

    useConversationStore.getState().sendMessage('Now do the logout')

    const state = useConversationStore.getState()
    // Title should remain the existing one — it's not "New conversation"
    expect(state.sessions[0]).toEqual(
      expect.objectContaining({
        id: 'session-existing',
        title: 'Login bug fix',
        runStatus: 'running',
      }),
    )
  })

  test('seeds pendingActivatedSkills from sendMessage and folds into the assistant turn', () => {
    resetStore()

    // Suppress the fire-and-forget RPC inside sendMessage. We're not testing
    // the wire here, just store-internal accumulation.
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: { rpc: () => Promise.resolve({ sessionId: 'session-skill-acc' }) },
    }

    const store = useConversationStore.getState()

    store.sendMessage('Plan it', undefined, undefined, 'meta-thinking')
    expect(useConversationStore.getState().pendingActivatedSkills).toEqual(['meta-thinking'])

    // skill/activated arrives for the same name (echo of the user-selected
    // activation). Should be deduped — no second entry.
    store.handleSkillActivated({ name: 'meta-thinking' })
    expect(useConversationStore.getState().pendingActivatedSkills).toEqual(['meta-thinking'])

    // The LLM activates an additional skill mid-turn.
    store.handleSkillActivated({ name: 'self-test' })
    expect(useConversationStore.getState().pendingActivatedSkills).toEqual([
      'meta-thinking',
      'self-test',
    ])

    store.handleTurnComplete({ text: 'done' })
    const state = useConversationStore.getState()
    const lastMessage = state.messages[state.messages.length - 1]
    expect(lastMessage.role).toBe('agent')
    expect(lastMessage.activatedSkills).toEqual(['meta-thinking', 'self-test'])
    // And the accumulator is reset for the next turn.
    expect(state.pendingActivatedSkills).toEqual([])
  })

  test('handleSkillActivated dedupes by name', () => {
    resetStore()
    useConversationStore.setState({ pendingActivatedSkills: ['meta-thinking'] })

    useConversationStore.getState().handleSkillActivated({ name: 'meta-thinking' })
    expect(useConversationStore.getState().pendingActivatedSkills).toEqual(['meta-thinking'])
  })

  test('forwards selected skill name to agent run', async () => {
    resetStore()

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          if (method === 'session/new') {
            return Promise.resolve({ sessionId: 'session-skill-message' })
          }
          return Promise.resolve({ text: 'ok' })
        },
      },
    }

    useConversationStore
      .getState()
      .sendMessage('Review this patch', undefined, undefined, 'code-review')

    await Promise.resolve()
    await Promise.resolve()

    expect(calls.find((call) => call.method === 'agent/run')?.params).toEqual(
      expect.objectContaining({
        message: 'Review this patch',
        skillName: 'code-review',
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

  test('handleRunSettled surfaces max-step stops after a normal turnComplete notification', () => {
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'session-max-steps',
      activeRunSessionId: 'session-max-steps',
      isAgentRunning: true,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Work through this',
          timestamp: '2026-04-23T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-max-steps',
          title: 'Work through this',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      sessionId: 'session-max-steps',
      text: 'Partial final answer',
      iterations: 5,
    })
    useConversationStore.getState().handleRunSettled({
      sessionId: 'session-max-steps',
      text: 'Partial final answer',
      iterations: 5,
      stopReason: 'max_steps',
      maxIterationsReached: true,
    })

    const messages = useConversationStore.getState().messages
    expect(messages.map((message) => message.role)).toEqual(['user', 'agent', 'system'])
    expect(messages[2].text).toContain('Stopped after reaching the configured step limit')
    expect(messages.filter((message) => message.text === 'Partial final answer')).toHaveLength(1)
  })

  test('handleRunSettled finalizes output when the turnComplete notification is missed', () => {
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'session-missed-notification',
      activeRunSessionId: 'session-missed-notification',
      isAgentRunning: true,
      streamingText: 'Partial stream',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Answer this',
          timestamp: '2026-04-23T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-missed-notification',
          title: 'Answer this',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleRunSettled({
      sessionId: 'session-missed-notification',
      text: 'Final answer from RPC',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    })

    const state = useConversationStore.getState()
    expect(state.isAgentRunning).toBe(false)
    expect(state.streamingText).toBeNull()
    expect(state.messages[state.messages.length - 1]).toEqual(
      expect.objectContaining({ role: 'agent', text: 'Final answer from RPC' }),
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

  test('setSessions preserves desktop-derived title for running sessions, preventing fallback to CLI default', () => {
    // Regression: when session/list returns with "New conversation" title (CLI
    // only refreshes titles after runs complete via refreshAutoSessionTitle),
    // the desktop's locally-derived title from sendMessage must not be
    // overwritten.
    resetStore()

    useConversationStore.setState({
      currentSessionId: 'sess-1',
      activeRunSessionId: 'sess-1',
      sessions: [
        {
          id: 'sess-1',
          title: 'Add input validation',
          titleSource: 'auto',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          messageCount: 1,
          runStatus: 'running',
        },
      ],
    })

    // Simulate session/list arriving with the CLI's stale "New conversation"
    useConversationStore.getState().setSessions([
      {
        id: 'sess-1',
        title: 'New conversation',
        titleSource: 'auto',
        createdAt: '2026-04-23T00:00:00.000Z',
        lastActive: '2026-04-23T00:00:00.000Z',
        messageCount: 0,
      },
    ])

    const { sessions } = useConversationStore.getState()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('Add input validation')
    expect(sessions[0].titleSource).toBe('auto')
    expect(sessions[0].runStatus).toBe('running')
  })
})

describe('per-session notification routing', () => {
  // Regression tests for the "chats lost on switch back" bug. Notifications
  // for a session the user is NOT currently viewing must update sidebar
  // status only — never the visible streamingText / messages / pending* state
  // that belongs to the currently-viewed session.

  test('handleAgentText for a non-current session does NOT touch streamingText', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-B',
      sessions: [
        {
          id: 'session-A',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 0,
          title: 'A',
          titleSource: 'auto',
        },
        {
          id: 'session-B',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 0,
          title: 'B',
          titleSource: 'auto',
        },
      ],
      streamingText: 'session A in progress',
    })

    useConversationStore
      .getState()
      .handleAgentText({ sessionId: 'session-B', text: 'streaming for B' })

    // The visible session A's streamingText must be unchanged.
    expect(useConversationStore.getState().streamingText).toBe('session A in progress')
  })

  test('handleAgentText for the current session DOES append to streamingText', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-A',
      sessions: [],
    })

    useConversationStore.getState().handleAgentText({ sessionId: 'session-A', text: 'hello ' })
    useConversationStore.getState().handleAgentText({ sessionId: 'session-A', text: 'world' })

    expect(useConversationStore.getState().streamingText).toBe('hello world')
  })

  test('handleTurnComplete for a non-current session updates sidebar only, leaves messages intact', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-B',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'session A user message',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ],
      sessions: [
        {
          id: 'session-B',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 0,
          title: 'B',
          titleSource: 'auto',
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      sessionId: 'session-B',
      text: 'reply for session B',
      iterations: 1,
    })

    const state = useConversationStore.getState()
    // Visible messages (session A's) must NOT receive the assistant message.
    expect(state.messages.map((m) => m.text)).toEqual(['session A user message'])
    // Sidebar entry for B reflects idle.
    expect(state.sessions[0].runStatus).toBe('idle')
    // The global activeRunSessionId tracker is cleared since B was the
    // running session.
    expect(state.activeRunSessionId).toBeNull()
    expect(state.isAgentRunning).toBe(false)
  })

  test('handleTurnComplete for the current session appends the assistant message', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-A',
      messages: [],
      sessions: [
        {
          id: 'session-A',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 0,
          title: 'A',
          titleSource: 'auto',
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      sessionId: 'session-A',
      text: 'reply for A',
      iterations: 1,
    })

    const state = useConversationStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].role).toBe('agent')
    expect(state.messages[0].text).toBe('reply for A')
    expect(state.sessions[0].runStatus).toBe('idle')
  })

  test('handleSkillActivated ignores activations from non-current sessions', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      pendingActivatedSkills: [],
    })

    useConversationStore
      .getState()
      .handleSkillActivated({ sessionId: 'session-B', name: 'meta-thinking' })

    expect(useConversationStore.getState().pendingActivatedSkills).toEqual([])
  })

  test('handleSkillActivated applies activations for the current session', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      pendingActivatedSkills: [],
    })

    useConversationStore
      .getState()
      .handleSkillActivated({ sessionId: 'session-A', name: 'meta-thinking' })

    expect(useConversationStore.getState().pendingActivatedSkills).toEqual(['meta-thinking'])
  })

  test('handleAgentError for a non-current session marks sidebar but does not pollute visible messages', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-B',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'A user message',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ],
      sessions: [
        {
          id: 'session-B',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 0,
          title: 'B',
          titleSource: 'auto',
          runStatus: 'running',
        },
      ],
    })

    useConversationStore
      .getState()
      .handleAgentError({ sessionId: 'session-B', message: 'B failed' })

    const state = useConversationStore.getState()
    expect(state.messages.map((m) => m.text)).toEqual(['A user message'])
    expect(state.sessions[0].runStatus).toBe('error')
    expect(state.activeRunSessionId).toBeNull()
  })
})

describe('per-session snapshots survive view switches', () => {
  // Regression tests for the "switching between mid-processing sessions
  // shows an empty chat" UX bug. Per-session snapshots preserve the user
  // message, partial streaming text, pending tool calls, etc. across
  // switches.

  test('switching to a new session and back preserves the user message and partial reply', () => {
    resetStore()
    // Set up: in session A, user has sent a message and the agent is
    // partially streaming a reply.
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-A',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'tell me a story',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ],
      streamingText: 'Once upon a time',
      isAgentRunning: true,
      sessions: [
        {
          id: 'session-A',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 1,
          title: 'A',
          titleSource: 'auto',
          runStatus: 'running',
        },
      ],
    })

    // Switch to a brand-new session B (the "+ new chat" button click).
    useConversationStore.getState().createNewSession('session-B')

    // Visible UI is now B's empty state.
    expect(useConversationStore.getState().messages).toEqual([])
    expect(useConversationStore.getState().streamingText).toBeNull()

    // Switch back to A.
    useConversationStore.getState().setCurrentSessionId('session-A')

    const restored = useConversationStore.getState()
    // The user's question and partial reply must still be there.
    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0].text).toBe('tell me a story')
    expect(restored.streamingText).toBe('Once upon a time')
    expect(restored.isAgentRunning).toBe(true)
  })

  test('streaming text accumulates into the background session snapshot while user views another session', () => {
    resetStore()
    // User is currently viewing session A. Session B has a run in progress.
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-B',
      sessionRunSnapshots: new Map([
        [
          'session-B',
          {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                text: 'B question',
                timestamp: '2025-01-01T00:00:00Z',
              },
            ],
            streamingText: 'half',
            activeToolCalls: new Map(),
            pendingToolCalls: [],
            pendingSubagentRuns: [],
            pendingActivatedSkills: [],
            isAgentRunning: true,
            contextUsage: null,
            nextId: 2,
          },
        ],
      ]),
      sessions: [],
    })

    // A streaming chunk arrives for session B while the user is on A.
    useConversationStore
      .getState()
      .handleAgentText({ sessionId: 'session-B', text: ' way through' })

    // A's flat state is unchanged — no streaming text leaked over.
    expect(useConversationStore.getState().streamingText).toBeNull()

    // B's snapshot accumulated the new text.
    const bSnap = useConversationStore.getState().sessionRunSnapshots.get('session-B')
    expect(bSnap?.streamingText).toBe('half way through')
    expect(bSnap?.messages).toHaveLength(1)

    // Switch to B — the accumulated state becomes the visible UI.
    useConversationStore.getState().setCurrentSessionId('session-B')
    expect(useConversationStore.getState().messages).toHaveLength(1)
    expect(useConversationStore.getState().streamingText).toBe('half way through')
  })

  test('handleTurnComplete for a background session lands the assistant message in the snapshot', () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'session-A',
      activeRunSessionId: 'session-B',
      sessionRunSnapshots: new Map([
        [
          'session-B',
          {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                text: 'B question',
                timestamp: '2025-01-01T00:00:00Z',
              },
            ],
            streamingText: 'partial',
            activeToolCalls: new Map(),
            pendingToolCalls: [],
            pendingSubagentRuns: [],
            pendingActivatedSkills: [],
            isAgentRunning: true,
            contextUsage: null,
            nextId: 2,
          },
        ],
      ]),
      sessions: [
        {
          id: 'session-B',
          createdAt: '2025-01-01T00:00:00Z',
          lastActive: '2025-01-01T00:00:00Z',
          messageCount: 1,
          title: 'B',
          titleSource: 'auto',
          runStatus: 'running',
        },
      ],
    })

    useConversationStore.getState().handleTurnComplete({
      sessionId: 'session-B',
      text: 'B reply complete',
      iterations: 1,
    })

    // B's snapshot now has both the user message and the finalized
    // assistant reply. Switching to B reveals the full conversation.
    const bSnap = useConversationStore.getState().sessionRunSnapshots.get('session-B')
    expect(bSnap?.messages).toHaveLength(2)
    expect(bSnap?.messages[1].role).toBe('agent')
    expect(bSnap?.messages[1].text).toBe('B reply complete')
    expect(bSnap?.streamingText).toBeNull()
    expect(bSnap?.isAgentRunning).toBe(false)

    // Sidebar entry reflects idle.
    const session = useConversationStore.getState().sessions[0]
    expect(session.runStatus).toBe('idle')
    expect(session.messageCount).toBe(2)
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

    // After switching to session B, the visible chat should be B's (empty —
    // we never loaded anything for it). The late-arriving A hydration must
    // not leak into B's messages.
    expect(useConversationStore.getState().messages).toEqual([])

    // Switch back to A: its snapshot was preserved on the switch-out.
    // Hydration was discarded because the snapshot reference changed during
    // validation (the loadSession→setCurrentSessionId sequence rebuilt A's
    // snapshot). A's image therefore still has no previewDataUrl.
    useConversationStore.getState().setCurrentSessionId('session-a')
    const aMessages = useConversationStore.getState().messages
    expect(aMessages[0]?.imageAttachments?.[0].previewDataUrl).toBeUndefined()
  })
})

describe('mid-flight steering', () => {
  test('steerCurrentRun is a no-op when the agent is idle', () => {
    resetStore()
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: { rpc: () => Promise.resolve({ accepted: true }) },
    }

    useConversationStore.getState().steerCurrentRun('hi')
    expect(useConversationStore.getState().messages).toEqual([])
  })

  test('steerCurrentRun adds a pending steer bubble and fires agent/steer over RPC', async () => {
    resetStore()
    useConversationStore.setState({ isAgentRunning: true, activeRunSessionId: 'session-x' })

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return Promise.resolve({ accepted: true })
        },
      },
    }

    useConversationStore.getState().steerCurrentRun('actually pivot')
    await Promise.resolve()
    await Promise.resolve()

    const messages = useConversationStore.getState().messages
    expect(messages).toHaveLength(1)
    const bubble = messages[0]!
    expect(bubble.kind).toBe('steer')
    expect(bubble.steerStatus).toBe('pending')
    expect(bubble.text).toBe('actually pivot')
    expect(typeof bubble.steerRequestId).toBe('string')

    const steerCall = calls.find((c) => c.method === 'agent/steer')
    expect(steerCall).toBeDefined()
    expect(steerCall?.params).toEqual(
      expect.objectContaining({
        message: 'actually pivot',
        sessionId: 'session-x',
        requestId: bubble.steerRequestId,
      }),
    )
  })

  test('handleSteerInjected flips a matching bubble from pending to injected', () => {
    resetStore()
    useConversationStore.setState({
      messages: [
        {
          id: 's1',
          role: 'user',
          text: 'pivot',
          timestamp: '2026-04-25T00:00:00Z',
          kind: 'steer',
          steerStatus: 'pending',
          steerRequestId: 'req-42',
        },
      ],
    })

    useConversationStore
      .getState()
      .handleSteerInjected({ sessionId: null, steerId: 'req-42', iteration: 2, text: 'pivot' })

    expect(useConversationStore.getState().messages[0]!.steerStatus).toBe('injected')
  })

  test('handleSteerOrphaned flags every matching bubble', () => {
    resetStore()
    useConversationStore.setState({
      messages: [
        {
          id: 's1',
          role: 'user',
          text: 'pivot 1',
          timestamp: '2026-04-25T00:00:00Z',
          kind: 'steer',
          steerStatus: 'pending',
          steerRequestId: 'req-1',
        },
        {
          id: 's2',
          role: 'user',
          text: 'pivot 2',
          timestamp: '2026-04-25T00:00:01Z',
          kind: 'steer',
          steerStatus: 'pending',
          steerRequestId: 'req-2',
        },
      ],
    })

    useConversationStore.getState().handleSteerOrphaned({
      sessionId: null,
      reason: 'cancelled',
      steers: [
        { id: 'req-1', text: 'pivot 1' },
        { id: 'req-2', text: 'pivot 2' },
      ],
    })

    const messages = useConversationStore.getState().messages
    expect(messages[0]!.steerStatus).toBe('orphaned')
    expect(messages[1]!.steerStatus).toBe('orphaned')
  })

  test('resendOrphanedSteer replaces the orphan with a normal user message and fires agent/run', async () => {
    resetStore()
    useConversationStore.setState({
      currentSessionId: 'sess-r',
      sessions: [
        {
          id: 'sess-r',
          createdAt: '2026-04-25T00:00:00Z',
          lastActive: '2026-04-25T00:00:00Z',
          messageCount: 0,
        },
      ],
      messages: [
        {
          id: 's1',
          role: 'user',
          text: 'do this instead',
          timestamp: '2026-04-25T00:00:00Z',
          kind: 'steer',
          steerStatus: 'orphaned',
          steerRequestId: 'orphan-req',
        },
      ],
    })

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(globalThis as unknown as { window: { ouroboros: unknown } }).window = {
      ouroboros: {
        rpc: (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params })
          return Promise.resolve({})
        },
      },
    }

    useConversationStore.getState().resendOrphanedSteer('orphan-req')
    await Promise.resolve()
    await Promise.resolve()

    const messages = useConversationStore.getState().messages
    expect(messages.find((m) => m.steerRequestId === 'orphan-req')).toBeUndefined()
    expect(messages.some((m) => m.text === 'do this instead' && !m.kind)).toBe(true)

    const runCall = calls.find((c) => c.method === 'agent/run')
    expect(runCall).toBeDefined()
    expect((runCall!.params as Record<string, unknown>).message).toBe('do this instead')
  })

  test('dismissOrphanedSteer removes the bubble without sending anything', () => {
    resetStore()
    useConversationStore.setState({
      messages: [
        {
          id: 's1',
          role: 'user',
          text: 'forget me',
          timestamp: '2026-04-25T00:00:00Z',
          kind: 'steer',
          steerStatus: 'orphaned',
          steerRequestId: 'gone',
        },
      ],
    })
    useConversationStore.getState().dismissOrphanedSteer('gone')
    expect(useConversationStore.getState().messages).toEqual([])
  })

  test('handleTurnAborted clears the streaming state', () => {
    resetStore()
    useConversationStore.setState({
      isAgentRunning: true,
      activeRunSessionId: 'session-q',
      streamingText: 'partial...',
      sessions: [
        {
          id: 'session-q',
          createdAt: '2026-04-25T00:00:00Z',
          lastActive: '2026-04-25T00:00:00Z',
          messageCount: 0,
          runStatus: 'running',
        },
      ],
    })
    useConversationStore
      .getState()
      .handleTurnAborted({ sessionId: 'session-q', iterations: 1, partialText: 'partial...' })
    const state = useConversationStore.getState()
    expect(state.isAgentRunning).toBe(false)
    expect(state.streamingText).toBeNull()
    expect(state.sessions[0]!.runStatus).toBe('idle')
  })
})
