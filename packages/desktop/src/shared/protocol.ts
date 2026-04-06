/**
 * JSON-RPC protocol types for Ouroboros desktop <-> CLI communication.
 *
 * These types are shared between the Electron main process and the renderer.
 * Only the subset needed for the chat message list is defined here; the full
 * set will be filled in by ticket 03 (IPC bridge).
 */

// ---------------------------------------------------------------------------
// Base JSON-RPC
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Notification payloads (CLI -> renderer)
// ---------------------------------------------------------------------------

export interface AgentTextParams {
  /** Incremental text chunk from the agent. */
  text: string;
}

export interface AgentToolCallStartParams {
  id: string;
  toolName: string;
  input?: unknown;
}

export interface AgentToolCallEndParams {
  id: string;
  toolName: string;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface AgentTurnCompleteParams {
  /** The full text of the agent's response once streaming is done. */
  fullText: string;
}

export interface AgentErrorParams {
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Notification channel map
// ---------------------------------------------------------------------------

export interface NotificationMap {
  'agent/text': AgentTextParams;
  'agent/toolCallStart': AgentToolCallStartParams;
  'agent/toolCallEnd': AgentToolCallEndParams;
  'agent/turnComplete': AgentTurnCompleteParams;
  'agent/error': AgentErrorParams;
}

// ---------------------------------------------------------------------------
// RPC request helpers
// ---------------------------------------------------------------------------

export interface AgentRunParams {
  message: string;
  files?: string[];
}

export interface AgentCancelParams {
  id?: string;
}

// ---------------------------------------------------------------------------
// Preload API surface (exposed via contextBridge as window.ouroboros)
// ---------------------------------------------------------------------------

export interface OuroborosAPI {
  rpc(method: string, params?: unknown): Promise<unknown>;
  onNotification(
    channel: string,
    callback: (params: unknown) => void,
  ): () => void;
  showOpenDialog(options: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  getTheme(): Promise<'light' | 'dark'>;
  setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>;
  getPlatform(): 'darwin' | 'win32' | 'linux';
  onCLIStatus(
    callback: (status: 'starting' | 'ready' | 'error' | 'restarting') => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Message types for the conversation store
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'agent' | 'system' | 'error';

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Attached file paths (user messages only). */
  files?: string[];
  /** Completed tool calls that appeared during this agent turn. */
  toolCalls?: CompletedToolCall[];
}

export interface CompletedToolCall {
  id: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ToolCallState {
  id: string;
  toolName: string;
  input?: unknown;
  status: 'running' | 'done' | 'error';
  output?: unknown;
  error?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Global type augmentation so TS knows about window.ouroboros
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    ouroboros?: OuroborosAPI;
  }
}
