import { create } from 'zustand'
import type {
  Message,
  ImageAttachment,
  ToolCallState,
  CompletedToolCall,
  AgentTextParams,
  AgentContextUsageParams,
  AgentToolCallStartParams,
  AgentToolCallEndParams,
  AgentTurnCompleteParams,
  AgentErrorParams,
  SessionInfo,
  SessionMessage,
} from '../../shared/protocol'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface ConversationState {
  /** Ordered list of completed messages in the current conversation. */
  messages: Message[]

  /** Text being streamed for the current agent turn (null when idle). */
  streamingText: string | null

  /** Tool calls currently in progress during the active agent turn. */
  activeToolCalls: Map<string, ToolCallState>

  /** Completed tool calls accumulated during the current agent turn. */
  pendingToolCalls: CompletedToolCall[]

  /** Whether the agent is currently executing a turn. */
  isAgentRunning: boolean

  /** Session currently owning the active agent run, if any. */
  activeRunSessionId: string | null

  /** ID counter for generating unique message IDs. */
  nextId: number

  /** Current session ID (null when no session is active). */
  currentSessionId: string | null

  /** List of all sessions for the sidebar. */
  sessions: SessionInfo[]

  /** Current workspace path. */
  workspace: string | null

  /** Current model name. */
  modelName: string | null

  /** Current estimated context usage for the active conversation. */
  contextUsage: AgentContextUsageParams | null

  // -- Actions ---------------------------------------------------------------

  /** User sends a message. Adds the message to the list and marks agent as running. */
  sendMessage: (text: string, files?: string[], images?: ImageAttachment[]) => void

  /** Cancel the current agent run. */
  cancelRun: () => void

  /** Handle an incoming `agent/text` notification. */
  handleAgentText: (params: AgentTextParams) => void

  /** Handle an incoming `agent/contextUsage` notification. */
  handleContextUsage: (params: AgentContextUsageParams) => void

  /** Handle an incoming `agent/toolCallStart` notification. */
  handleToolCallStart: (params: AgentToolCallStartParams) => void

  /** Handle an incoming `agent/toolCallEnd` notification. */
  handleToolCallEnd: (params: AgentToolCallEndParams) => void

  /** Handle an incoming `agent/turnComplete` notification. */
  handleTurnComplete: (params: AgentTurnCompleteParams) => void

  /** Handle an incoming `agent/error` notification. */
  handleAgentError: (params: AgentErrorParams) => void

  /** Reset the conversation (e.g., when switching sessions). */
  resetConversation: () => void

  /** Set the list of sessions from the sidebar. */
  setSessions: (sessions: SessionInfo[]) => void

  /** Set the current session ID. */
  setCurrentSessionId: (id: string | null) => void

  /** Load a session's messages into the chat. */
  loadSession: (id: string, messages: SessionMessage[], workspacePath?: string | null) => void

  /** Create a new session and make it active. */
  createNewSession: (sessionId: string) => void

  /** Delete a session from the list. */
  deleteSession: (id: string) => void

  /** Set the workspace path. */
  setWorkspace: (path: string | null) => void

  /** Set the model name. */
  setModelName: (name: string | null) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string, n: number): string {
  return `${prefix}-${n}`
}

function toSentenceCase(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function finalizeSessionTitle(input: string): string {
  const maxChars = 42
  const words = input.split(/\s+/).filter(Boolean)
  const limitedWords = words.slice(0, 6).join(' ')
  const candidate =
    limitedWords.length > maxChars
      ? limitedWords.slice(0, maxChars).replace(/\s+\S*$/, '')
      : limitedWords

  return candidate || 'New conversation'
}

function deriveSessionTitle(input: string): string {
  let text = input.trim().replace(/\s+/g, ' ')
  if (!text) return 'New conversation'

  text = text
    .replace(/^(?:[#>*-]+\s*)+/, '')
    .replace(/^(?:\/[\w-]+\s+)+/i, '')
    .replace(/^without web search,?\s*/i, '')
    .replace(/^(?:plan|task|question)\s+/i, '')

  const matchers: Array<[RegExp, (...matches: string[]) => string]> = [
    [/^create (?:a )?plan to (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^plan for (.+)$/i, (subject) => `${toSentenceCase(subject)} plan`],
    [/^what are the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [/^what is the best (.+)$/i, (subject) => `Best ${subject.trim()}`],
    [
      /^what materials are good for use in (.+)$/i,
      (subject) => `${toSentenceCase(subject)} materials`,
    ],
    [/^what materials are good for (.+)$/i, (subject) => `${toSentenceCase(subject)} materials`],
    [/^how to (.+)$/i, (subject) => toSentenceCase(subject)],
  ]

  for (const [pattern, formatter] of matchers) {
    const match = text.match(pattern)
    if (match) {
      return finalizeSessionTitle(
        formatter(...match.slice(1))
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
  }

  text = text
    .replace(/^(?:can you|could you|would you|please|help me|i need to)\s+/i, '')
    .replace(/\bto follow\b/gi, '')
    .replace(/\s+(?:and|or)\s+/gi, ' / ')
    .trim()

  return finalizeSessionTitle(toSentenceCase(text))
}

export function normalizeTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''

  if (Array.isArray(value)) {
    const text = value
      .map((item) => normalizeTextContent(item))
      .filter(Boolean)
      .join('')
    if (text) return text
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>

    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    if (typeof record.message === 'string') return record.message
    if (typeof record.value === 'string') return record.value

    if (typeof record.type === 'string') {
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      if (record.type === 'text' && typeof record.value === 'string') return record.value
    }

    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) => normalizeTextContent(item))
        .filter(Boolean)
        .join('')
      if (text) return text
    }

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  return String(value)
}

export function normalizeToolName(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (typeof value === 'object' && value != null) {
    const record = value as Record<string, unknown>
    const candidate = record.toolName ?? record.name ?? record.id ?? record.type
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }

  const fallback = normalizeTextContent(value).trim()
  return fallback || 'unknown'
}

function stripImagePreviewData(image: ImageAttachment): ImageAttachment {
  const { previewDataUrl: _previewDataUrl, ...metadata } = image
  return metadata
}

type StoreSet = (
  partial: Partial<ConversationState> | ((state: ConversationState) => Partial<ConversationState>),
) => void

type StoreGet = () => ConversationState

/**
 * Re-read image bytes off disk so messages loaded from a persisted session can
 * render their previews again — the transcript only stores path/metadata.
 */
function hydrateLoadedImagePreviews(
  sessionId: string,
  messages: Message[],
  set: StoreSet,
  get: StoreGet,
): void {
  const paths = Array.from(
    new Set(
      messages.flatMap((m) =>
        (m.imageAttachments ?? []).filter((img) => !img.previewDataUrl).map((img) => img.path),
      ),
    ),
  )
  if (paths.length === 0) return
  const api = typeof window !== 'undefined' ? window.ouroboros : undefined
  if (!api?.validateImageAttachments) return

  api
    .validateImageAttachments(paths)
    .then((result) => {
      if (result.accepted.length === 0) return
      const previewByPath = new Map(
        result.accepted
          .filter((img): img is ImageAttachment & { previewDataUrl: string } =>
            Boolean(img.previewDataUrl),
          )
          .map((img) => [img.path, img.previewDataUrl]),
      )
      if (previewByPath.size === 0) return
      if (get().currentSessionId !== sessionId) return

      set((state) => {
        if (state.currentSessionId !== sessionId) return state
        let anyChanged = false
        const next = state.messages.map((msg) => {
          if (!msg.imageAttachments?.length) return msg
          let changed = false
          const hydrated = msg.imageAttachments.map((img) => {
            if (img.previewDataUrl) return img
            const preview = previewByPath.get(img.path)
            if (!preview) return img
            changed = true
            return { ...img, previewDataUrl: preview }
          })
          if (!changed) return msg
          anyChanged = true
          return { ...msg, imageAttachments: hydrated }
        })
        return anyChanged ? { messages: next } : state
      })
    })
    .catch((err) => {
      console.error('validateImageAttachments (session load) failed:', err)
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationStore = create<ConversationState>((set, get) => ({
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

  // ---- Actions -------------------------------------------------------------

  sendMessage(text: string, files?: string[], images?: ImageAttachment[]) {
    const state = get()
    const runSessionId = state.currentSessionId
    const id = makeId('user', state.nextId)
    const userMessage: Message = {
      id,
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
      files,
      imageAttachments: images,
    }

    set({
      messages: [...state.messages, userMessage],
      isAgentRunning: true,
      activeRunSessionId: runSessionId,
      streamingText: '',
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
      contextUsage: null,
      sessions: runSessionId
        ? state.sessions.map((s) =>
            s.id === runSessionId
              ? {
                  ...s,
                  runStatus: 'running' as const,
                  activeToolName: undefined,
                  lastActive: new Date().toISOString(),
                }
              : s,
          )
        : state.sessions,
    })

    // Fire-and-forget RPC call to start the agent run.
    // The IPC bridge (window.ouroboros) may not be available in unit tests.
    window.ouroboros
      ?.rpc('agent/run', {
        message: text,
        files,
        images: images?.map(stripImagePreviewData),
        client: 'desktop',
        responseStyle: 'desktop-readable',
      })
      .catch((err) => {
        console.error('agent/run RPC failed:', err)
        get().handleAgentError({ message: String(err) })
      })
  },

  cancelRun() {
    const state = get()
    if (!state.isAgentRunning) return

    // Finalize whatever text we have so far as an agent message.
    const finalText = state.streamingText ?? ''
    const messages = [...state.messages]

    if (finalText.length > 0) {
      messages.push({
        id: makeId('agent', state.nextId),
        role: 'agent',
        text: finalText,
        timestamp: new Date().toISOString(),
        toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
      })
    }

    set({
      messages,
      isAgentRunning: false,
      activeRunSessionId: null,
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
      contextUsage: null,
      sessions: state.activeRunSessionId
        ? state.sessions.map((s) =>
            s.id === state.activeRunSessionId
              ? { ...s, runStatus: 'idle' as const, activeToolName: undefined }
              : s,
          )
        : state.sessions,
    })

    window.ouroboros?.rpc('agent/cancel', {}).catch((err) => {
      console.error('agent/cancel RPC failed:', err)
    })
  },

  handleAgentText(params: AgentTextParams) {
    const state = get()
    if (state.activeRunSessionId && state.currentSessionId !== state.activeRunSessionId) {
      return
    }
    set((state) => ({
      streamingText: (state.streamingText ?? '') + normalizeTextContent(params.text),
    }))
  },

  handleContextUsage(params: AgentContextUsageParams) {
    const state = get()
    if (state.activeRunSessionId && state.currentSessionId !== state.activeRunSessionId) {
      return
    }
    set({ contextUsage: params })
  },

  handleToolCallStart(params: AgentToolCallStartParams) {
    set((state) => {
      const toolName = normalizeToolName(params.toolName)
      const next = new Map(state.activeToolCalls)
      next.set(params.toolCallId, {
        id: params.toolCallId,
        toolName,
        input: params.input,
        status: 'running',
      })
      const sessions = state.activeRunSessionId
        ? state.sessions.map((s) =>
            s.id === state.activeRunSessionId
              ? { ...s, runStatus: 'running' as const, activeToolName: toolName }
              : s,
          )
        : state.sessions
      if (state.activeRunSessionId && state.currentSessionId !== state.activeRunSessionId) {
        return { sessions }
      }
      return { activeToolCalls: next, sessions }
    })
  },

  handleToolCallEnd(params: AgentToolCallEndParams) {
    set((state) => {
      const next = new Map(state.activeToolCalls)
      const existing = next.get(params.toolCallId)
      if (existing) {
        next.delete(params.toolCallId)
      }

      const completed: CompletedToolCall = {
        id: params.toolCallId,
        toolName: normalizeToolName(params.toolName ?? existing?.toolName),
        input: existing?.input,
        output: params.result,
        error: params.isError ? normalizeTextContent(params.result) : undefined,
      }

      const sessions = state.activeRunSessionId
        ? state.sessions.map((s) =>
            s.id === state.activeRunSessionId ? { ...s, activeToolName: undefined } : s,
          )
        : state.sessions

      if (state.activeRunSessionId && state.currentSessionId !== state.activeRunSessionId) {
        return { sessions }
      }

      return {
        activeToolCalls: next,
        pendingToolCalls: [...state.pendingToolCalls, completed],
        sessions,
      }
    })
  },

  handleTurnComplete(params: AgentTurnCompleteParams) {
    const state = get()
    const completedSessionId = state.activeRunSessionId
    if (completedSessionId && state.currentSessionId !== completedSessionId) {
      set({
        isAgentRunning: false,
        activeRunSessionId: null,
        streamingText: null,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        contextUsage: null,
        sessions: state.sessions.map((s) =>
          s.id === completedSessionId
            ? {
                ...s,
                runStatus: 'idle' as const,
                activeToolName: undefined,
                lastActive: new Date().toISOString(),
              }
            : s,
        ),
      })
      return
    }

    const agentMessage: Message = {
      id: makeId('agent', state.nextId),
      role: 'agent',
      text: normalizeTextContent(params.text),
      timestamp: new Date().toISOString(),
      toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
    }

    const newMessages = [...state.messages, agentMessage]

    // Update the session in the sidebar if there's an active session
    let updatedSessions = state.sessions
    if (state.currentSessionId) {
      updatedSessions = state.sessions.map((s) => {
        if (s.id !== state.currentSessionId) return s
        // Set title from first user message if not already set or still default
        let title = s.title
        if (!title || title === 'New conversation') {
          const firstUserMsg = newMessages.find((m) => m.role === 'user')
          if (firstUserMsg) {
            title = deriveSessionTitle(firstUserMsg.text)
          }
        }
        return {
          ...s,
          title,
          messageCount: newMessages.length,
          lastActive: new Date().toISOString(),
          runStatus: 'idle',
          activeToolName: undefined,
        }
      })
    }

    set({
      messages: newMessages,
      streamingText: null,
      isAgentRunning: false,
      activeRunSessionId: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
      sessions: updatedSessions,
    })
  },

  handleAgentError(params: AgentErrorParams) {
    const state = get()
    const failedSessionId = state.activeRunSessionId
    if (failedSessionId && state.currentSessionId !== failedSessionId) {
      set({
        isAgentRunning: false,
        activeRunSessionId: null,
        streamingText: null,
        activeToolCalls: new Map(),
        pendingToolCalls: [],
        contextUsage: null,
        sessions: state.sessions.map((s) =>
          s.id === failedSessionId
            ? { ...s, runStatus: 'error' as const, activeToolName: undefined }
            : s,
        ),
      })
      return
    }

    const errorMessage: Message = {
      id: makeId('error', state.nextId),
      role: 'error',
      text: normalizeTextContent(params.message),
      timestamp: new Date().toISOString(),
    }

    // Finalize any in-progress streaming text as well.
    const messages = [...state.messages]
    const streamText = state.streamingText
    if (streamText && streamText.length > 0) {
      messages.push({
        id: makeId('agent', state.nextId),
        role: 'agent',
        text: streamText,
        timestamp: new Date().toISOString(),
        toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
      })
    }
    messages.push(errorMessage)

    set({
      messages,
      streamingText: null,
      isAgentRunning: false,
      activeRunSessionId: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 2,
      contextUsage: null,
      sessions: failedSessionId
        ? state.sessions.map((s) =>
            s.id === failedSessionId
              ? { ...s, runStatus: 'error' as const, activeToolName: undefined }
              : s,
          )
        : state.sessions,
    })
  },

  resetConversation() {
    set({
      messages: [],
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      isAgentRunning: false,
      activeRunSessionId: null,
      nextId: 1,
      currentSessionId: null,
      contextUsage: null,
    })
  },

  setSessions(sessions: SessionInfo[]) {
    set((state) => ({
      sessions: sessions.map((session) => {
        const existing = state.sessions.find((s) => s.id === session.id)
        if (existing?.runStatus === 'running' || state.activeRunSessionId === session.id) {
          return {
            ...session,
            runStatus: 'running',
            activeToolName: existing?.activeToolName,
          }
        }
        if (existing?.runStatus === 'error') {
          return { ...session, runStatus: 'error' }
        }
        return session
      }),
    }))
  },

  setCurrentSessionId(id: string | null) {
    set({ currentSessionId: id })
  },

  loadSession(id: string, sessionMessages: SessionMessage[], workspacePath?: string | null) {
    const state = get()
    const messages: Message[] = sessionMessages.map((m, i) => ({
      id: makeId(m.role === 'user' ? 'user' : 'agent', i + 1),
      role: m.role === 'user' ? ('user' as const) : ('agent' as const),
      text: normalizeTextContent(m.content),
      timestamp: m.timestamp,
      imageAttachments: m.imageAttachments,
      ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
        ? { toolCalls: m.toolCalls }
        : {}),
    }))

    set({
      messages,
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      isAgentRunning: state.activeRunSessionId === id,
      nextId: messages.length + 1,
      currentSessionId: id,
      contextUsage: null,
      ...(workspacePath ? { workspace: workspacePath } : {}),
    })

    hydrateLoadedImagePreviews(id, messages, set, get)
  },

  createNewSession(sessionId: string) {
    const state = get()
    const newSession: SessionInfo = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      messageCount: 0,
      title: 'New conversation',
    }

    set({
      messages: [],
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      isAgentRunning: false,
      activeRunSessionId: state.activeRunSessionId,
      nextId: 1,
      currentSessionId: sessionId,
      sessions: [newSession, ...state.sessions],
      contextUsage: null,
    })
  },

  deleteSession(id: string) {
    const state = get()
    const newSessions = state.sessions.filter((s) => s.id !== id)
    const updates: Partial<ConversationState> = { sessions: newSessions }

    if (state.activeRunSessionId === id) {
      updates.activeRunSessionId = null
      updates.isAgentRunning = false
      updates.streamingText = null
      updates.activeToolCalls = new Map()
      updates.pendingToolCalls = []
      updates.contextUsage = null
    }

    // If we're deleting the active session, clear the chat
    if (state.currentSessionId === id) {
      updates.messages = []
      updates.streamingText = null
      updates.activeToolCalls = new Map()
      updates.pendingToolCalls = []
      updates.isAgentRunning = false
      updates.activeRunSessionId = null
      updates.nextId = 1
      updates.currentSessionId = null
      updates.contextUsage = null
    }

    set(updates as ConversationState)
  },

  setWorkspace(path: string | null) {
    set({ workspace: path })
  },

  setModelName(name: string | null) {
    set({ modelName: name })
  },
}))
