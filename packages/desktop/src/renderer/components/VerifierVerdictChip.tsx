import React from 'react'
import type {
  AgentVerifierVerdictNotification,
  VerifierVerdictValue,
} from '../../shared/protocol'

// ---------------------------------------------------------------------------
// Verifier Verdict Chip
//
// Inline chip surfacing how the completion-gate verifier judged the last
// agent run. Modeled on the RSI crystallization card in ChatView: a slim,
// dismissible strip above the input bar. Colors come exclusively from
// theme.css variables (DESIGN.md) — verdict tone is carried by the 3px left
// border: green (pass), red (fail), amber (unknown).
// ---------------------------------------------------------------------------

const VERDICT_ACCENT: Record<VerifierVerdictValue, string> = {
  pass: 'var(--accent-green)',
  fail: 'var(--accent-red)',
  unknown: 'var(--accent-amber)',
}

function verdictHeadline(verdict: AgentVerifierVerdictNotification): string {
  switch (verdict.verdict) {
    case 'pass':
      return 'Verifier: task completion checks passed'
    case 'fail': {
      const count = verdict.failures.length
      const escalation = verdict.escalated ? ' (human-approved completion)' : ''
      return `Verifier: ${count} unmet ${count === 1 ? 'criterion' : 'criteria'}${escalation}`
    }
    case 'unknown':
      return 'Verifier: completion could not be confirmed'
  }
}

const chipStyle = (verdict: VerifierVerdictValue): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 16px',
  margin: '0 16px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-light)',
  borderLeft: `3px solid ${VERDICT_ACCENT[verdict]}`,
  borderRadius: 10,
  fontSize: 13,
  color: 'var(--text-primary)',
})

const headlineStyle: React.CSSProperties = {
  fontWeight: 600,
  lineHeight: 1.4,
}

const reasonStyle: React.CSSProperties = {
  marginTop: 2,
  color: 'var(--text-secondary)',
  lineHeight: 1.4,
}

const failureListStyle: React.CSSProperties = {
  margin: '6px 0 0 0',
  paddingLeft: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const failureItemStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  lineHeight: 1.4,
}

const criterionStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontWeight: 500,
}

const suggestionStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
}

// Matches the rsiDismissStyle used by the crystallization card.
const dismissStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  flexShrink: 0,
  borderRadius: 4,
}

export const VerifierVerdictChip: React.FC<{
  verdict: AgentVerifierVerdictNotification
  onDismiss: () => void
}> = ({ verdict, onDismiss }) => {
  return (
    <div data-testid='verifier-verdict-chip' data-verdict={verdict.verdict} style={chipStyle(verdict.verdict)}>
      <div style={{ minWidth: 0 }}>
        <div style={headlineStyle}>{verdictHeadline(verdict)}</div>
        {verdict.reason && <div style={reasonStyle}>{verdict.reason}</div>}
        {verdict.verdict === 'fail' && verdict.failures.length > 0 && (
          <ul style={failureListStyle}>
            {verdict.failures.map((failure, index) => (
              <li key={index} style={failureItemStyle}>
                <span style={criterionStyle}>{failure.criterion}</span>
                {failure.suggestion && <span style={suggestionStyle}> — {failure.suggestion}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        style={dismissStyle}
        onClick={onDismiss}
        aria-label='Dismiss verifier verdict'
      >
        <svg
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <line x1='18' y1='6' x2='6' y2='18' />
          <line x1='6' y1='6' x2='18' y2='18' />
        </svg>
      </button>
    </div>
  )
}
