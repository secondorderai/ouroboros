import React, { useMemo } from 'react';
import type { Message, ToolCallState, CompletedToolCall } from '../../shared/protocol';
import { StreamingCursor } from './StreamingCursor';
import { ToolCallChip } from './ToolCallChip';
import { MarkdownRenderer } from './MarkdownRenderer';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '0 16px',
};

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
};

const bodyStyle: React.CSSProperties = {
  maxWidth: 'min(80%, 720px)',
  minWidth: 0,
};

const nameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.5,
  color: 'var(--text-primary)',
  marginBottom: 4,
};

const progressStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  marginBottom: 10,
  borderRadius: 999,
  background: 'var(--accent-amber-bg)',
  color: 'var(--text-secondary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.3,
};

const progressSpinnerStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '2px solid var(--border-light)',
  borderTopColor: 'var(--accent-amber)',
  animation: 'ob-spin 0.7s linear infinite',
  flexShrink: 0,
};

const textStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 400,
  lineHeight: 1.6,
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const toolCallsWrapperStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 8,
};

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
      return 'Running a command';
    case 'file-read':
      return 'Reading files';
    case 'file-write':
      return 'Creating files';
    case 'file-edit':
      return 'Editing files';
    case 'web-fetch':
      return 'Fetching a page';
    case 'web-search':
      return 'Searching the web';
    case 'memory':
      return 'Checking memory';
    case 'reflect':
      return 'Reflecting on the request';
    case 'crystallize':
      return 'Crystallizing a skill';
    case 'self-test':
      return 'Running tests';
    case 'skill-gen':
      return 'Generating a skill';
    case 'dream':
      return 'Dreaming on it';
    case 'evolution':
      return 'Logging evolution';
    default:
      return 'Working on your request';
  }
}

function getProgressMessage(
  activeToolCalls: ToolCallState[],
  completedToolCalls: CompletedToolCall[],
  text: string,
  isRunning: boolean,
): string {
  if (activeToolCalls.length === 1) {
    return `${getToolProgressLabel(activeToolCalls[0].toolName)}...`;
  }

  if (activeToolCalls.length > 1) {
    return `Using ${activeToolCalls.length} tools to work through your request...`;
  }

  if (text.trim().length > 0) {
    return 'Writing the response...';
  }

  if (completedToolCalls.length > 0) {
    return completedToolCalls.length === 1
      ? 'Reviewing the latest tool result...'
      : `Reviewing ${completedToolCalls.length} tool results...`;
  }

  if (isRunning) {
    return 'Thinking through your request...';
  }

  return 'Wrapping up...';
}

// ---------------------------------------------------------------------------
// Completed agent message
// ---------------------------------------------------------------------------

interface AgentMessageProps {
  message: Message;
}

export const AgentMessage: React.FC<AgentMessageProps> = ({ message }) => (
  <div style={wrapperStyle}>
    <div style={avatarStyle} aria-label="Ouroboros avatar">O</div>
    <div style={bodyStyle}>
      <div style={nameStyle}>Ouroboros</div>
      <MarkdownRenderer content={message.text} />
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div style={toolCallsWrapperStyle}>
          {message.toolCalls.map((tc) => (
            <ToolCallChip key={tc.id} toolCall={completedToState(tc)} />
          ))}
        </div>
      )}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Streaming agent message (in-progress)
// ---------------------------------------------------------------------------

interface StreamingAgentMessageProps {
  text: string;
  activeToolCalls: Map<string, ToolCallState>;
  completedToolCalls: CompletedToolCall[];
  isRunning: boolean;
}

export const StreamingAgentMessage: React.FC<StreamingAgentMessageProps> = ({
  text,
  activeToolCalls,
  completedToolCalls,
  isRunning,
}) => {
  const activeEntries = useMemo(() => Array.from(activeToolCalls.values()), [activeToolCalls]);
  const visibleToolCalls = useMemo(
    () => [
      ...completedToolCalls.map(completedToState),
      ...activeEntries,
    ],
    [completedToolCalls, activeEntries],
  );
  const progressMessage = useMemo(
    () => getProgressMessage(activeEntries, completedToolCalls, text, isRunning),
    [activeEntries, completedToolCalls, text, isRunning],
  );

  return (
    <div style={wrapperStyle}>
      <div style={avatarStyle} aria-label="Ouroboros avatar">O</div>
      <div style={bodyStyle}>
        <div style={nameStyle}>Ouroboros</div>
        <div style={progressStyle}>
          <span style={progressSpinnerStyle} aria-hidden="true" />
          <span>{progressMessage}</span>
        </div>
        {text.length > 0 && (
          <div style={textStyle}>
            {text}
            <StreamingCursor />
          </div>
        )}
        {visibleToolCalls.length > 0 && (
          <div style={toolCallsWrapperStyle}>
            {visibleToolCalls.map((tc) => (
              <ToolCallChip key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
