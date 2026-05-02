/**
 * Approval Store
 *
 * Manages pending approval requests. Provides add/remove/respond
 * operations and exposes the list of pending approvals for the UI.
 */

import { useSyncExternalStore, useCallback } from 'react'
import type {
  ApprovalItem,
  ApprovalListResult,
  ApprovalRequestNotification,
  ApprovalRespondResult,
  PermissionLeaseDisplayDetails,
  TierApprovalDisplayDetails,
  WorkerDiffDisplayDetails,
} from '../../shared/protocol'
import { useConversationStore } from './conversationStore'

export interface PendingApproval {
  id: string
  type: string
  description: string
  risk: 'high' | 'medium' | 'low'
  diff?: string
  lease?: PermissionLeaseDisplayDetails
  workerDiff?: WorkerDiffDisplayDetails
  tier?: TierApprovalDisplayDetails
  timestamp: string
}

type Listener = () => void

let approvals: PendingApproval[] = []
const listeners = new Set<Listener>()

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PendingApproval[] {
  return approvals
}

export function addApproval(approval: PendingApproval): void {
  approvals = approvals.some((existing) => existing.id === approval.id)
    ? approvals.map((existing) => (existing.id === approval.id ? approval : existing))
    : [...approvals, approval]
  emitChange()
}

export function setApprovals(nextApprovals: PendingApproval[]): void {
  approvals = nextApprovals
  emitChange()
}

export function removeApproval(id: string): void {
  approvals = approvals.filter((a) => a.id !== id)
  emitChange()
}

export async function loadApprovals(): Promise<void> {
  const result = await window.ouroboros.rpc('approval/list')
  const approvalList = result as ApprovalListResult
  setApprovals((approvalList.approvals ?? []).map(toPendingApproval))
}

export function toPendingApproval(
  approval: ApprovalItem | ApprovalRequestNotification,
): PendingApproval {
  return {
    id: approval.id,
    type: approval.type,
    description: approval.description,
    risk: approval.risk ?? 'low',
    diff: approval.diff,
    lease: approval.lease ? normalizeApprovalLease(approval.lease) : undefined,
    workerDiff: approval.workerDiff,
    tier: approval.tier,
    timestamp:
      'createdAt' in approval && approval.createdAt ? approval.createdAt : new Date().toISOString(),
  }
}

function normalizeApprovalLease(
  lease: (ApprovalItem | ApprovalRequestNotification)['lease'],
): PermissionLeaseDisplayDetails | undefined {
  if (!lease) return undefined
  return {
    ...lease,
    status: lease.status ?? 'pending',
  }
}

export async function respondToApproval(id: string, decision: 'approve' | 'deny'): Promise<void> {
  const result = (await window.ouroboros.rpc('approval/respond', {
    id,
    approved: decision === 'approve',
  })) as ApprovalRespondResult
  if (result.lease) {
    useConversationStore.getState().handlePermissionLeaseUpdated(result.lease)
  }
  if (result.workerDiff) {
    useConversationStore.getState().handleWorkerDiffUpdated(result.workerDiff)
  }
  removeApproval(id)
}

export function useApprovals(): PendingApproval[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useApprovalActions(): {
  respond: (id: string, decision: 'approve' | 'deny') => Promise<void>
} {
  const respond = useCallback((id: string, decision: 'approve' | 'deny') => {
    return respondToApproval(id, decision).catch(async (error) => {
      console.error('approval/respond failed:', error)
      throw error
    })
  }, [])
  return { respond }
}
