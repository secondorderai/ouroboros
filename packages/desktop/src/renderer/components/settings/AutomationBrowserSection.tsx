import React, { useCallback, useEffect, useState } from 'react'
import type {
  AutomationBrowserProfileMode,
  AutomationBrowserStatus,
} from '../../../shared/protocol'

const PROFILE_OPTIONS: Array<{
  mode: AutomationBrowserProfileMode
  label: string
  description: string
}> = [
  {
    mode: 'managed-profile',
    label: 'Separate automation profile',
    description: 'Isolated browser state for automation tasks.',
  },
  {
    mode: 'default-profile',
    label: 'My Chrome profile',
    description: 'Uses existing logins. Close Chrome first if launch fails.',
  },
]

function statusText(status: AutomationBrowserStatus | null): string {
  if (!status) return 'Automation Browser status unknown.'
  if (status.errorMessage) return status.errorMessage
  switch (status.state) {
    case 'stopped':
      return 'Automation Browser is stopped.'
    case 'starting':
      return 'Starting Automation Browser...'
    case 'running':
      return status.port
        ? `Automation Browser is running on local port ${status.port}.`
        : 'Automation Browser is running.'
    case 'stopping':
      return 'Stopping Automation Browser...'
    case 'error':
      return 'Automation Browser is unavailable.'
  }
}

export function AutomationBrowserSection(): React.ReactElement {
  const [status, setStatus] = useState<AutomationBrowserStatus | null>(null)
  const [choosingProfile, setChoosingProfile] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getAutomationBrowserStatus().then((next) => {
      if (!cancelled) setStatus(next)
    })
    const unsubscribe = window.electronAPI.onAutomationBrowserStatus(setStatus)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handleLaunch = useCallback(async (profileMode: AutomationBrowserProfileMode) => {
    setBusy(true)
    setChoosingProfile(false)
    try {
      setStatus(await window.electronAPI.launchAutomationBrowser({ profileMode }))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleStop = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await window.electronAPI.stopAutomationBrowser())
    } finally {
      setBusy(false)
    }
  }, [])

  const isRunning = status?.state === 'running'
  const isTransitioning = busy || status?.state === 'starting' || status?.state === 'stopping'

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Automation Browser</h3>
      <p style={styles.sectionDescription}>
        Launch a Chrome browser prepared for web automation without using terminal flags.
      </p>

      <div style={styles.statusBox}>
        <div>
          <div style={styles.label}>Current Status</div>
          <div style={styles.statusText}>{statusText(status)}</div>
          {status?.chromePath && <div style={styles.metaText}>{status.chromePath}</div>}
        </div>
        {isRunning ? (
          <button style={styles.secondaryButton} disabled={isTransitioning} onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            style={styles.primaryButton}
            disabled={isTransitioning}
            onClick={() => setChoosingProfile(true)}
          >
            Launch Automation Browser
          </button>
        )}
      </div>

      {status?.state === 'error' && !status.chromePath && (
        <div style={styles.helpBox}>
          Install Google Chrome from https://www.google.com/chrome/, then return here and launch the
          Automation Browser.
        </div>
      )}

      {choosingProfile && (
        <div
          style={styles.profileDialog}
          role='dialog'
          aria-label='Choose automation browser profile'
        >
          <div style={styles.profileTitle}>Choose Chrome profile</div>
          <div style={styles.profileOptions}>
            {PROFILE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                style={styles.profileOption}
                onClick={() => handleLaunch(option.mode)}
              >
                <span style={styles.profileLabel}>{option.label}</span>
                <span style={styles.profileDescription}>{option.description}</span>
              </button>
            ))}
          </div>
          <button style={styles.cancelButton} onClick={() => setChoosingProfile(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
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
  },
  statusBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    padding: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  statusText: {
    color: 'var(--text-primary)',
    fontSize: 13,
    lineHeight: 1.5,
    marginTop: 4,
  },
  metaText: {
    color: 'var(--text-tertiary)',
    fontSize: 12,
    marginTop: 4,
    overflowWrap: 'anywhere',
  },
  helpBox: {
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    lineHeight: 1.5,
    padding: 12,
  },
  primaryButton: {
    border: '1px solid var(--accent-amber)',
    borderRadius: 'var(--radius-standard)',
    background: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 600,
    padding: '7px 12px',
  },
  secondaryButton: {
    border: '1px solid var(--border-medium)',
    borderRadius: 'var(--radius-standard)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 600,
    padding: '7px 12px',
  },
  profileDialog: {
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  profileTitle: {
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 600,
  },
  profileOptions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
    gap: 8,
  },
  profileOption: {
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 10,
    textAlign: 'left',
  },
  profileLabel: {
    fontSize: 13,
    fontWeight: 600,
  },
  profileDescription: {
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
  },
  cancelButton: {
    alignSelf: 'flex-start',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    padding: '4px 0',
  },
}
