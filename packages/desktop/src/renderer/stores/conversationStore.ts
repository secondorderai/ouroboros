import { create } from 'zustand';
import type {
  Message,
  ToolCallState,
  CompletedToolCall,
  AgentTextParams,
  AgentToolCallStartParams,
  AgentToolCallEndParams,
  AgentTurnCompleteParams,
  AgentErrorParams,
} from '../../shared/protocol';

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface ConversationState {
  /** Ordered list of completed messages in the current conversation. */
  messages: Message[];

  /** Text being streamed for the current agent turn (null when idle). */
  streamingText: string | null;

  /** Tool calls currently in progress during the active agent turn. */
  activeToolCalls: Map<string, ToolCallState>;

  /** Completed tool calls accumulated during the current agent turn. */
  pendingToolCalls: CompletedToolCall[];

  /** Whether the agent is currently executing a turn. */
  isAgentRunning: boolean;

  /** ID counter for generating unique message IDs. */
  nextId: number;

  // -- Actions ---------------------------------------------------------------

  /** User sends a message. Adds the message to the list and marks agent as running. */
  sendMessage: (text: string, files?: string[]) => void;

  /** Cancel the current agent run. */
  cancelRun: () => void;

  /** Handle an incoming `agent/text` notification. */
  handleAgentText: (params: AgentTextParams) => void;

  /** Handle an incoming `agent/toolCallStart` notification. */
  handleToolCallStart: (params: AgentToolCallStartParams) => void;

  /** Handle an incoming `agent/toolCallEnd` notification. */
  handleToolCallEnd: (params: AgentToolCallEndParams) => void;

  /** Handle an incoming `agent/turnComplete` notification. */
  handleTurnComplete: (params: AgentTurnCompleteParams) => void;

  /** Handle an incoming `agent/error` notification. */
  handleAgentError: (params: AgentErrorParams) => void;

  /** Reset the conversation (e.g., when switching sessions). */
  resetConversation: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(prefix: string, n: number): string {
  return `${prefix}-${n}`;
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
  nextId: 1,

  // ---- Actions -------------------------------------------------------------

  sendMessage(text: string, files?: string[]) {
    const state = get();
    const id = makeId('user', state.nextId);
    const userMessage: Message = {
      id,
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
      files,
    };

    set({
      messages: [...state.messages, userMessage],
      isAgentRunning: true,
      streamingText: '',
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
    });

    // Fire-and-forget RPC call to start the agent run.
    // The IPC bridge (window.ouroboros) may not be available in unit tests.
    window.ouroboros?.rpc('agent/run', { message: text, files }).catch((err) => {
      console.error('agent/run RPC failed:', err);
      get().handleAgentError({ message: String(err) });
    });
  },

  cancelRun() {
    const state = get();
    if (!state.isAgentRunning) return;

    // Finalize whatever text we have so far as an agent message.
    const finalText = state.streamingText ?? '';
    const messages = [...state.messages];

    if (finalText.length > 0) {
      messages.push({
        id: makeId('agent', state.nextId),
        role: 'agent',
        text: finalText,
        timestamp: new Date().toISOString(),
        toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
      });
    }

    set({
      messages,
      isAgentRunning: false,
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
    });

    window.ouroboros?.rpc('agent/cancel', {}).catch((err) => {
      console.error('agent/cancel RPC failed:', err);
    });
  },

  handleAgentText(params: AgentTextParams) {
    set((state) => ({
      streamingText: (state.streamingText ?? '') + params.text,
    }));
  },

  handleToolCallStart(params: AgentToolCallStartParams) {
    set((state) => {
      const next = new Map(state.activeToolCalls);
      next.set(params.id, {
        id: params.id,
        toolName: params.toolName,
        input: params.input,
        status: 'running',
      });
      return { activeToolCalls: next };
    });
  },

  handleToolCallEnd(params: AgentToolCallEndParams) {
    set((state) => {
      const next = new Map(state.activeToolCalls);
      const existing = next.get(params.id);
      if (existing) {
        next.delete(params.id);
      }

      const completed: CompletedToolCall = {
        id: params.id,
        toolName: params.toolName ?? existing?.toolName ?? 'unknown',
        input: existing?.input,
        output: params.output,
        error: params.error,
        durationMs: params.durationMs,
      };

      return {
        activeToolCalls: next,
        pendingToolCalls: [...state.pendingToolCalls, completed],
      };
    });
  },

  handleTurnComplete(params: AgentTurnCompleteParams) {
    const state = get();
    const agentMessage: Message = {
      id: makeId('agent', state.nextId),
      role: 'agent',
      text: params.fullText,
      timestamp: new Date().toISOString(),
      toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
    };

    set({
      messages: [...state.messages, agentMessage],
      streamingText: null,
      isAgentRunning: false,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 1,
    });
  },

  handleAgentError(params: AgentErrorParams) {
    const state = get();
    const errorMessage: Message = {
      id: makeId('error', state.nextId),
      role: 'error',
      text: params.message,
      timestamp: new Date().toISOString(),
    };

    // Finalize any in-progress streaming text as well.
    const messages = [...state.messages];
    const streamText = state.streamingText;
    if (streamText && streamText.length > 0) {
      messages.push({
        id: makeId('agent', state.nextId),
        role: 'agent',
        text: streamText,
        timestamp: new Date().toISOString(),
        toolCalls: state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined,
      });
    }
    messages.push(errorMessage);

    set({
      messages,
      streamingText: null,
      isAgentRunning: false,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      nextId: state.nextId + 2,
    });
  },

  resetConversation() {
    set({
      messages: [],
      streamingText: null,
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      isAgentRunning: false,
      nextId: 1,
    });
  },
}));
