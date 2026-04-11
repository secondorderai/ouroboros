import React, { useMemo } from 'react'
import type { CompletedToolCall, Message, ToolCallState } from '../../shared/protocol'
import { MarkdownRenderer } from './MarkdownRenderer'
import { StreamingCursor } from './StreamingCursor'
import { ToolCallChip } from './ToolCallChip'

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 16,
  padding: '2px 18px 0',
}

const avatarStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: 'var(--accent-amber)',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-inverse)',
  fontSize: 14,
  fontWeight: 700,
  userSelect: 'none',
}

const bodyStyle: React.CSSProperties = {
  minWidth: 0,
  width: 'min(100%, 74ch)',
  maxWidth: 'min(100%, 74ch)',
}

const surfaceStyle: React.CSSProperties = {
  padding: '16px 20px 14px',
  borderRadius: '18px',
  border: '1px solid var(--border-light)',
  background: 'linear-gradient(180deg, var(--bg-chat) 0%, var(--bg-primary) 100%)',
  boxShadow: 'var(--shadow-subtle)',
}

const nameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.4,
  letterSpacing: '0.01em',
  color: 'var(--text-primary)',
  marginBottom: 10,
}

const contentStyle: React.CSSProperties = {
  minWidth: 0,
  width: 'min(100%, 66ch)',
  maxWidth: 'min(100%, 66ch)',
}

const progressStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 11px',
  marginBottom: 14,
  borderRadius: 999,
  background: 'var(--accent-amber-bg)',
  color: 'var(--text-secondary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.3,
}

const progressSpinnerStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '2px solid var(--border-light)',
  borderTopColor: 'var(--accent-amber)',
  animation: 'ob-spin 0.7s linear infinite',
  flexShrink: 0,
}

const toolCallsWrapperStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 14,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completedToState(tc: CompletedToolCall): ToolCallState {
  return {
    id: tc.id,
    toolName: tc.toolName,
    input: tc.input,
    status: tc.error ? 'error' : 'done',
    output: tc.output,
    error: tc.error,
    durationMs: tc.durationMs,
  }
}

function getToolProgressLabel(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Running a command'
    case 'file-read':
      return 'Reading files'
    case 'file-write':
      return 'Creating files'
    case 'file-edit':
      return 'Editing files'
    case 'web-fetch':
      return 'Fetching a page'
    case 'web-search':
      return 'Searching the web'
    case 'memory':
      return 'Checking memory'
    case 'reflect':
      return 'Reflecting on the request'
    case 'crystallize':
      return 'Crystallizing a skill'
    case 'self-test':
      return 'Running tests'
    case 'skill-gen':
      return 'Generating a skill'
    case 'dream':
      return 'Dreaming on it'
    case 'evolution':
      return 'Logging evolution'
    default:
      return 'Working on your request'
  }
}

function getProgressMessage(
  activeToolCalls: ToolCallState[],
  completedToolCalls: CompletedToolCall[],
  text: string,
  isRunning: boolean,
): string {
  if (activeToolCalls.length === 1) {
    return `${getToolProgressLabel(activeToolCalls[0].toolName)}...`
  }

  if (activeToolCalls.length > 1) {
    return `Using ${activeToolCalls.length} tools to work through your request...`
  }

  if (text.trim().length > 0) {
    return 'Writing the response...'
  }

  if (completedToolCalls.length > 0) {
    return completedToolCalls.length === 1
      ? 'Reviewing the latest tool result...'
      : `Reviewing ${completedToolCalls.length} tool results...`
  }

  if (isRunning) {
    return 'Thinking through your request...'
  }

  return 'Wrapping up...'
}

// ---------------------------------------------------------------------------
// Completed agent message
// ---------------------------------------------------------------------------

interface AgentMessageProps {
  message: Message
  expandedToolCallIds?: ReadonlySet<string>
  onToolCallExpandedChange?: (toolCallId: string, expanded: boolean) => void
}

export const AgentMessage: React.FC<AgentMessageProps> = ({
  message,
  expandedToolCallIds,
  onToolCallExpandedChange,
}) => (
  <div
    style={wrapperStyle}
    className='agent-message agent-message--assistant'
    data-testid='agent-message'
  >
    <div style={avatarStyle} aria-label='Ouroboros avatar'>
      O
    </div>
    <div style={bodyStyle}>
      <div
        style={surfaceStyle}
        className='agent-message__surface'
        data-testid='agent-message-surface'
      >
        <div style={nameStyle}>Ouroboros</div>
        <div
          style={contentStyle}
          className='agent-message__content'
          data-testid='agent-message-content'
        >
          <MarkdownRenderer content={message.text} />
        </div>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={toolCallsWrapperStyle}>
            {message.toolCalls.map((tc) => (
              <ToolCallChip
                key={tc.id}
                toolCall={completedToState(tc)}
                expanded={expandedToolCallIds?.has(tc.id)}
                onExpandedChange={(expanded) => onToolCallExpandedChange?.(tc.id, expanded)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// Streaming agent message (in-progress)
// ---------------------------------------------------------------------------

interface StreamingAgentMessageProps {
  text: string
  activeToolCalls: Map<string, ToolCallState>
  completedToolCalls: CompletedToolCall[]
  isRunning: boolean
  expandedToolCallIds?: ReadonlySet<string>
  onToolCallExpandedChange?: (toolCallId: string, expanded: boolean) => void
}

export const StreamingAgentMessage: React.FC<StreamingAgentMessageProps> = ({
  text,
  activeToolCalls,
  completedToolCalls,
  isRunning,
  expandedToolCallIds,
  onToolCallExpandedChange,
}) => {
  const activeEntries = useMemo(() => Array.from(activeToolCalls.values()), [activeToolCalls])
  const visibleToolCalls = useMemo(
    () => [...completedToolCalls.map(completedToState), ...activeEntries],
    [completedToolCalls, activeEntries],
  )
  const progressMessage = useMemo(
    () => getProgressMessage(activeEntries, completedToolCalls, text, isRunning),
    [activeEntries, completedToolCalls, text, isRunning],
  )

  return (
    <div
      style={wrapperStyle}
      className='agent-message agent-message--assistant'
      data-testid='agent-message'
    >
      <div style={avatarStyle} aria-label='Ouroboros avatar'>
        O
      </div>
      <div style={bodyStyle}>
        <div
          style={surfaceStyle}
          className='agent-message__surface'
          data-testid='agent-message-surface'
        >
          <div style={nameStyle}>Ouroboros</div>
          <div
            style={contentStyle}
            className='agent-message__content'
            data-testid='agent-message-content'
          >
            <div style={progressStyle}>
              <span style={progressSpinnerStyle} aria-hidden='true' />
              <span>{progressMessage}</span>
            </div>
            {text.length > 0 && (
              <MarkdownRenderer content={text} trailingContent={<StreamingCursor />} />
            )}
          </div>
          {visibleToolCalls.length > 0 && (
            <div style={toolCallsWrapperStyle}>
              {visibleToolCalls.map((tc) => (
                <ToolCallChip
                  key={tc.id}
                  toolCall={tc}
                  expanded={expandedToolCallIds?.has(tc.id)}
                  onExpandedChange={(expanded) => onToolCallExpandedChange?.(tc.id, expanded)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
