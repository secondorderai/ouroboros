import React from 'react';
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
}

export const StreamingAgentMessage: React.FC<StreamingAgentMessageProps> = ({
  text,
  activeToolCalls,
}) => {
  const activeEntries = Array.from(activeToolCalls.values());

  return (
    <div style={wrapperStyle}>
      <div style={avatarStyle} aria-label="Ouroboros avatar">O</div>
      <div style={bodyStyle}>
        <div style={nameStyle}>Ouroboros</div>
        <div style={textStyle}>
          {text}
          <StreamingCursor />
        </div>
        {activeEntries.length > 0 && (
          <div style={toolCallsWrapperStyle}>
            {activeEntries.map((tc) => (
              <ToolCallChip key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
