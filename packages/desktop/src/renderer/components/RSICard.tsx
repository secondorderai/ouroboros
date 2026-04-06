import React from 'react'
import type { RSICrystallizationEvent } from '../hooks/useRSI'

interface RSICardProps {
  event: RSICrystallizationEvent
  onDismiss: (id: string) => void
}

export function RSICard({ event, onDismiss }: RSICardProps): React.ReactElement | null {
  if (event.dismissed) return null

  return (
    <div style={styles.card}>
      <div style={styles.textContainer}>
        <span style={styles.text}>
          Learned a new skill: <code style={styles.skillName}>{event.skillName}</code>
        </span>
      </div>
      <button
        style={styles.dismissButton}
        onClick={() => onDismiss(event.id)}
        aria-label="Dismiss notification"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--bg-rsi-card)',
    borderLeft: '3px solid var(--accent-amber)',
    borderRadius: 'var(--radius-comfortable)',
    padding: '12px 16px',
    margin: '8px 16px'
  },
  textContainer: {
    flex: 1
  },
  text: {
    fontSize: 14,
    color: 'var(--text-primary)',
    lineHeight: 1.4
  },
  skillName: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    backgroundColor: 'var(--accent-amber-bg)',
    padding: '1px 4px',
    borderRadius: 'var(--radius-micro)'
  },
  dismissButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-micro)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: 8,
    padding: 0
  }
}
