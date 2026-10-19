import { useEffect, useState } from 'react'

export function elapsedDurationMs(
  startedAt: string | null | undefined,
  now: number,
): number | null {
  if (!startedAt) return null
  const start = Date.parse(startedAt)
  return Number.isFinite(start) ? Math.max(0, now - start) : null
}

export function useElapsedDurationMs(
  startedAt: string | null | undefined,
  isRunning: boolean,
): number | null {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!startedAt || !isRunning) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [startedAt, isRunning])

  // Derive the value during render. Setting it synchronously in the mount
  // effect can amplify virtual-list remounts into a nested update loop.
  return elapsedDurationMs(startedAt, now)
}
