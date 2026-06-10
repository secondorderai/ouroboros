import React from 'react'
import type { SandboxNotice } from '../stores/sandboxNoticeStore'

interface SandboxNoticeToastProps {
  notice: SandboxNotice
  onDismiss: (id: string) => void
  onOpenSettings?: () => void
}

/**
 * Toast for OS-sandbox notices: a blocked command (violation) or the
 * warn-once "running unsandboxed" fallback. Shares the ApprovalToast shell
 * and DESIGN.md CSS variables; rendered from the ApprovalToastContainer
 * stack.
 */
export function SandboxNoticeToast({
  notice,
  onDismiss,
  onOpenSettings,
}: SandboxNoticeToastProps): React.ReactElement {
  const isViolation = notice.kind === 'violation'

  return (
    <div className='approval-toast-enter' style={styles.toast} role='status'>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>{isViolation ? 'Command Blocked' : 'Sandbox Unavailable'}</span>
        <span style={styles.badge}>{isViolation ? 'Sandbox blocked' : 'Sandbox off'}</span>
      </div>

      {/* Description */}
      {isViolation ? (
        <>
          <p style={styles.description}>
            The OS sandbox blocked a {notice.toolName ?? 'tool'} command
            {notice.indicator ? ` (${notice.indicator})` : ''}. The agent can request human
            approval to retry without the sandbox.
          </p>
          {notice.commandSummary && <pre style={styles.commandPreview}>{notice.commandSummary}</pre>}
        </>
      ) : (
        <p style={styles.description}>
          The OS sandbox is unavailable{notice.reason ? ` (${notice.reason})` : ''}. Commands run
          unsandboxed for this session.
        </p>
      )}

      {/* Actions */}
      <div style={styles.actions}>
        {onOpenSettings && (
          <button style={styles.settingsButton} onClick={() => onOpenSettings()}>
            Open sandbox settings
          </button>
        )}
        <button style={styles.dismissButton} onClick={() => onDismiss(notice.id)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  toast: {
    width: 340,
    backgroundColor: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
    borderRadius: 12,
    boxShadow: 'var(--shadow-lg)',
    padding: 16,
    pointerEvents: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
    backgroundColor: 'var(--accent-amber-bg)',
    color: 'var(--accent-amber)',
  },
  description: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    margin: '0 0 12px 0',
  },
  commandPreview: {
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 6,
    padding: 8,
    margin: '0 0 12px 0',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    maxHeight: 100,
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  settingsButton: {
    flex: 1,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
  },
  dismissButton: {
    flex: 1,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
}
