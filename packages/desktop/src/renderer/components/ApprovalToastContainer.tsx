import React from 'react'
import { createPortal } from 'react-dom'
import { ApprovalToast } from './ApprovalToast'
import { SandboxNoticeToast } from './SandboxNoticeToast'
import { useApprovals, useApprovalActions } from '../stores/approvalStore'
import { useSandboxNotices, dismissSandboxNotice } from '../stores/sandboxNoticeStore'

interface ApprovalToastContainerProps {
  /** Opens the settings overlay at the sandbox section. */
  onOpenSettings?: () => void
}

/**
 * Renders all pending approval and sandbox-notice toasts in a fixed
 * top-right container. Uses a React portal to render at root level above
 * all other content.
 */
export function ApprovalToastContainer({
  onOpenSettings,
}: ApprovalToastContainerProps = {}): React.ReactElement | null {
  const approvals = useApprovals()
  const sandboxNotices = useSandboxNotices()
  const { respond } = useApprovalActions()

  if (approvals.length === 0 && sandboxNotices.length === 0) return null

  return createPortal(
    <div style={styles.container}>
      {approvals.map((approval) => (
        <ApprovalToast
          key={approval.id}
          approval={approval}
          onRespond={respond}
        />
      ))}
      {sandboxNotices.map((notice) => (
        <SandboxNoticeToast
          key={notice.id}
          notice={notice}
          onDismiss={dismissSandboxNotice}
          onOpenSettings={onOpenSettings}
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
