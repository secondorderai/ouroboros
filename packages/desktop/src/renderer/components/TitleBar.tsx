import React, { useEffect, useState } from 'react'
import { SerpentIcon, type SerpentState } from './SerpentIcon'
import type { WorkspaceMode } from '../../shared/protocol'

interface TitleBarProps {
  resolvedTheme: 'light' | 'dark'
  onToggleTheme: () => void
  onToggleSidebar: () => void
  serpentState: SerpentState
  onSerpentClick: () => void
  pendingApprovals: number
  showTeamGraph?: boolean
  onOpenTeamGraph?: () => void
  workspaceMode: WorkspaceMode
  selectedWorkspacePath: string | null
  workspaceModeError?: string | null
  canChangeWorkspaceMode?: boolean
  onSelectWorkspaceMode: (mode: WorkspaceMode) => void
  onPickWorkspace: () => Promise<string | null>
}

export function TitleBar({
  resolvedTheme,
  onToggleTheme,
  onToggleSidebar,
  serpentState,
  onSerpentClick,
  pendingApprovals,
  showTeamGraph = false,
  onOpenTeamGraph,
  workspaceMode,
  selectedWorkspacePath,
  workspaceModeError,
  canChangeWorkspaceMode = true,
  onSelectWorkspaceMode,
  onPickWorkspace,
}: TitleBarProps): React.ReactElement {
  const [platform, setPlatform] = useState<string>('darwin')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)

  useEffect(() => {
    window.electronAPI.getPlatform().then(setPlatform)
  }, [])

  const isMac = platform === 'darwin'
  const workspaceLabel =
    workspaceMode === 'workspace' && selectedWorkspacePath
      ? truncatePath(selectedWorkspacePath)
      : workspaceMode === 'workspace'
        ? 'Workspace'
        : 'Simple'

  async function selectMode(mode: WorkspaceMode): Promise<void> {
    if (!canChangeWorkspaceMode) return
    if (mode === workspaceMode && (mode === 'simple' || selectedWorkspacePath)) {
      setModeMenuOpen(false)
      return
    }
    if (mode === 'workspace') {
      const picked = await onPickWorkspace()
      if (!picked && !selectedWorkspacePath) return
    }
    onSelectWorkspaceMode(mode)
    setModeMenuOpen(false)
  }

  return (
    <div style={styles.titleBar} className="drag-region no-select">
      {/* Left section: sidebar toggle (offset for macOS traffic lights) */}
      <div style={{ ...styles.left, paddingLeft: isMac ? 78 : 8 }}>
        <button
          style={styles.iconButton}
          className="no-drag"
          onClick={onToggleSidebar}
          title="Toggle Sidebar"
          aria-label="Toggle sidebar"
        >
          <SidebarIcon />
        </button>
      </div>

      {/* Center: workspace mode selector */}
      <div style={styles.center}>
        <div style={styles.modeSelector} className="no-drag">
          <button
            style={{
              ...styles.modeButton,
              ...(workspaceMode === 'simple'
                ? styles.modeButtonSimple
                : styles.modeButtonWorkspace),
              ...(workspaceModeError ? styles.modeButtonError : undefined),
            }}
            onClick={() => setModeMenuOpen((open) => !open)}
            aria-label="Workspace mode"
            aria-expanded={modeMenuOpen}
            title={
              workspaceModeError ??
              (canChangeWorkspaceMode
                ? 'Choose workspace mode for new chats'
                : 'Mode is fixed after a conversation starts')
            }
          >
            <span style={styles.modeLabel}>
              {workspaceMode === 'simple' ? 'Simple' : workspaceLabel}
            </span>
            <ChevronIcon open={modeMenuOpen} />
          </button>
          {modeMenuOpen && (
            <div style={styles.modeMenu} role="menu" aria-label="Workspace mode selector">
              <button
                style={{
                  ...styles.modeMenuItem,
                  ...(workspaceMode === 'simple' ? styles.modeMenuItemSelected : undefined),
                }}
                role="menuitem"
                onClick={() => void selectMode('simple')}
                disabled={!canChangeWorkspaceMode}
              >
                <span style={styles.modeMenuTitle}>Simple</span>
                <span style={styles.modeMenuDescription}>Isolated folder per new chat.</span>
              </button>
              <button
                style={{
                  ...styles.modeMenuItem,
                  ...(workspaceMode === 'workspace' ? styles.modeMenuItemSelected : undefined),
                }}
                role="menuitem"
                onClick={() => void selectMode('workspace')}
                disabled={!canChangeWorkspaceMode}
              >
                <span style={styles.modeMenuTitle}>Workspace</span>
                <span style={styles.modeMenuDescription}>
                  {selectedWorkspacePath ? truncatePath(selectedWorkspacePath) : 'Select a folder.'}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right section: serpent icon + theme toggle */}
      <div style={styles.right}>
        {showTeamGraph && onOpenTeamGraph && (
          <button
            style={styles.iconButton}
            className="no-drag"
            onClick={onOpenTeamGraph}
            title="Open team graph"
            aria-label="Open team graph"
            data-testid="titlebar-team-graph-button"
          >
            <NetworkIcon />
          </button>
        )}
        <div style={styles.serpentWrapper}>
          <SerpentIcon state={serpentState} onClick={onSerpentClick} />
          {pendingApprovals > 0 && (
            <span style={styles.approvalBadge}>{pendingApprovals}</span>
          )}
        </div>
        <button
          style={styles.iconButton}
          className="no-drag"
          onClick={onToggleTheme}
          title={resolvedTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          aria-label="Toggle theme"
        >
          {resolvedTheme === 'light' ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>
    </div>
  )
}

function truncatePath(fullPath: string): string {
  const home = fullPath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  const segments = home.split('/')
  return segments.length > 3 ? `.../${segments.slice(-2).join('/')}` : home
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function SidebarIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1="6" y1="2" x2="6" y2="14" />
    </svg>
  )
}

function SunIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  )
}

function MoonIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function NetworkIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M8.6 7.7 10.9 15" />
      <path d="M15.4 7.7 13.1 15" />
      <path d="M9 6h6" />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 'var(--title-bar-height)',
    backgroundColor: 'var(--bg-primary)',
    borderBottom: '1px solid var(--border-light)',
    flexShrink: 0,
    position: 'relative',
    zIndex: 100
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 4
  },
  center: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center'
  },
  modeSelector: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  modeButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 92,
    maxWidth: 240,
    height: 28,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '0 9px',
    fontFamily: 'var(--font-sans)',
  },
  modeButtonSimple: {
    borderColor: 'color-mix(in srgb, var(--accent-green) 44%, var(--border-light))',
    backgroundColor: 'color-mix(in srgb, var(--accent-green) 12%, var(--bg-secondary))',
    color: 'var(--accent-green)',
  },
  modeButtonWorkspace: {
    borderColor: 'color-mix(in srgb, var(--accent-purple) 44%, var(--border-light))',
    backgroundColor: 'color-mix(in srgb, var(--accent-purple) 12%, var(--bg-secondary))',
    color: 'var(--accent-purple)',
  },
  modeButtonError: {
    borderColor: 'var(--accent-red)',
    color: 'var(--accent-red)',
  },
  modeLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
  },
  modeMenu: {
    position: 'absolute',
    top: 34,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 220,
    padding: 6,
    border: '1px solid var(--border-light)',
    borderRadius: 10,
    backgroundColor: 'var(--bg-input)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 200,
  },
  modeMenuItem: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 3,
    border: 'none',
    borderRadius: 8,
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    padding: '8px 10px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  modeMenuItemSelected: {
    backgroundColor: 'var(--bg-hover)',
  },
  modeMenuTitle: {
    fontSize: 12,
    fontWeight: 700,
  },
  modeMenuDescription: {
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingRight: 12
  },
  serpentWrapper: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  approvalBadge: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'var(--accent-red, #dc2626)',
    color: '#fff',
    fontSize: 9,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
    lineHeight: 1,
    pointerEvents: 'none' as const,
  },
  iconButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 6
  }
}
