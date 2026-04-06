import React, { useState, useCallback } from 'react'
import type { PendingApproval } from '../stores/approvalStore'

interface ApprovalToastProps {
  approval: PendingApproval
  onRespond: (id: string, decision: 'approve' | 'deny') => void
}

const RISK_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  high: { bg: 'rgba(220, 38, 38, 0.12)', text: 'var(--accent-red)', label: 'High Risk' },
  medium: { bg: 'rgba(234, 88, 12, 0.12)', text: 'var(--accent-orange)', label: 'Medium Risk' },
  low: { bg: 'rgba(107, 107, 107, 0.12)', text: 'var(--text-secondary)', label: 'Low Risk' },
}

export function ApprovalToast({
  approval,
  onRespond,
}: ApprovalToastProps): React.ReactElement {
  const [exiting, setExiting] = useState(false)

  const handleRespond = useCallback(
    (decision: 'approve' | 'deny') => {
      setExiting(true)
      // Wait for slide-out animation before removing
      setTimeout(() => {
        onRespond(approval.id, decision)
      }, 200)
    },
    [approval.id, onRespond]
  )

  const riskInfo = RISK_COLORS[approval.risk] ?? RISK_COLORS.low

  const diffLines = approval.diff
    ? approval.diff.split('\n').slice(0, 5).join('\n')
    : null

  return (
    <div
      className={exiting ? 'approval-toast-exit' : 'approval-toast-enter'}
      style={styles.toast}
    >
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Approval Required</span>
        <span
          style={{
            ...styles.riskBadge,
            backgroundColor: riskInfo.bg,
            color: riskInfo.text,
          }}
        >
          {riskInfo.label}
        </span>
      </div>

      {/* Description */}
      <p style={styles.description}>{approval.description}</p>

      {/* Diff preview */}
      {diffLines && (
        <pre style={styles.diffPreview}>{diffLines}</pre>
      )}

      {/* Actions */}
      <div style={styles.actions}>
        <button
          style={styles.approveButton}
          onClick={() => handleRespond('approve')}
        >
          Approve
        </button>
        <button
          style={styles.denyButton}
          onClick={() => handleRespond('deny')}
        >
          Deny
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
  riskBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
  },
  description: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    margin: '0 0 12px 0',
  },
  diffPreview: {
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
  approveButton: {
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
  denyButton: {
    flex: 1,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid var(--accent-red)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--accent-red)',
    cursor: 'pointer',
  },
}
