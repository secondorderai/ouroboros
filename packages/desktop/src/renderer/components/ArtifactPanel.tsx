import React, { useMemo } from 'react'
import {
  selectCurrentArtifact,
  selectCurrentArtifacts,
  selectCurrentHtml,
  useArtifactsStore,
} from '../stores/artifactsStore'
import { ArtifactFrame } from './ArtifactFrame'

interface ArtifactPanelProps {
  width: number
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: 'var(--bg-surface)',
    borderLeft: '1px solid var(--border-light)',
    overflow: 'hidden',
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
}

export function ArtifactPanel({ width }: ArtifactPanelProps): React.ReactElement | null {
  const artifacts = useArtifactsStore(selectCurrentArtifacts)
  const current = useArtifactsStore(selectCurrentArtifact)
  const html = useArtifactsStore(selectCurrentHtml)
  const followLatest = useArtifactsStore((s) => s.followLatest)
  const loadingHtml = useArtifactsStore((s) => s.loadingHtml)
  const errorMessage = useArtifactsStore((s) => s.errorMessage)
  const selectArtifact = useArtifactsStore((s) => s.selectArtifact)
  const setFollowLatest = useArtifactsStore((s) => s.setFollowLatest)

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
    window.electronAPI.openExternal(`file://${current.path}`)
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

  const distinctArtifacts = Array.from(
    new Map(artifacts.map((a) => [a.artifactId, a])).values(),
  )

  return (
    <div style={{ ...styles.panel, width }} data-testid='artifact-panel'>
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
        <label style={styles.toggle}>
          <input
            type='checkbox'
            checked={followLatest}
            onChange={(e) => setFollowLatest(e.target.checked)}
          />
          Follow latest
        </label>
        <button
          type='button'
          onClick={onOpenExternally}
          style={styles.iconButton}
          disabled={!current}
          data-testid='artifact-open-external'
        >
          Open externally
        </button>
      </div>
      <div style={styles.body}>
        {errorMessage ? (
          <div style={styles.errorState} data-testid='artifact-error'>
            {errorMessage}
          </div>
        ) : !current ? (
          <div style={styles.emptyState}>Select an artifact</div>
        ) : loadingHtml || !html ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : (
          <ArtifactFrame html={html} title={current.title} />
        )}
      </div>
    </div>
  )
}
