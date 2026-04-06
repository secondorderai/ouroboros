import React from 'react';
import type { Message } from '../../shared/protocol';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '0 16px',
};

const baseChipStyle: React.CSSProperties = {
  maxWidth: '80%',
  padding: '8px 16px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1.5,
  textAlign: 'center',
  wordBreak: 'break-word',
};

const systemStyle: React.CSSProperties = {
  ...baseChipStyle,
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
};

const errorStyle: React.CSSProperties = {
  ...baseChipStyle,
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--accent-red)',
  border: '1px solid rgba(220, 38, 38, 0.2)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SystemMessageProps {
  message: Message;
}

export const SystemMessage: React.FC<SystemMessageProps> = ({ message }) => (
  <div style={wrapperStyle}>
    <div style={message.role === 'error' ? errorStyle : systemStyle}>
      {message.text}
    </div>
  </div>
);
