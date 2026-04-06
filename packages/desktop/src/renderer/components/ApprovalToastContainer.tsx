import React from 'react'
import { createPortal } from 'react-dom'
import { ApprovalToast } from './ApprovalToast'
import { useApprovals, useApprovalActions } from '../stores/approvalStore'

/**
 * Renders all pending approval toasts in a fixed top-right container.
 * Uses a React portal to render at root level above all other content.
 */
export function ApprovalToastContainer(): React.ReactElement | null {
  const approvals = useApprovals()
  const { respond } = useApprovalActions()

  if (approvals.length === 0) return null

  return createPortal(
    <div style={styles.container}>
      {approvals.map((approval) => (
        <ApprovalToast
          key={approval.id}
          approval={approval}
          onRespond={respond}
        />
      ))}
    </div>,
    document.body
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    top: 16,
    right: 16,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    pointerEvents: 'none',
  },
}
