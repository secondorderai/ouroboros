import React, { useMemo } from 'react'
import { getModeDisplayName, useModeStore } from '../../stores/modeStore'

const MODE_OPTIONS = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Switch the assistant into planning mode before implementation work begins.',
  },
]

function formatEnteredAt(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

export function ModeSection(): React.ReactElement {
  const modeState = useModeStore((state) => state.modeState)
  const lastPlan = useModeStore((state) => state.lastPlan)
  const isBusy = useModeStore((state) => state.isHydrating || state.isMutating)
  const error = useModeStore((state) => state.error)
  const enterMode = useModeStore((state) => state.enterMode)
  const exitMode = useModeStore((state) => state.exitMode)

  const activeModeLabel = useMemo(() => {
    return modeState.status === 'active' ? getModeDisplayName(modeState.modeId) : null
  }, [modeState])

  return (
    <div style={styles.section}>
      <div style={styles.header}>
        <h3 style={styles.sectionTitle}>Modes</h3>
        <p style={styles.sectionDescription}>
          Modes change how Ouroboros responds. Use Plan mode when you want design and execution
          broken into an explicit planning workflow first.
        </p>
      </div>

      <div style={styles.statusCard}>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Current mode</span>
          <span
            style={{
              ...styles.statusBadge,
              ...(modeState.status === 'active' ? styles.statusBadgeActive : styles.statusBadgeInactive),
            }}
          >
            {activeModeLabel ?? 'Inactive'}
          </span>
        </div>
        <p style={styles.statusText}>
          {modeState.status === 'active'
            ? `${activeModeLabel} mode has been active since ${formatEnteredAt(modeState.enteredAt)}.`
            : 'No special mode is active. Standard chat behavior is currently in effect.'}
        </p>
        {modeState.status === 'active' && (
          <button style={styles.secondaryButton} onClick={() => void exitMode()} disabled={isBusy}>
            Exit current mode
          </button>
        )}
      </div>

      <div style={styles.modeList}>
        {MODE_OPTIONS.map((mode) => {
          const isActive = modeState.status === 'active' && modeState.modeId === mode.id
          return (
            <div key={mode.id} style={styles.modeCard}>
              <div style={styles.modeInfo}>
                <div style={styles.modeTitleRow}>
                  <span style={styles.modeTitle}>{mode.label}</span>
                  {isActive && <span style={styles.inlineActiveBadge}>Active</span>}
                </div>
                <p style={styles.modeDescription}>{mode.description}</p>
              </div>
              <button
                className="settings-segment-option"
                data-active={isActive}
                style={styles.modeAction}
                onClick={() => void (isActive ? exitMode() : enterMode(mode.id))}
                disabled={isBusy}
              >
                {isActive ? 'Exit' : 'Enter'}
              </button>
            </div>
          )
        })}
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      <div style={styles.planCard}>
        <div style={styles.planHeaderRow}>
          <span style={styles.planTitle}>Latest submitted plan</span>
          {lastPlan && <span style={styles.planStatus}>{lastPlan.status}</span>}
        </div>
        {lastPlan ? (
          <div style={styles.planContent}>
            <div>
              <h4 style={styles.planHeading}>{lastPlan.title}</h4>
              <p style={styles.planSummary}>{lastPlan.summary}</p>
            </div>
            <div style={styles.planMetaRow}>
              <span style={styles.planMeta}>{lastPlan.steps.length} steps</span>
              <span style={styles.planMeta}>{lastPlan.exploredFiles.length} explored files</span>
            </div>
          </div>
        ) : (
          <p style={styles.emptyText}>No submitted plan has been recorded for the current mode yet.</p>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  sectionDescription: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: 0,
    lineHeight: 1.5,
    maxWidth: 680,
  },
  statusCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '14px 16px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
    backgroundColor: 'var(--bg-secondary)',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
  },
  statusBadgeActive: {
    backgroundColor: 'var(--accent-amber-bg)',
    color: 'var(--accent-amber)',
  },
  statusBadgeInactive: {
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-tertiary)',
  },
  statusText: {
    margin: 0,
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--radius-standard)',
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  modeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  modeCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '14px 16px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
    backgroundColor: 'var(--bg-primary)',
  },
  modeInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  modeTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  modeTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  inlineActiveBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--accent-amber)',
    backgroundColor: 'var(--accent-amber-bg)',
    borderRadius: 999,
    padding: '2px 8px',
  },
  modeDescription: {
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--text-tertiary)',
    margin: 0,
    maxWidth: 520,
  },
  modeAction: {
    flex: '0 0 auto',
    minWidth: 88,
    borderRadius: 'var(--radius-standard)',
    border: '1px solid var(--border-light)',
  },
  errorBanner: {
    padding: '10px 12px',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'rgba(185, 28, 28, 0.08)',
    border: '1px solid rgba(185, 28, 28, 0.18)',
    color: 'var(--accent-red)',
    fontSize: 12,
    lineHeight: 1.45,
  },
  planCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '14px 16px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
    backgroundColor: 'var(--bg-primary)',
  },
  planHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  planTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  planStatus: {
    fontSize: 11,
    textTransform: 'capitalize',
    letterSpacing: '0.03em',
    color: 'var(--text-tertiary)',
  },
  planContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  planHeading: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  planSummary: {
    margin: '6px 0 0',
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
  planMetaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
  },
  planMeta: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },
  emptyText: {
    margin: 0,
    fontSize: 13,
    color: 'var(--text-tertiary)',
    lineHeight: 1.5,
  },
}
