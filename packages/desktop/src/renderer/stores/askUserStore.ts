import { useCallback, useSyncExternalStore } from 'react'
import type { AskUserRequestNotification } from '../../shared/protocol'

export interface PendingAskUserRequest {
  id: string
  question: string
  options: string[]
  createdAt: string
}

type Listener = () => void

let activeRequest: PendingAskUserRequest | null = null
let queuedRequests: PendingAskUserRequest[] = []
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

function getSnapshot(): PendingAskUserRequest | null {
  return activeRequest
}

export function addAskUserRequest(request: AskUserRequestNotification): void {
  const normalized: PendingAskUserRequest = {
    id: request.id,
    question: request.question,
    options: Array.isArray(request.options) ? request.options : [],
    createdAt: request.createdAt,
  }

  if (!activeRequest) {
    activeRequest = normalized
  } else if (activeRequest.id === normalized.id) {
    activeRequest = normalized
  } else {
    queuedRequests = queuedRequests.some((queued) => queued.id === normalized.id)
      ? queuedRequests.map((queued) => (queued.id === normalized.id ? normalized : queued))
      : [...queuedRequests, normalized]
  }

  emitChange()
}

export function clearAskUserRequests(): void {
  activeRequest = null
  queuedRequests = []
  emitChange()
}

function removeActiveRequest(id: string): void {
  if (activeRequest?.id !== id) return
  activeRequest = queuedRequests[0] ?? null
  queuedRequests = queuedRequests.slice(1)
  emitChange()
}

export async function respondToAskUser(id: string, response: string): Promise<void> {
  await window.ouroboros.rpc('askUser/respond', { id, response })
  removeActiveRequest(id)
}

export function useActiveAskUserRequest(): PendingAskUserRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useAskUserActions(): {
  respond: (id: string, response: string) => Promise<void>
} {
  const respond = useCallback((id: string, response: string) => respondToAskUser(id, response), [])
  return { respond }
}
