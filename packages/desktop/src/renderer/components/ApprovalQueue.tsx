import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useApprovals, useApprovalActions } from '../stores/approvalStore'

interface ApprovalQueueProps {
  isOpen: boolean
  onClose: () => void
}

const RISK_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  high: { bg: 'rgba(220, 38, 38, 0.12)', text: 'var(--accent-red)', label: 'High' },
  medium: { bg: 'rgba(234, 88, 12, 0.12)', text: 'var(--accent-orange)', label: 'Medium' },
  low: { bg: 'rgba(107, 107, 107, 0.12)', text: 'var(--text-secondary)', label: 'Low' },
}

export function ApprovalQueue({ isOpen, onClose }: ApprovalQueueProps): React.ReactElement | null {
  const approvals = useApprovals()
  const { respond } = useApprovalActions()
  const [exiting, setExiting] = useState(false)
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const handleClose = useCallback(() => {
    setExiting(true)
    setTimeout(() => {
      setExiting(false)
      onClose()
    }, 150)
  }, [onClose])

  // Escape key closes the queue
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleClose])

  if (!isOpen && !exiting) return null

  return createPortal(
    <div
      style={styles.backdrop}
      className={exiting ? 'approval-queue-exit' : 'approval-queue-enter'}
      onClick={handleClose}
    >
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Pending Approvals</h2>
          <button
            style={styles.closeButton}
            onClick={handleClose}
            aria-label='Close approval queue'
          >
            <CloseIcon />
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {errorMessage && <p style={styles.errorText}>{errorMessage}</p>}
          {approvals.length === 0 ? (
            <div style={styles.emptyState}>
              <CheckCircleIcon />
              <p style={styles.emptyText}>No pending approvals</p>
              <p style={styles.emptySubtext}>
                Approval requests will appear here when the agent proposes self-modifications.
              </p>
            </div>
          ) : (
            <div style={styles.list}>
              {approvals.map((approval) => {
                const riskInfo = RISK_COLORS[approval.risk] ?? RISK_COLORS.low
                return (
                  <div key={approval.id} style={styles.item}>
                    <div style={styles.itemHeader}>
                      <span style={styles.itemDescription}>{approval.description}</span>
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
                    <div style={styles.itemMeta}>
                      <span style={styles.timestamp}>{formatTimestamp(approval.timestamp)}</span>
                      <span style={styles.typeBadge}>{approval.type}</span>
                    </div>
                    {approval.lease && <LeaseDetails lease={approval.lease} />}
                    {approval.workerDiff && <WorkerDiffDetails workerDiff={approval.workerDiff} />}
                    <div style={styles.itemActions}>
                      <button
                        style={styles.approveButton}
                        onClick={async () => {
                          setSubmittingId(approval.id)
                          setErrorMessage(null)
                          try {
                            await respond(approval.id, 'approve')
                          } catch (error) {
                            const message =
                              error instanceof Error
                                ? error.message
                                : 'Failed to submit approval response'
                            setErrorMessage(message)
                          } finally {
                            setSubmittingId(null)
                          }
                        }}
                        disabled={submittingId === approval.id}
                      >
                        {submittingId === approval.id ? 'Working...' : 'Approve'}
                      </button>
                      <button
                        style={styles.denyButton}
                        onClick={async () => {
                          setSubmittingId(approval.id)
                          setErrorMessage(null)
                          try {
                            await respond(approval.id, 'deny')
                          } catch (error) {
                            const message =
                              error instanceof Error
                                ? error.message
                                : 'Failed to submit approval response'
                            setErrorMessage(message)
                          } finally {
                            setSubmittingId(null)
                          }
                        }}
                        disabled={submittingId === approval.id}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function LeaseDetails({
  lease,
}: {
  lease: NonNullable<ReturnType<typeof useApprovals>[number]['lease']>
}): React.ReactElement {
  return (
    <div style={styles.leaseDetails}>
      <div style={styles.leaseSummary}>{lease.riskSummary}</div>
      <DetailLine label='Tools' values={lease.requestedTools} />
      <DetailLine label='Paths' values={lease.requestedPaths} />
      <DetailLine label='Commands' values={lease.requestedBashCommands} />
      {lease.expiresAt && (
        <div style={styles.detailLine}>Expires: {formatFullTimestamp(lease.expiresAt)}</div>
      )}
    </div>
  )
}

function WorkerDiffDetails({
  workerDiff,
}: {
  workerDiff: NonNullable<ReturnType<typeof useApprovals>[number]['workerDiff']>
}): React.ReactElement {
  return (
    <div style={styles.leaseDetails}>
      <div style={styles.leaseSummary}>
        Worker diff: {workerDiff.changedFiles.length} changed file
        {workerDiff.changedFiles.length === 1 ? '' : 's'}
      </div>
      <div style={styles.detailLine}>Task: {workerDiff.taskId}</div>
      <div style={styles.detailLine}>Status: {workerDiff.reviewStatus.replace('-', ' ')}</div>
      {workerDiff.testResult && (
        <div style={styles.detailLine}>
          Tests: {workerDiff.testResult.status} ({workerDiff.testResult.command})
        </div>
      )}
      <DetailLine label='Files' values={workerDiff.changedFiles} />
    </div>
  )
}

function DetailLine({ label, values }: { label: string; values: string[] }): React.ReactElement {
  return (
    <div style={styles.detailLine}>
      {label}: {values.length > 0 ? values.join(', ') : 'None'}
    </div>
  )
}

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts)
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

function formatFullTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <line x1='18' y1='6' x2='6' y2='18' />
      <line x1='6' y1='6' x2='18' y2='18' />
    </svg>
  )
}

function CheckCircleIcon(): React.ReactElement {
  return (
    <svg
      width='40'
      height='40'
      viewBox='0 0 24 24'
      fill='none'
      stroke='var(--text-tertiary)'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <circle cx='12' cy='12' r='10' />
      <path d='M9 12l2 2 4-4' />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 900,
    backgroundColor: 'var(--bg-overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '80vh',
    backgroundColor: 'var(--bg-primary)',
    borderRadius: 12,
    border: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-xl)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  errorText: {
    margin: '0 0 12px 0',
    padding: '0 20px',
    fontSize: 12,
    color: 'var(--accent-red)',
    lineHeight: 1.4,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid var(--border-light)',
    flexShrink: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  closeButton: {
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
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: 20,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px 20px',
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    margin: 0,
  },
  emptySubtext: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
    textAlign: 'center' as const,
    margin: 0,
    maxWidth: 300,
    lineHeight: 1.5,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  item: {
    padding: 16,
    backgroundColor: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  itemDescription: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
  },
  riskBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
    flexShrink: 0,
  },
  itemMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  leaseDetails: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginTop: 10,
    padding: 10,
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
  detailLine: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    overflowWrap: 'anywhere',
    lineHeight: 1.4,
  },
  timestamp: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },
  typeBadge: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    backgroundColor: 'var(--bg-secondary)',
    padding: '1px 6px',
    borderRadius: 4,
  },
  itemActions: {
    display: 'flex',
    gap: 8,
  },
  approveButton: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
  },
  denyButton: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid var(--accent-red)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--accent-red)',
    cursor: 'pointer',
  },
}
