import React from 'react'
import { OuroborosMark } from './OuroborosMark'

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
  const color = state === 'flash'
    ? 'var(--accent-slate-blue, #3E5F8A)'
    : state === 'active'
      ? 'var(--accent-slate-blue-highlight, #89A7D1)'
      : 'var(--text-secondary)'

  return (
    <button
      style={{
        ...styles.button,
        ...(state === 'active' ? styles.buttonActive : {}),
        ...(state === 'flash' ? styles.buttonFlash : {}),
      }}
      className={`no-drag ${CLASS_MAP[state]}`}
      onClick={onClick}
      title={TOOLTIP_MAP[state]}
      aria-label={`RSI status: ${TOOLTIP_MAP[state]}`}
    >
      <OuroborosMark
        size={24}
        color={color}
        eyeColor="var(--bg-chat)"
        tileColor="var(--bg-chat)"
        borderColor="var(--border-light)"
      />
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
  },
  buttonActive: {
    background: 'var(--accent-slate-blue-background, rgba(62,95,138,0.10))'
  },
  buttonFlash: {
    background: 'var(--accent-slate-blue-background, rgba(62,95,138,0.10))',
    boxShadow: '0 0 0 1px rgba(62,95,138,0.18) inset'
  }
}
