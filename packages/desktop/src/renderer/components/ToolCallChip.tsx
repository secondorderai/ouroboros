import React from 'react';
import type { ToolCallState, CompletedToolCall } from '../../shared/protocol';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  background: 'var(--bg-tool-chip)',
  border: '1px solid var(--border-light)',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  cursor: 'default',
  margin: '4px 0',
};

const statusDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ActiveChipProps {
  toolCall: ToolCallState;
}

/**
 * Stub tool call chip for an in-progress tool call.
 * Ticket 06 will replace this with a full expandable component.
 */
export const ActiveToolCallChip: React.FC<ActiveChipProps> = ({ toolCall }) => {
  const dotColor =
    toolCall.status === 'running'
      ? 'var(--accent-amber)'
      : toolCall.status === 'done'
        ? 'var(--accent-green)'
        : 'var(--accent-red)';

  return (
    <span style={chipStyle}>
      <span style={{ ...statusDot, background: dotColor }} />
      {toolCall.toolName}
    </span>
  );
};

interface CompletedChipProps {
  toolCall: CompletedToolCall;
}

/**
 * Stub tool call chip for a completed tool call.
 */
export const CompletedToolCallChip: React.FC<CompletedChipProps> = ({ toolCall }) => {
  const dotColor = toolCall.error ? 'var(--accent-red)' : 'var(--accent-green)';

  return (
    <span style={chipStyle}>
      <span style={{ ...statusDot, background: dotColor }} />
      {toolCall.toolName}
      {toolCall.durationMs != null && (
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
          {(toolCall.durationMs / 1000).toFixed(1)}s
        </span>
      )}
    </span>
  );
};
