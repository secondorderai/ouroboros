/**
 * Step 2 — "Choose your workspace"
 *
 * Folder picker button, drag-and-drop zone, selected path display,
 * and "I'll set this up later" skip option.
 */

import React, { useState, useCallback } from 'react'

// ── Folder icon ─────────────────────────────────────────────

const FolderIcon = ({ size = 48 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

// ── Styles ──────────────────────────────────────────────────

const styles = {
  heading: {
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  } as React.CSSProperties,
  subheading: {
    fontSize: '15px',
    color: 'var(--text-secondary)',
    marginBottom: '24px',
  } as React.CSSProperties,
  illustration: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '20px',
    color: 'var(--accent-primary)',
  } as React.CSSProperties,
  dropZone: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    padding: '32px 24px',
    border: '2px dashed var(--border-medium)',
    borderRadius: '12px',
    background: 'var(--bg-secondary)',
    cursor: 'pointer',
    transition: 'border-color 200ms ease, background 200ms ease',
    marginBottom: '16px',
  } as React.CSSProperties,
  dropZoneActive: {
    borderColor: 'var(--accent-primary)',
    background: 'var(--accent-muted)',
  } as React.CSSProperties,
  dropZoneLabel: {
    fontSize: '14px',
    color: 'var(--text-secondary)',
  } as React.CSSProperties,
  chooseButton: {
    padding: '10px 24px',
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-inverse)',
    background: 'var(--accent-primary)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 200ms ease',
  } as React.CSSProperties,
  selectedPath: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    background: 'var(--bg-success)',
    border: '1px solid var(--border-success)',
    borderRadius: '8px',
    marginBottom: '8px',
  } as React.CSSProperties,
  pathText: {
    flex: 1,
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    wordBreak: 'break-all' as const,
  } as React.CSSProperties,
  changeLink: {
    fontSize: '13px',
    color: 'var(--text-link)',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    fontWeight: 500,
    flexShrink: 0,
  } as React.CSSProperties,
  explanation: {
    fontSize: '13px',
    color: 'var(--text-tertiary)',
    marginBottom: '16px',
    lineHeight: 1.5,
  } as React.CSSProperties,
  skipLink: {
    display: 'block',
    textAlign: 'center' as const,
    fontSize: '13px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: '8px',
    width: '100%',
    transition: 'color 200ms ease',
  } as React.CSSProperties,
  nextButton: {
    width: '100%',
    padding: '12px',
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--text-inverse)',
    background: 'var(--accent-primary)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 200ms ease, opacity 200ms ease',
    marginTop: '16px',
  } as React.CSSProperties,
  nextButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  } as React.CSSProperties,
}

// ── Component ───────────────────────────────────────────────

interface StepWorkspaceProps {
  workspace: string
  onWorkspaceChange: (path: string) => void
  onNext: () => void
}

export const StepWorkspace: React.FC<StepWorkspaceProps> = ({
  workspace,
  onWorkspaceChange,
  onNext,
}) => {
  const [dragOver, setDragOver] = useState(false)
  const hasSelection = workspace.length > 0

  const handleChooseFolder = useCallback(async () => {
    try {
      const result = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose your workspace folder',
      })
      if (!result.canceled && result.filePaths.length > 0) {
        onWorkspaceChange(result.filePaths[0])
      }
    } catch {
      // Dialog canceled or errored — no action
    }
  }, [onWorkspaceChange])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)

      const files = e.dataTransfer.files
      if (files.length > 0) {
        // Electron file drops provide the full path
        const file = files[0]
        const path = (file as File & { path?: string }).path
        if (path) {
          onWorkspaceChange(path)
        }
      }
    },
    [onWorkspaceChange],
  )

  const handleSkip = useCallback(async () => {
    try {
      const home = await window.electronAPI.getHomeDirectory()
      onWorkspaceChange(home)
    } catch {
      // Fallback if getHomeDirectory is not available
      onWorkspaceChange('~')
    }
    onNext()
  }, [onWorkspaceChange, onNext])

  return (
    <div>
      <h2 style={styles.heading}>Choose your workspace</h2>
      <p style={styles.subheading}>Pick a folder for Ouroboros to work in</p>

      {/* Folder illustration */}
      <div style={styles.illustration}>
        <FolderIcon size={48} />
      </div>

      {/* Selected path display */}
      {hasSelection ? (
        <div style={styles.selectedPath}>
          <FolderIcon size={18} />
          <span style={styles.pathText}>{workspace}</span>
          <button style={styles.changeLink} onClick={handleChooseFolder}>
            Change
          </button>
        </div>
      ) : (
        /* Drop zone + choose button */
        <div
          style={{
            ...styles.dropZone,
            ...(dragOver ? styles.dropZoneActive : {}),
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleChooseFolder}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleChooseFolder()
          }}
        >
          <button style={styles.chooseButton}>Choose folder</button>
          <span style={styles.dropZoneLabel}>Or drag a folder here</span>
        </div>
      )}

      <p style={styles.explanation}>
        Ouroboros will read files, run commands, and create skills in this
        directory.
      </p>

      {/* Skip option */}
      <button style={styles.skipLink} onClick={handleSkip}>
        I'll set this up later
      </button>

      {/* Next button */}
      <button
        style={{
          ...styles.nextButton,
          ...(!hasSelection ? styles.nextButtonDisabled : {}),
        }}
        onClick={hasSelection ? onNext : undefined}
        disabled={!hasSelection}
      >
        Next
      </button>
    </div>
  )
}

export default StepWorkspace
