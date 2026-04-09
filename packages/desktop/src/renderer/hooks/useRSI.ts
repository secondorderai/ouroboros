import { useState, useEffect, useCallback, useRef } from 'react'
import type { SerpentState } from '../components/SerpentIcon'
import type {
  SkillInfo,
  SkillsListResult,
  EvolutionStatsResult,
  EvolutionListResult,
  EvolutionEntry
} from '../../shared/protocol'

// ── Types ────────────────────────────────────────────────────────

export interface RSIActivity {
  id: string
  description: string
  timestamp: string
}

export interface RSIStats {
  totalSkills: number
  generated: number
  sessionsAnalyzed: number
  successRate: number
}

export interface RSICrystallizationEvent {
  id: string
  skillName: string
  dismissed: boolean
}

interface CachedData<T> {
  data: T
  fetchedAt: number
}

const CACHE_TTL = 30_000 // 30 seconds

// ── Helper: translate RSI events to plain language ───────────────

function describeRSIEvent(entry: EvolutionEntry): string {
  switch (entry.type) {
    case 'reflection':
      return `Reflected on task -- ${entry.description}`
    case 'crystallization':
      return `Crystallized: ${entry.description}`
    case 'dream':
      return `Dream cycle completed -- ${entry.description}`
    case 'self-test':
      return `Self-test: ${entry.description}`
    case 'error':
      return `RSI error: ${entry.description}`
    default:
      return entry.description
  }
}

function describeNotification(channel: string, params: Record<string, unknown>): string {
  switch (channel) {
    case 'rsi/reflection':
      return `Reflected on task -- ${(params.description as string) || 'no new skill needed'}`
    case 'rsi/crystallization': {
      const outcome = params.outcome as string
      const name = params.skillName as string
      if (outcome === 'promoted') {
        return `Crystallized: \`${name}\` -- promoted to skill`
      }
      return `Crystallization attempt: ${(params.description as string) || outcome}`
    }
    case 'rsi/dream':
      return `Dream cycle completed -- ${(params.message as string) || 'done'}`
    case 'rsi/error':
      return `RSI error: ${(params.message as string) || 'unknown error'}`
    default:
      return `RSI event: ${channel}`
  }
}

// ── Relative time formatting ─────────────────────────────────────

export function formatRelativeTime(timestamp: string): string {
  const now = Date.now()
  const then = new Date(timestamp).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  return `${diffDay}d ago`
}

// ── Hook ─────────────────────────────────────────────────────────

export interface UseRSIReturn {
  serpentState: SerpentState
  drawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
  stats: RSIStats | null
  activities: RSIActivity[]
  skills: SkillInfo[]
  loading: boolean
  dreamRunning: boolean
  runDream: () => void
  crystallizations: RSICrystallizationEvent[]
  dismissCrystallization: (id: string) => void
}

export function useRSI(): UseRSIReturn {
  const [serpentState, setSerpentState] = useState<SerpentState>('idle')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [stats, setStats] = useState<RSIStats | null>(null)
  const [activities, setActivities] = useState<RSIActivity[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [dreamRunning, setDreamRunning] = useState(false)
  const [crystallizations, setCrystallizations] = useState<RSICrystallizationEvent[]>([])

  // Cache refs to avoid re-fetching within TTL
  const skillsCache = useRef<CachedData<SkillInfo[]> | null>(null)
  const statsCache = useRef<CachedData<RSIStats> | null>(null)
  const activitiesCache = useRef<CachedData<RSIActivity[]> | null>(null)

  // Timer refs for state transitions
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Data Loading ─────────────────────────────────────────────

  const isCacheValid = useCallback(<T,>(cache: CachedData<T> | null): cache is CachedData<T> => {
    if (!cache) return false
    return Date.now() - cache.fetchedAt < CACHE_TTL
  }, [])

  const loadDrawerData = useCallback(async () => {
    // Check if all caches are valid
    if (
      isCacheValid(skillsCache.current) &&
      isCacheValid(statsCache.current) &&
      isCacheValid(activitiesCache.current)
    ) {
      setSkills(skillsCache.current.data)
      setStats(statsCache.current.data)
      setActivities(activitiesCache.current.data)
      return
    }

    setLoading(true)
    try {
      const [skillsResult, statsResult, evolutionResult] = await Promise.all([
        window.ouroboros.rpc('skills/list') as Promise<SkillsListResult>,
        window.ouroboros.rpc('evolution/stats') as Promise<EvolutionStatsResult>,
        window.ouroboros.rpc('evolution/list', { limit: 20 }) as Promise<EvolutionListResult>
      ])

      const now = Date.now()

      // Process skills
      const skillsList = skillsResult.skills ?? []
      skillsCache.current = { data: skillsList, fetchedAt: now }
      setSkills(skillsList)

      // Process stats
      const rawStats = statsResult.stats ?? {}
      const processedStats: RSIStats = {
        totalSkills: skillsList.length,
        generated: skillsList.filter((s) => !s.enabled).length,
        sessionsAnalyzed: (rawStats.sessionsAnalyzed as number) ?? 0,
        successRate: (rawStats.successRate as number) ?? 0
      }
      statsCache.current = { data: processedStats, fetchedAt: now }
      setStats(processedStats)

      // Process activities
      const entries = evolutionResult.entries ?? []
      const activityList: RSIActivity[] = entries.map((entry) => ({
        id: entry.id,
        description: describeRSIEvent(entry),
        timestamp: entry.timestamp
      }))
      activitiesCache.current = { data: activityList, fetchedAt: now }
      setActivities(activityList)
    } catch {
      // Silently handle -- data will show as empty/null
    } finally {
      setLoading(false)
    }
  }, [isCacheValid])

  // ── Drawer open/close ────────────────────────────────────────

  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
    loadDrawerData()
  }, [loadDrawerData])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
  }, [])

  // ── Dream trigger ────────────────────────────────────────────

  const runDream = useCallback(async () => {
    if (dreamRunning) return
    setDreamRunning(true)
    try {
      const result = await window.ouroboros.rpc('rsi/dream') as { status: string; message: string }
      const newActivity: RSIActivity = {
        id: `dream-${Date.now()}`,
        description: `Dream cycle completed -- ${result.message || 'done'}`,
        timestamp: new Date().toISOString()
      }
      setActivities((prev) => [newActivity, ...prev].slice(0, 20))
      // Invalidate cache so next open re-fetches
      activitiesCache.current = null
      statsCache.current = null
    } catch {
      const errorActivity: RSIActivity = {
        id: `dream-error-${Date.now()}`,
        description: 'Dream cycle failed -- could not complete',
        timestamp: new Date().toISOString()
      }
      setActivities((prev) => [errorActivity, ...prev].slice(0, 20))
    } finally {
      setDreamRunning(false)
    }
  }, [dreamRunning])

  // ── Crystallization dismissal ────────────────────────────────

  const dismissCrystallization = useCallback((id: string) => {
    setCrystallizations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, dismissed: true } : c))
    )
  }, [])

  // ── RSI Notification subscriptions ───────────────────────────

  useEffect(() => {
    const unsubscribers: Array<() => void> = []

    const rsiChannels = ['rsi/reflection', 'rsi/crystallization', 'rsi/dream', 'rsi/error'] as const

    for (const channel of rsiChannels) {
      const unsub = window.ouroboros.onNotification(channel, (params) => {
        const p = (params ?? {}) as Record<string, unknown>

        // Update serpent state
        if (channel === 'rsi/crystallization' && p.outcome === 'promoted') {
          // Flash state for crystallization
          if (flashTimer.current) clearTimeout(flashTimer.current)
          if (activeTimer.current) clearTimeout(activeTimer.current)
          setSerpentState('flash')
          flashTimer.current = setTimeout(() => {
            setSerpentState('idle')
            flashTimer.current = null
          }, 1000)

          // Add inline crystallization card
          const event: RSICrystallizationEvent = {
            id: `crystal-${Date.now()}`,
            skillName: (p.skillName as string) || 'unknown',
            dismissed: false
          }
          setCrystallizations((prev) => [...prev, event])
        } else {
          // Active pulse for all other RSI events
          if (flashTimer.current === null) {
            setSerpentState('active')
            if (activeTimer.current) clearTimeout(activeTimer.current)
            activeTimer.current = setTimeout(() => {
              setSerpentState('idle')
              activeTimer.current = null
            }, 5000) // Return to idle after 5s of no new events
          }
        }

        // Add to activity feed
        const newActivity: RSIActivity = {
          id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          description: describeNotification(channel, p),
          timestamp: new Date().toISOString()
        }
        setActivities((prev) => [newActivity, ...prev].slice(0, 20))

        // Invalidate caches on events
        activitiesCache.current = null
        skillsCache.current = null
        statsCache.current = null
      })
      unsubscribers.push(unsub)
    }

    return () => {
      unsubscribers.forEach((unsub) => unsub())
      if (flashTimer.current) clearTimeout(flashTimer.current)
      if (activeTimer.current) clearTimeout(activeTimer.current)
    }
  }, [])

  return {
    serpentState,
    drawerOpen,
    openDrawer,
    closeDrawer,
    stats,
    activities,
    skills,
    loading,
    dreamRunning,
    runDream,
    crystallizations,
    dismissCrystallization
  }
}
