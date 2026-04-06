import React, { useCallback, useRef, useState } from 'react';
import { useConversationStore } from '../stores/conversationStore';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const barStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border-light)',
  background: 'var(--bg-input)',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'var(--font-sans)',
  fontSize: 15,
  fontWeight: 400,
  lineHeight: 1.6,
  color: 'var(--text-primary)',
  padding: 0,
  maxHeight: 120, // ~5 lines
  overflow: 'auto',
};

const sendBtnStyle: React.CSSProperties = {
  background: 'var(--accent-amber)',
  color: 'var(--text-inverse)',
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const cancelBtnStyle: React.CSSProperties = {
  ...sendBtnStyle,
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-light)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const InputBar: React.FC = () => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAgentRunning = useConversationStore((s) => s.isAgentRunning);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const cancelRun = useConversationStore((s) => s.cancelRun);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText('');
    // Reset textarea height.
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize textarea.
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, []);

  return (
    <div style={barStyle}>
      <textarea
        ref={textareaRef}
        style={textareaStyle}
        value={text}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        rows={1}
        disabled={isAgentRunning}
      />
      {isAgentRunning ? (
        <button
          type="button"
          style={cancelBtnStyle}
          onClick={cancelRun}
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          style={{
            ...sendBtnStyle,
            opacity: text.trim() ? 1 : 0.5,
            cursor: text.trim() ? 'pointer' : 'default',
          }}
          onClick={handleSend}
          disabled={!text.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
};
