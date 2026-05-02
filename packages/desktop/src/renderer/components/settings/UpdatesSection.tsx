import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { UpdateCheckResult, UpdateMode, UpdatePreferences } from '../../../shared/protocol'

const MODE_LABELS: Record<UpdateMode, string> = {
  auto: 'Auto',
  manual: 'Manual',
  off: 'Off',
}

function statusLabel(result: UpdateCheckResult | null): string {
  if (!result) return 'Update status unknown.'
  switch (result.status) {
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return result.latestVersion
        ? `Version ${result.latestVersion} is available.`
        : 'An update is available.'
    case 'downloading':
      return 'Downloading update...'
    case 'downloaded':
      return result.latestVersion
        ? `Version ${result.latestVersion} is ready to install.`
        : 'Update ready to install.'
    case 'not-available':
      return `Ouroboros ${result.currentVersion} is up to date.`
    case 'error':
      return result.errorMessage ?? 'Could not check for updates.'
  }
}

export function UpdatesSection(): React.ReactElement {
  const [preferences, setPreferences] = useState<UpdatePreferences>({ mode: 'auto' })
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .getUpdatePreferences()
      .then((loaded) => {
        if (!cancelled) setPreferences(loaded)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load update settings')
      })

    const unsubscribe = window.electronAPI.onUpdateStatus((nextResult) => {
      setResult(nextResult)
      setIsChecking(nextResult.status === 'checking' || nextResult.status === 'downloading')
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const statusText = useMemo(() => statusLabel(result), [result])

  const handleModeChange = useCallback(
    async (mode: UpdateMode) => {
      const previous = preferences
      const next = { mode }
      setPreferences(next)
      setError(null)
      try {
        await window.electronAPI.setUpdatePreferences(next)
      } catch (err) {
        setPreferences(previous)
        setError(err instanceof Error ? err.message : 'Failed to save update settings')
      }
    },
    [preferences],
  )

  const handleCheck = useCallback(async () => {
    setIsChecking(true)
    setError(null)
    try {
      const nextResult = await window.electronAPI.checkForUpdates()
      setResult(nextResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for updates')
    } finally {
      setIsChecking(false)
    }
  }, [])

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Updates</h3>
      <p style={styles.sectionDescription}>
        Manage how the macOS desktop app checks for new releases.
      </p>

      <div style={styles.field}>
        <label style={styles.label}>Update Mode</label>
        <div className="settings-segment-group">
          {(Object.keys(MODE_LABELS) as UpdateMode[]).map((mode) => (
            <button
              key={mode}
              className="settings-segment-option"
              data-active={preferences.mode === mode}
              onClick={() => handleModeChange(mode)}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.statusRow}>
        <div>
          <div style={styles.label}>Current Status</div>
          <div style={styles.statusText}>{error ?? statusText}</div>
        </div>
        <button
          style={styles.primaryButton}
          onClick={handleCheck}
          disabled={isChecking || preferences.mode === 'off'}
        >
          {isChecking ? 'Checking...' : 'Check for updates'}
        </button>
      </div>
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
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    padding: 12,
  },
  statusText: {
    color: 'var(--text-primary)',
    fontSize: 13,
    lineHeight: 1.5,
    marginTop: 4,
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
}
