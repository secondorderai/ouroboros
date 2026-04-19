import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationStore } from '../stores/conversationStore'
import type { SessionData, SessionInfo } from '../../shared/protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SidebarProps {
  isOpen: boolean
  width: number
  onResize: (width: number) => void
  onOpenSettings: () => void
}

interface DateGroup {
  label: string
  sessions: SessionInfo[]
}

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfThisWeek = new Date(startOfToday)
  startOfThisWeek.setDate(startOfThisWeek.getDate() - 7)

  if (date >= startOfToday) return 'Today'
  if (date >= startOfYesterday) return 'Yesterday'
  if (date >= startOfThisWeek) return 'This Week'
  return 'Older'
}

function groupSessionsByDate(sessions: SessionInfo[]): DateGroup[] {
  const groupOrder = ['Today', 'Yesterday', 'This Week', 'Older']
  const groups = new Map<string, SessionInfo[]>()

  for (const session of sessions) {
    const label = getDateGroup(session.lastActive)
    const group = groups.get(label) ?? []
    group.push(session)
    groups.set(label, group)
  }

  return groupOrder
    .filter((label) => groups.has(label))
    .map((label) => ({ label, sessions: groups.get(label)! }))
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  const diffWeeks = Math.floor(diffDays / 7)
  return `${diffWeeks}w ago`
}

function getProcessingLabel(toolName?: string): string {
  switch (toolName) {
    case 'bash':
      return 'Running command'
    case 'file-read':
      return 'Reading files'
    case 'file-write':
      return 'Creating files'
    case 'file-edit':
      return 'Editing files'
    case 'web-fetch':
      return 'Fetching page'
    case 'web-search':
      return 'Searching web'
    case 'self-test':
      return 'Running tests'
    default:
      return 'Working'
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({
  isOpen,
  width,
  onResize,
  onOpenSettings,
}: SidebarProps): React.ReactElement {
  const sessions = useConversationStore((s) => s.sessions)
  const currentSessionId = useConversationStore((s) => s.currentSessionId)
  const setSessions = useConversationStore((s) => s.setSessions)
  const loadSession = useConversationStore((s) => s.loadSession)
  const createNewSession = useConversationStore((s) => s.createNewSession)
  const deleteSession = useConversationStore((s) => s.deleteSession)
  const setCurrentSessionId = useConversationStore((s) => s.setCurrentSessionId)

  const [contextMenu, setContextMenu] = useState<{
    sessionId: string
    x: number
    y: number
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // ---- Load sessions on mount -----------------------------------------------

  useEffect(() => {
    const api = window.ouroboros
    if (!api) return
    api
      .rpc('session/list', {})
      .then((result) => {
        const data = result as { sessions: SessionInfo[] }
        if (data?.sessions) {
          setSessions(data.sessions)
        }
      })
      .catch((err) => {
        console.error('session/list failed:', err)
      })
  }, [setSessions])

  // ---- Close context menu on click outside or Escape -------------------------

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  // ---- Handlers -------------------------------------------------------------

  const handleNewConversation = useCallback(async () => {
    const api = window.ouroboros
    if (!api) return
    try {
      const result = (await api.rpc('session/new', {})) as { sessionId: string }
      if (result?.sessionId) {
        createNewSession(result.sessionId)
      }
    } catch (err) {
      console.error('session/new failed:', err)
    }
  }, [createNewSession])

  const handleLoadSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === currentSessionId) return
      const api = window.ouroboros
      if (!api) return
      setCurrentSessionId(sessionId)
      try {
        const result = (await api.rpc('session/load', {
          id: sessionId,
        })) as SessionData
        if (result?.messages) {
          loadSession(sessionId, result.messages, result.workspacePath)
        } else {
          // No messages, just set the session as active
          setCurrentSessionId(sessionId)
        }
      } catch (err) {
        console.error('session/load failed:', err)
      }
    },
    [currentSessionId, loadSession, setCurrentSessionId],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.preventDefault()
      setContextMenu({ sessionId, x: e.clientX, y: e.clientY })
    },
    [],
  )

  const handleDeleteClick = useCallback(() => {
    if (!contextMenu) return
    setConfirmDelete(contextMenu.sessionId)
    setContextMenu(null)
  }, [contextMenu])

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return
    const api = window.ouroboros
    if (!api) return
    try {
      await api.rpc('session/delete', { id: confirmDelete })
      deleteSession(confirmDelete)
    } catch (err) {
      console.error('session/delete failed:', err)
    }
    setConfirmDelete(null)
  }, [confirmDelete, deleteSession])

  const handleCancelDelete = useCallback(() => {
    setConfirmDelete(null)
  }, [])

  useEffect(() => {
    if (!confirmDelete) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmDelete(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [confirmDelete])

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) return
      onResize(resizeState.startWidth + (e.clientX - resizeState.startX))
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

  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isOpen) return
    resizeStateRef.current = { startX: e.clientX, startWidth: width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [isOpen, width])

  // ---- Render ---------------------------------------------------------------

  const dateGroups = groupSessionsByDate(sessions)

  return (
    <div
      style={{
        ...styles.sidebar,
        width: isOpen ? width : 0,
        minWidth: isOpen ? width : 0,
        opacity: isOpen ? 1 : 0,
        overflow: 'hidden',
      }}
      className="no-select"
    >
      <div style={{ ...styles.content, width }}>
        <div style={styles.header}>
          <span style={styles.headerText}>Sessions</span>
          <button
            style={styles.newButton}
            onClick={handleNewConversation}
            title="New conversation"
            aria-label="New conversation"
          >
            <PlusIcon />
          </button>
        </div>

        <div style={styles.sessionList}>
          {dateGroups.length === 0 ? (
            <div style={styles.placeholder}>
              <span style={styles.placeholderText}>No sessions yet</span>
            </div>
          ) : (
            dateGroups.map((group) => (
              <div key={group.label} style={styles.dateGroup}>
                <div style={styles.dateLabel}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={session.id === currentSessionId}
                    width={width}
                    onClick={() => handleLoadSession(session.id)}
                    onContextMenu={(e) => handleContextMenu(e, session.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      <div style={styles.footer}>
        <div style={styles.footerLabel}>App</div>
        <button
          style={styles.settingsItem}
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
        >
          <SettingsIcon />
          <span>Settings</span>
        </button>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            ...styles.contextMenu,
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          <button style={styles.contextMenuItem} onClick={handleDeleteClick}>
            <TrashIcon />
            <span>Delete</span>
          </button>
        </div>
      )}

      {confirmDelete && (
        <div style={styles.overlay}>
          <div style={styles.dialog}>
            <p style={styles.dialogText}>
              Delete this session? This action cannot be undone.
            </p>
            <div style={styles.dialogButtons}>
              <button
                style={styles.dialogButtonCancel}
                onClick={handleCancelDelete}
              >
                Cancel
              </button>
              <button
                style={styles.dialogButtonDelete}
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={250}
        aria-valuemax={560}
        aria-valuenow={width}
        style={{
          ...styles.resizeHandle,
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
        className="no-drag"
        onPointerDown={handleResizeStart}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SessionItem
// ---------------------------------------------------------------------------

function SessionItem({
  session,
  isActive,
  width,
  onClick,
  onContextMenu,
}: {
  session: SessionInfo
  isActive: boolean
  width: number
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}): React.ReactElement {
  const title = session.title || 'New conversation'
  const lineClamp = width >= 460 ? 4 : width >= 360 ? 3 : 2
  const isProcessing = session.runStatus === 'running'
  const hasError = session.runStatus === 'error'

  return (
    <button
      style={{
        ...styles.sessionItem,
        backgroundColor: isActive ? 'var(--bg-sidebar-active)' : 'transparent',
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      aria-label={`Session: ${title}`}
      aria-current={isActive ? 'true' : undefined}
    >
      <div style={styles.sessionTitleRow}>
        <div
          style={{
            ...styles.sessionTitle,
            WebkitLineClamp: lineClamp,
            maxHeight: `${lineClamp * 1.3}em`,
          }}
        >
          {title}
        </div>
        {isProcessing && (
          <span
            style={styles.sessionProcessingDot}
            className='session-processing-dot'
            title='Session is still processing'
            aria-label='Session is still processing'
          />
        )}
      </div>
      <div style={styles.sessionMeta}>
        <span
          style={{
            ...styles.sessionTime,
            ...(isProcessing ? styles.sessionProcessingText : {}),
            ...(hasError ? styles.sessionErrorText : {}),
          }}
        >
          {isProcessing
            ? getProcessingLabel(session.activeToolName)
            : hasError
              ? 'Needs attention'
              : relativeTime(session.lastActive)}
        </span>
        {session.messageCount > 0 && (
          <span style={styles.sessionBadge}>{session.messageCount}</span>
        )}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function PlusIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function TrashIcon(): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  )
}

function SettingsIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    height: '100%',
    backgroundColor: 'var(--bg-sidebar)',
    borderRight: '1px solid var(--border-light)',
    transition: 'width 0.2s ease, min-width 0.2s ease, opacity 0.2s ease',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 12px 8px',
    flexShrink: 0,
  },
  headerText: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.05em',
  },
  newButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    border: '1px solid var(--border-light)',
    background: 'var(--bg-primary)',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 0,
  },
  sessionList: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '0 8px 8px',
  },
  dateGroup: {
    marginBottom: 4,
  },
  dateLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.04em',
    padding: '8px 8px 4px',
  },
  sessionItem: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: '8px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    gap: 3,
    fontFamily: 'var(--font-sans)',
    transition: 'background-color 0.1s ease',
  },
  sessionTitleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    minWidth: 0,
  },
  sessionTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    lineHeight: 1.3,
    wordBreak: 'break-word',
    flex: 1,
    minWidth: 0,
  },
  sessionMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  sessionTime: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  sessionProcessingText: {
    color: 'var(--accent-amber)',
    fontWeight: 600,
  },
  sessionErrorText: {
    color: 'var(--accent-red)',
    fontWeight: 600,
  },
  sessionProcessingDot: {
    width: 8,
    height: 8,
    marginTop: 5,
    borderRadius: '50%',
    backgroundColor: 'var(--accent-amber)',
    boxShadow: '0 0 0 3px var(--accent-amber-bg)',
    flexShrink: 0,
    animation: 'ob-pulse 1.2s ease-in-out infinite',
  },
  sessionBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 16,
    padding: '0 5px',
    backgroundColor: 'var(--accent-amber-bg)',
    color: 'var(--accent-amber)',
    borderRadius: 'var(--radius-full)',
    fontSize: 10,
    fontWeight: 600,
    lineHeight: 1,
  },
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  placeholderText: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
  },
  contextMenu: {
    position: 'fixed',
    zIndex: 1000,
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-medium)',
    borderRadius: 'var(--radius-standard)',
    boxShadow: 'var(--shadow-md)',
    padding: 4,
    minWidth: 120,
  },
  contextMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-micro)',
    color: 'var(--accent-red)',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--bg-overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
  },
  dialog: {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-medium)',
    borderRadius: 'var(--radius-large)',
    boxShadow: 'var(--shadow-lg)',
    padding: 24,
    maxWidth: 340,
    width: '90%',
  },
  dialogText: {
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-primary)',
    lineHeight: 1.5,
    margin: '0 0 16px',
  },
  dialogButtons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  dialogButtonCancel: {
    padding: '6px 14px',
    border: '1px solid var(--border-light)',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
  },
  dialogButtonDelete: {
    padding: '6px 14px',
    border: 'none',
    backgroundColor: 'var(--accent-red)',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-inverse)',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    cursor: 'pointer',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: -4,
    width: 8,
    height: '100%',
    cursor: 'col-resize',
    zIndex: 2,
  },
  footer: {
    padding: '12px',
    borderTop: '1px solid var(--border-light)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  footerLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.04em',
    padding: '0 8px 2px',
  },
  settingsItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 10px',
    border: 'none',
    background: 'transparent',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background-color 0.1s ease',
  },
}
