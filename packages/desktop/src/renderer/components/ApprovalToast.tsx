import React, { useState, useCallback } from 'react'
import type { PendingApproval } from '../stores/approvalStore'

interface ApprovalToastProps {
  approval: PendingApproval
  onRespond: (id: string, decision: 'approve' | 'deny') => Promise<void>
}

const RISK_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  high: { bg: 'rgba(220, 38, 38, 0.12)', text: 'var(--accent-red)', label: 'High Risk' },
  medium: { bg: 'rgba(234, 88, 12, 0.12)', text: 'var(--accent-orange)', label: 'Medium Risk' },
  low: { bg: 'rgba(107, 107, 107, 0.12)', text: 'var(--text-secondary)', label: 'Low Risk' },
}

export function ApprovalToast({ approval, onRespond }: ApprovalToastProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRespond = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (submitting) return
      setSubmitting(true)
      setError(null)
      try {
        await onRespond(approval.id, decision)
      } catch (responseError) {
        const message =
          responseError instanceof Error
            ? responseError.message
            : 'Failed to submit approval response'
        setError(message)
      } finally {
        setSubmitting(false)
      }
    },
    [approval.id, onRespond, submitting],
  )

  const riskInfo = RISK_COLORS[approval.risk] ?? RISK_COLORS.low

  const diffLines = approval.diff ? approval.diff.split('\n').slice(0, 5).join('\n') : null

  return (
    <div className='approval-toast-enter' style={styles.toast}>
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
      {diffLines && <pre style={styles.diffPreview}>{diffLines}</pre>}

      {approval.lease && (
        <div style={styles.leaseDetails}>
          <div style={styles.leaseSummary}>{approval.lease.riskSummary}</div>
          <div style={styles.leaseLine}>Tools: {formatList(approval.lease.requestedTools)}</div>
          <div style={styles.leaseLine}>Paths: {formatList(approval.lease.requestedPaths)}</div>
          <div style={styles.leaseLine}>
            Commands: {formatList(approval.lease.requestedBashCommands)}
          </div>
          {approval.lease.expiresAt && (
            <div style={styles.leaseLine}>
              Expires: {new Date(approval.lease.expiresAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {approval.workerDiff && (
        <div style={styles.leaseDetails}>
          <div style={styles.leaseSummary}>
            Worker diff: {approval.workerDiff.changedFiles.length} files
          </div>
          <div style={styles.leaseLine}>Task: {approval.workerDiff.taskId}</div>
          <div style={styles.leaseLine}>
            Status: {approval.workerDiff.reviewStatus.replace('-', ' ')}
          </div>
          {approval.workerDiff.testResult && (
            <div style={styles.leaseLine}>
              Tests: {approval.workerDiff.testResult.status} (
              {approval.workerDiff.testResult.command})
            </div>
          )}
        </div>
      )}

      {error && <p style={styles.errorText}>{error}</p>}

      {/* Actions */}
      <div style={styles.actions}>
        <button
          style={styles.approveButton}
          onClick={() => handleRespond('approve')}
          disabled={submitting}
        >
          {submitting ? 'Working...' : 'Approve'}
        </button>
        <button
          style={styles.denyButton}
          onClick={() => handleRespond('deny')}
          disabled={submitting}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'None'
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
  leaseDetails: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    margin: '0 0 12px 0',
    padding: 8,
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 8,
  },
  leaseSummary: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
  },
  leaseLine: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    lineHeight: 1.35,
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    color: 'var(--accent-red)',
    margin: '0 0 12px 0',
    lineHeight: 1.4,
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
