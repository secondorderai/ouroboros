import React from 'react'

export type SerpentState = 'idle' | 'active' | 'flash'

interface SerpentIconProps {
  state: SerpentState
  onClick: () => void
}

const TOOLTIP_MAP: Record<SerpentState, string> = {
  idle: 'Idle',
  active: 'Reflecting on task...',
  flash: 'Skill crystallized!'
}

const CLASS_MAP: Record<SerpentState, string> = {
  idle: 'serpent-idle',
  active: 'serpent-active',
  flash: 'serpent-flash'
}

export function SerpentIcon({ state, onClick }: SerpentIconProps): React.ReactElement {
  return (
    <button
      style={styles.button}
      className={`no-drag ${CLASS_MAP[state]}`}
      onClick={onClick}
      title={TOOLTIP_MAP[state]}
      aria-label={`RSI status: ${TOOLTIP_MAP[state]}`}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Ouroboros / infinity serpent symbol */}
        <path d="M8 12c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4-4-1.8-4-4z" />
        <path d="M12 8c2.8-2 6-1 7 1.5s0 5.5-2.5 6.5" />
        <path d="M12 16c-2.8 2-6 1-7-1.5s0-5.5 2.5-6.5" />
        {/* Serpent head detail — small arrow/fang at the bite point */}
        <path d="M16.5 16l1-1.5M16.5 16l1.5 0.5" />
      </svg>
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    cursor: 'pointer',
    padding: 2
  }
}
