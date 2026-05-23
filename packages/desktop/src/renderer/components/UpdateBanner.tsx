/**
 * UpdateAlert — compact sidebar alert that appears when an update has been
 * downloaded and is ready to install.
 *
 * Listens to IPC events from the main process auto-updater:
 *   - update:downloaded  → show the alert with the new version
 *   - update:error       → (optional) could show an error, but we stay silent
 *
 * User actions:
 *   - "Restart now" → sends update:install IPC to main
 *   - Dismiss button → hides the alert
 */

import React, { useCallback, useEffect, useState } from 'react'

const alertStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  width: '100%',
  padding: '10px',
  border: '1px solid var(--accent-primary)',
  borderRadius: 'var(--radius-standard)',
  backgroundColor: 'var(--accent-amber-bg)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)',
  boxShadow: 'var(--shadow-subtle)',
}

const textStackStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

const titleStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.25,
}

const messageStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.25,
}

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
}

const buttonBaseStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: 'var(--radius-micro)',
  padding: '5px 8px',
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: 'pointer',
}

const restartButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  flex: 1,
  backgroundColor: 'var(--accent-primary)',
  color: 'var(--text-inverse)',
}

const dismissButtonStyle: React.CSSProperties = {
  ...buttonBaseStyle,
  flexShrink: 0,
  backgroundColor: 'transparent',
  color: 'var(--text-secondary)',
  paddingInline: 2,
}

export function UpdateAlert(): React.ReactElement | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  useEffect(() => {
    const cleanup = window.electronAPI.onUpdateDownloaded((v: string) => {
      setVersion(v)
      setDismissed(false)
      setIsRestarting(false)
    })

    return cleanup
  }, [])

  const handleRestart = useCallback(() => {
    setIsRestarting(true)
    void window.electronAPI.installUpdate().catch(() => {
      setIsRestarting(false)
    })
  }, [])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  if (!version || dismissed) {
    return null
  }

  return (
    <div style={alertStyle} className='no-drag' role='alert' aria-label='Update available'>
      <div style={textStackStyle}>
        <span style={titleStyle}>Update v{version} ready</span>
        <span style={messageStyle}>Restart to apply</span>
      </div>
      <div style={actionsStyle}>
        <button
          style={restartButtonStyle}
          className='no-drag'
          onClick={handleRestart}
          disabled={isRestarting}
        >
          {isRestarting ? 'Restarting...' : 'Restart now'}
        </button>
        <button style={dismissButtonStyle} className='no-drag' onClick={handleDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
