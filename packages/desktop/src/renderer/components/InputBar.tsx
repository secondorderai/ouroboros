import React from 'react'

export function InputBar(): React.ReactElement {
  return (
    <div style={styles.container} className="no-select">
      <div style={styles.inputWrapper}>
        <input
          type="text"
          style={styles.input}
          placeholder="Message Ouroboros..."
          disabled
          aria-label="Message input"
        />
        <button style={styles.sendButton} disabled aria-label="Send message">
          <SendIcon />
        </button>
      </div>
    </div>
  )
}

function SendIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderTop: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    padding: '12px 16px',
    flexShrink: 0
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'var(--bg-input)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
    padding: '8px 12px'
  },
  input: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    fontSize: 15,
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    lineHeight: 1.6,
    color: 'var(--text-primary)',
    outline: 'none'
  },
  sendButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
    flexShrink: 0,
    opacity: 0.5
  }
}
