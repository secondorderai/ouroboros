import { create } from 'zustand'
import type {
  ModeEnteredNotification,
  ModeExitedNotification,
  ModeState,
  ModePlanSubmittedNotification,
  Plan,
} from '../../shared/protocol'

const INACTIVE_MODE_STATE: ModeState = { status: 'inactive' }

export interface ModeStoreState {
  modeState: ModeState
  lastPlan: Plan | null
  isHydrating: boolean
  isMutating: boolean
  error: string | null
  initialized: boolean
  hydrate: () => Promise<void>
  enterMode: (modeId: string) => Promise<void>
  exitMode: () => Promise<void>
  applyModeEntered: (notification: ModeEnteredNotification) => void
  applyModeExited: (_notification: ModeExitedNotification) => void
  applyPlanSubmitted: (notification: ModePlanSubmittedNotification) => void
  clearError: () => void
}

export function getModeDisplayName(modeId: string): string {
  if (modeId === 'plan') return 'Plan'

  return modeId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export const useModeStore = create<ModeStoreState>((set) => ({
  modeState: INACTIVE_MODE_STATE,
  lastPlan: null,
  isHydrating: false,
  isMutating: false,
  error: null,
  initialized: false,

  async hydrate() {
    if (typeof window === 'undefined' || !window.ouroboros) return

    set({ isHydrating: true, error: null })

    try {
      const [modeState, lastPlan] = await Promise.all([
        window.ouroboros.rpc('mode/getState', {}),
        window.ouroboros.rpc('mode/getPlan', {}),
      ])

      set({
        modeState,
        lastPlan,
        initialized: true,
        isHydrating: false,
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load mode state',
        initialized: true,
        isHydrating: false,
      })
    }
  },

  async enterMode(modeId: string) {
    if (typeof window === 'undefined' || !window.ouroboros) return

    set({ isMutating: true, error: null })

    try {
      await window.ouroboros.rpc('mode/enter', { mode: modeId })
      set({
        modeState: {
          status: 'active',
          modeId,
          enteredAt: new Date().toISOString(),
        },
        isMutating: false,
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to enter mode',
        isMutating: false,
      })
    }
  },

  async exitMode() {
    if (typeof window === 'undefined' || !window.ouroboros) return

    set({ isMutating: true, error: null })

    try {
      await window.ouroboros.rpc('mode/exit', {})
      set({
        modeState: INACTIVE_MODE_STATE,
        isMutating: false,
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to exit mode',
        isMutating: false,
      })
    }
  },

  applyModeEntered(notification) {
    set({
      modeState: {
        status: 'active',
        modeId: notification.modeId,
        enteredAt: new Date().toISOString(),
      },
      error: null,
    })
  },

  applyModeExited() {
    set({
      modeState: INACTIVE_MODE_STATE,
      error: null,
    })
  },

  applyPlanSubmitted(notification) {
    set({
      lastPlan: notification.plan,
      error: null,
    })
  },

  clearError() {
    set({ error: null })
  },
}))
