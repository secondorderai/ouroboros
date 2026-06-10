/**
 * Sandbox Notice Store
 *
 * Holds pending sandbox notices surfaced as toasts: OS-sandbox violations
 * (`sandbox/violation`) and the warn-once unavailable fallback
 * (`sandbox/unavailable`). Mirrors the approvalStore external-store pattern.
 *
 * `sandbox/unavailable` is deduped to a single notice per renderer lifetime:
 * the CLI emits it once per process, but CLI restarts within one desktop
 * session would otherwise re-toast the same condition.
 */

import { useSyncExternalStore } from 'react'
import type {
  SandboxUnavailableNotification,
  SandboxViolationNotification,
} from '../../shared/protocol'

export type SandboxNoticeKind = 'violation' | 'unavailable'

export interface SandboxNotice {
  id: string
  kind: SandboxNoticeKind
  /** Tool that hit the sandbox ('bash', 'code-exec'); empty for unavailable notices. */
  toolName?: string
  /** Truncated command text (violations only). */
  commandSummary?: string
  /** Which classifier signature matched (violations only). */
  indicator?: string
  /** Why the sandbox is unavailable (unavailable notices only). */
  reason?: string
  timestamp: string
}

type Listener = () => void

let notices: SandboxNotice[] = []
let unavailableNoticeSeen = false
let nextNoticeId = 1
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

function getSnapshot(): SandboxNotice[] {
  return notices
}

export function addSandboxViolationNotice(params: SandboxViolationNotification): void {
  notices = [
    ...notices,
    {
      id: `sandbox-notice-${nextNoticeId++}`,
      kind: 'violation',
      toolName: params.toolName,
      commandSummary: params.commandSummary,
      indicator: params.indicator,
      timestamp: new Date().toISOString(),
    },
  ]
  emitChange()
}

export function addSandboxUnavailableNotice(params: SandboxUnavailableNotification): void {
  if (unavailableNoticeSeen) return
  unavailableNoticeSeen = true
  notices = [
    ...notices,
    {
      id: `sandbox-notice-${nextNoticeId++}`,
      kind: 'unavailable',
      reason: params.reason,
      timestamp: new Date().toISOString(),
    },
  ]
  emitChange()
}

export function dismissSandboxNotice(id: string): void {
  notices = notices.filter((notice) => notice.id !== id)
  emitChange()
}

/** Reset all state, including the unavailable dedupe flag. Test helper. */
export function clearSandboxNotices(): void {
  notices = []
  unavailableNoticeSeen = false
  emitChange()
}

/** Current pending notices (non-React readers and tests). */
export function getSandboxNoticesSnapshot(): SandboxNotice[] {
  return getSnapshot()
}

export function useSandboxNotices(): SandboxNotice[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
