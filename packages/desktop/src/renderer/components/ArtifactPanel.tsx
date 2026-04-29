import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  selectCurrentArtifact,
  selectCurrentArtifacts,
  selectCurrentHtml,
  useArtifactsStore,
} from '../stores/artifactsStore'
import { buildArtifactProtocolUrl } from '../../shared/artifact-url'
import { ArtifactFrame } from './ArtifactFrame'

interface ArtifactPanelProps {
  width: number
  onResize?: (width: number) => void
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  onHide?: () => void
  minWidth?: number
  maxWidth?: number
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: 'var(--bg-surface)',
    borderLeft: '1px solid var(--border-light)',
    overflow: 'hidden',
  },
  panelFullscreen: {
    flex: 1,
    width: 'auto',
    borderLeft: 'none',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize',
    zIndex: 2,
    background: 'transparent',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid var(--border-light)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 600,
  },
  title: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
  },
  versionSelect: {
    background: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontSize: 12,
    padding: '2px 6px',
  },
  iconButton: {
    background: 'transparent',
    border: '1px solid var(--border-light)',
    borderRadius: 4,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '2px 8px',
  },
  iconOnlyButton: {
    background: 'transparent',
    border: '1px solid var(--border-light)',
    borderRadius: 4,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px 6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 0,
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: 'var(--text-secondary)',
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    background: 'var(--bg-chat)',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-tertiary)',
    fontSize: 13,
    padding: 24,
    textAlign: 'center' as const,
  },
  errorState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-secondary)',
    fontSize: 12,
    padding: 24,
    textAlign: 'center' as const,
  },
  saveStatus: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginLeft: 4,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 160,
  },
}

const SAVE_STATUS_RESET_MS = 4000

export function ArtifactPanel({
  width,
  onResize,
  isFullscreen = false,
  onToggleFullscreen,
  onHide,
  minWidth = 280,
  maxWidth = 900,
}: ArtifactPanelProps): React.ReactElement | null {
  const artifacts = useArtifactsStore(selectCurrentArtifacts)
  const current = useArtifactsStore(selectCurrentArtifact)
  const html = useArtifactsStore(selectCurrentHtml)
  const followLatest = useArtifactsStore((s) => s.followLatest)
  const errorMessage = useArtifactsStore((s) => s.errorMessage)
  const selectArtifact = useArtifactsStore((s) => s.selectArtifact)
  const setFollowLatest = useArtifactsStore((s) => s.setFollowLatest)

  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const state = resizeStateRef.current
      if (!state || !onResize) return
      // Drag direction is inverted vs. the sidebar: dragging LEFT widens this
      // panel because its right edge is pinned to the window edge.
      onResize(state.startWidth - (e.clientX - state.startX))
    }
    const stopResizing = () => {
      resizeStateRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
      stopResizing()
    }
  }, [onResize])

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize || isFullscreen) return
      resizeStateRef.current = { startX: e.clientX, startWidth: width }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
    },
    [onResize, isFullscreen, width],
  )

  useEffect(() => {
    if (!saveStatus) return
    const timer = window.setTimeout(() => setSaveStatus(null), SAVE_STATUS_RESET_MS)
    return () => window.clearTimeout(timer)
  }, [saveStatus])

  const versionsForCurrent = useMemo(() => {
    if (!current) return []
    return artifacts
      .filter((a) => a.artifactId === current.artifactId)
      .map((a) => a.version)
      .sort((a, b) => a - b)
  }, [artifacts, current])

  if (artifacts.length === 0) return null

  const onOpenExternally = (): void => {
    if (!current) return
    window.electronAPI.openArtifact(current.path)
  }

  const onPickArtifact = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const id = event.target.value
    void selectArtifact(id)
  }

  const onPickVersion = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    if (!current) return
    const version = Number.parseInt(event.target.value, 10)
    if (!Number.isFinite(version)) return
    void selectArtifact(current.artifactId, version)
  }

  const onDownload = async (): Promise<void> => {
    if (!current || !html || saving) return
    setSaving(true)
    setSaveStatus(null)
    try {
      const versionedName =
        versionsForCurrent.length > 1 ? `${current.title}-v${current.version}` : current.title
      const result = await window.ouroboros.saveArtifact({
        html,
        defaultName: versionedName,
      })
      if (result.saved) {
        setSaveStatus('Saved')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed'
      setSaveStatus(message)
    } finally {
      setSaving(false)
    }
  }

  const distinctArtifacts = Array.from(
    new Map(artifacts.map((a) => [a.artifactId, a])).values(),
  )

  const panelStyle: React.CSSProperties = isFullscreen
    ? { ...styles.panel, ...styles.panelFullscreen }
    : { ...styles.panel, width }

  return (
    <div style={panelStyle} data-testid='artifact-panel'>
      {!isFullscreen && onResize && (
        <div
          style={styles.resizeHandle}
          role='separator'
          aria-orientation='vertical'
          aria-label='Resize artifact panel'
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          onPointerDown={handleResizeStart}
          data-testid='artifact-panel-resize-handle'
        />
      )}
      <div style={styles.header}>
        <select
          value={current?.artifactId ?? ''}
          onChange={onPickArtifact}
          style={styles.versionSelect}
          data-testid='artifact-picker'
        >
          {distinctArtifacts.map((a) => (
            <option key={a.artifactId} value={a.artifactId}>
              {a.title}
            </option>
          ))}
        </select>
        {versionsForCurrent.length > 1 && current && (
          <select
            value={current.version}
            onChange={onPickVersion}
            style={styles.versionSelect}
            data-testid='artifact-version-picker'
          >
            {versionsForCurrent.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        )}
        <span style={styles.title}>{current?.description ?? ''}</span>
        {saveStatus && (
          <span style={styles.saveStatus} data-testid='artifact-save-status'>
            {saveStatus}
          </span>
        )}
        <label style={styles.toggle}>
          <input
            type='checkbox'
            checked={followLatest}
            onChange={(e) => setFollowLatest(e.target.checked)}
          />
          Follow latest
        </label>
        {onHide && !isFullscreen && (
          <button
            type='button'
            onClick={onHide}
            style={styles.iconOnlyButton}
            aria-label='Hide HTML5 app'
            title='Hide HTML5 app'
            data-testid='artifact-panel-hide'
          >
            <HidePanelIcon />
          </button>
        )}
        <button
          type='button'
          onClick={() => void onDownload()}
          style={styles.iconOnlyButton}
          disabled={!current || !html || saving}
          aria-label='Download artifact'
          title='Download artifact'
          data-testid='artifact-download'
        >
          <DownloadIcon />
        </button>
        <button
          type='button'
          onClick={onOpenExternally}
          style={styles.iconButton}
          disabled={!current}
          data-testid='artifact-open-external'
        >
          Open externally
        </button>
        {onToggleFullscreen && (
          <button
            type='button'
            onClick={onToggleFullscreen}
            style={styles.iconOnlyButton}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen (Esc to exit)'}
            data-testid='artifact-fullscreen-toggle'
            aria-pressed={isFullscreen}
          >
            {isFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
        )}
      </div>
      <div style={styles.body}>
        {errorMessage ? (
          <div style={styles.errorState} data-testid='artifact-error'>
            {errorMessage}
          </div>
        ) : !current ? (
          <div style={styles.emptyState}>Select an artifact</div>
        ) : (
          <ArtifactFrame src={buildArtifactProtocolUrl(current.path)} title={current.title} />
        )}
      </div>
    </div>
  )
}

function MaximizeIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M4 9V5a1 1 0 0 1 1-1h4' />
      <path d='M20 9V5a1 1 0 0 0-1-1h-4' />
      <path d='M4 15v4a1 1 0 0 0 1 1h4' />
      <path d='M20 15v4a1 1 0 0 1-1 1h-4' />
    </svg>
  )
}

function MinimizeIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M9 4v4a1 1 0 0 1-1 1H4' />
      <path d='M15 4v4a1 1 0 0 0 1 1h4' />
      <path d='M9 20v-4a1 1 0 0 0-1-1H4' />
      <path d='M15 20v-4a1 1 0 0 1 1-1h4' />
    </svg>
  )
}

function DownloadIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M12 3v12' />
      <path d='m7 10 5 5 5-5' />
      <path d='M5 21h14' />
    </svg>
  )
}

function HidePanelIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <rect x='3' y='4' width='18' height='16' rx='2' />
      <path d='M15 4v16' />
      <path d='m9 9 3 3-3 3' />
    </svg>
  )
}
