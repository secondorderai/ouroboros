/**
 * Approval Store
 *
 * Manages pending approval requests. Provides add/remove/respond
 * operations and exposes the list of pending approvals for the UI.
 */

import { useSyncExternalStore, useCallback } from 'react'

export interface PendingApproval {
  id: string
  type: string
  description: string
  risk: 'high' | 'medium' | 'low'
  diff?: string
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
  approvals = [...approvals, approval]
  emitChange()
}

export function removeApproval(id: string): void {
  approvals = approvals.filter((a) => a.id !== id)
  emitChange()
}

export function respondToApproval(
  id: string,
  decision: 'approve' | 'deny'
): void {
  window.ouroboros.rpc('approval/respond', {
    id,
    approved: decision === 'approve',
  })
  removeApproval(id)
}

export function useApprovals(): PendingApproval[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useApprovalActions(): {
  respond: (id: string, decision: 'approve' | 'deny') => void
} {
  const respond = useCallback(
    (id: string, decision: 'approve' | 'deny') => {
      respondToApproval(id, decision)
    },
    []
  )
  return { respond }
}
