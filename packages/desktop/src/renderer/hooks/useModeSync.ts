import { useEffect } from 'react'
import { useModeStore } from '../stores/modeStore'

/**
 * Keeps renderer mode state synchronized with the CLI-backed JSON-RPC mode APIs.
 * Call once near the top of the app so settings and composer controls stay aligned.
 */
export function useModeSync(): void {
  useEffect(() => {
    const api = window.ouroboros
    if (!api) return

    const { hydrate, applyModeEntered, applyModeExited, applyPlanSubmitted } =
      useModeStore.getState()

    void hydrate()

    const unsubs = [
      api.onNotification('mode/entered', (params) => {
        applyModeEntered(params)
      }),
      api.onNotification('mode/exited', (params) => {
        applyModeExited(params)
      }),
      api.onNotification('mode/planSubmitted', (params) => {
        applyPlanSubmitted(params)
      }),
    ]

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
  }, [])
}
