import { useState, useEffect, useCallback, useRef } from 'react'
import type { SerpentState } from '../components/SerpentIcon'
import type {
  SkillInfo,
  SkillsListResult,
  EvolutionStatsResult,
  EvolutionListResult,
  EvolutionEntry,
  RsiRuntimeNotification,
  RSIHistorySummary,
  RsiHistoryResult,
  RsiCheckpointResult,
  RSICheckpointDetail,
  RsiDreamResult,
} from '../../shared/protocol'

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

export type RSITab = 'overview' | 'history' | 'skills'
export type RSIHistoryFilter =
  | 'all'
  | 'reflections'
  | 'crystallizations'
  | 'dream'
  | 'memory'
  | 'errors'
export type RSIHistorySource = 'checkpoint' | 'evolution'

export interface RSIHistoryChip {
  label: string
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}

export interface RSIHistoryEntryView {
  id: string
  source: RSIHistorySource
  category: RSIHistoryFilter
  title: string
  summary: string
  timestamp: string
  sessionId?: string
  skillName?: string
  typeLabel: string
  chips: RSIHistoryChip[]
  details?: Record<string, unknown>
}

interface CachedData<T> {
  data: T
  fetchedAt: number
}

const CACHE_TTL = 30_000

function mergeActivities(existing: RSIActivity[], incoming: RSIActivity[]): RSIActivity[] {
  const merged = new Map<string, RSIActivity>()
  for (const activity of [...existing, ...incoming]) {
    merged.set(activity.id, activity)
  }

  return [...merged.values()]
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 20)
}

function mergeHistoryEntries(
  existing: RSIHistoryEntryView[],
  incoming: RSIHistoryEntryView[],
): RSIHistoryEntryView[] {
  const merged = new Map<string, RSIHistoryEntryView>()
  for (const entry of [...existing, ...incoming]) {
    merged.set(entry.id, entry)
  }

  return [...merged.values()].sort(
    (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
  )
}

function describeRSIEvent(entry: EvolutionEntry): string {
  switch (entry.type) {
    case 'reflection':
      return `Reflected on task -- ${entry.description}`
    case 'crystallization':
      return `Crystallized: ${entry.description}`
    case 'dream':
    case 'memory-consolidated':
      return `Dream cycle completed -- ${entry.description}`
    case 'self-test':
      return `Self-test: ${entry.description}`
    case 'observation-recorded':
      return `Observed session activity -- ${entry.description}`
    case 'checkpoint-written':
      return `Checkpoint saved -- ${entry.description}`
    case 'context-flushed':
      return `Prepared memory flush -- ${entry.description}`
    case 'history-compacted':
      return `Compacted long session -- ${entry.description}`
    case 'length-recovery-succeeded':
      return `Recovered after context limit -- ${entry.description}`
    case 'length-recovery-failed':
      return `Context-limit recovery failed -- ${entry.description}`
    case 'durable-memory-promoted':
      return `Promoted durable memory -- ${entry.description}`
    case 'durable-memory-pruned':
      return `Pruned durable memory -- ${entry.description}`
    case 'skill-proposed-from-observations':
      return `Queued skill proposal -- ${entry.description}`
    case 'error':
      return `RSI error: ${entry.description}`
    default:
      return entry.description
  }
}

function formatDreamSummary(result: RsiDreamResult): string {
  const parts: string[] = []
  if (result.topicsCreated > 0) parts.push(`${result.topicsCreated} created`)
  if (result.topicsMerged > 0) parts.push(`${result.topicsMerged} merged`)
  if (result.topicsPruned > 0) parts.push(`${result.topicsPruned} pruned`)
  if (result.contradictionsResolved > 0) {
    parts.push(`${result.contradictionsResolved} contradiction${result.contradictionsResolved === 1 ? '' : 's'} resolved`)
  }
  if (result.durablePromotions.length > 0) {
    parts.push(`${result.durablePromotions.length} promoted to durable memory`)
  }
  if (parts.length === 0) {
    return result.sessionsAnalyzed > 0
      ? `Analyzed ${result.sessionsAnalyzed} session${result.sessionsAnalyzed === 1 ? '' : 's'}, no changes`
      : 'No changes'
  }
  return parts.join(', ')
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function toTone(value: RSIHistoryFilter): RSIHistoryChip['tone'] {
  switch (value) {
    case 'crystallizations':
      return 'accent'
    case 'dream':
      return 'success'
    case 'memory':
      return 'neutral'
    case 'errors':
      return 'danger'
    default:
      return 'warning'
  }
}

export function categorizeEvolutionEntry(type: string): RSIHistoryFilter {
  switch (type) {
    case 'reflection':
      return 'reflections'
    case 'crystallization':
    case 'skill-created':
    case 'skill-promoted':
    case 'skill-failed':
    case 'skill-proposal':
    case 'skill-proposed-from-observations':
      return 'crystallizations'
    case 'dream':
    case 'memory-consolidated':
      return 'dream'
    case 'error':
      return 'errors'
    default:
      return 'memory'
  }
}

function typeLabelForCategory(category: RSIHistoryFilter): string {
  switch (category) {
    case 'reflections':
      return 'Reflection'
    case 'crystallizations':
      return 'Crystallization'
    case 'dream':
      return 'Dream'
    case 'errors':
      return 'Error'
    case 'memory':
      return 'Memory'
    default:
      return 'Activity'
  }
}

function describeRuntimeEvent(eventType: string, payload: Record<string, unknown>): string {
  const count = typeof payload.count === 'number' ? payload.count : null
  const checkpointAt = pickString(payload.checkpointUpdatedAt, payload.updatedAt)
  const summary = pickString(
    payload.summary,
    payload.message,
    payload.description,
    payload.reason,
    payload.goal,
    payload.nextStep,
    payload.outcome,
  )

  switch (eventType) {
    case 'rsi-observation-recorded': {
      const observationLabel =
        count === 1 ? '1 observation' : count != null ? `${count} observations` : 'New observations'
      return summary ? `Observed session activity -- ${summary}` : `${observationLabel} recorded`
    }
    case 'rsi-checkpoint-written':
      if (checkpointAt) return `Checkpoint saved -- ${checkpointAt}`
      return summary ? `Checkpoint saved -- ${summary}` : 'Checkpoint saved for the active session'
    case 'rsi-context-flushed':
      return summary
        ? `Prepared memory flush -- ${summary}`
        : 'Prepared memory flush before trimming older context'
    case 'rsi-history-compacted':
      return summary
        ? `Compacted long session -- ${summary}`
        : 'Compacted long session and kept a short live tail'
    case 'rsi-length-recovery-succeeded':
      return summary
        ? `Recovered after context limit -- ${summary}`
        : 'Recovered after hitting the model context limit'
    case 'rsi-length-recovery-failed':
      return summary
        ? `Context-limit recovery failed -- ${summary}`
        : 'Could not recover automatically after hitting the context limit'
    case 'rsi-durable-memory-promoted':
      return summary
        ? `Promoted durable memory -- ${summary}`
        : 'Promoted validated memory into durable storage'
    case 'rsi-durable-memory-pruned':
      return summary
        ? `Pruned durable memory -- ${summary}`
        : 'Pruned outdated durable memory entries'
    case 'rsi-skill-proposed-from-observations':
      return summary
        ? `Queued skill proposal -- ${summary}`
        : 'Queued a skill proposal from repeated observations'
    default:
      return summary ? `RSI runtime activity -- ${summary}` : `RSI runtime activity -- ${eventType}`
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
    case 'rsi/runtime':
      return describeRuntimeEvent(
        typeof params.eventType === 'string' ? params.eventType : 'unknown',
        ((params.payload as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>,
      )
    default:
      return `RSI event: ${channel}`
  }
}

export function historyEntryFromCheckpoint(summary: RSIHistorySummary): RSIHistoryEntryView {
  return {
    id: `checkpoint:${summary.sessionId}`,
    source: 'checkpoint',
    category: 'reflections',
    title: summary.goal || 'Reflection checkpoint',
    summary: summary.nextBestStep || 'Checkpoint updated',
    timestamp: summary.updatedAt,
    sessionId: summary.sessionId,
    typeLabel: 'Checkpoint',
    chips: [
      { label: `${summary.openLoopCount} open loops` },
      { label: `${summary.durableCandidateCount} durable`, tone: 'neutral' },
      { label: `${summary.skillCandidateCount} skills`, tone: 'accent' },
    ],
    details: {
      openLoopCount: summary.openLoopCount,
      durableCandidateCount: summary.durableCandidateCount,
      skillCandidateCount: summary.skillCandidateCount,
    },
  }
}

export function historyEntryFromEvolution(entry: EvolutionEntry): RSIHistoryEntryView {
  const category = categorizeEvolutionEntry(entry.type)
  const chips: RSIHistoryChip[] = [
    { label: typeLabelForCategory(category), tone: toTone(category) },
  ]
  if (entry.skillName) {
    chips.push({ label: entry.skillName, tone: 'accent' })
  }
  if (entry.sessionId) {
    chips.push({ label: entry.sessionId, tone: 'neutral' })
  }

  return {
    id: `evolution:${entry.id}`,
    source: 'evolution',
    category,
    title: describeRSIEvent(entry),
    summary: entry.description,
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    skillName: entry.skillName,
    typeLabel: typeLabelForCategory(category),
    chips,
    details: entry.details,
  }
}

function historyEntryFromNotification(
  channel: string,
  params: Record<string, unknown>,
  timestamp: string,
): RSIHistoryEntryView {
  let category: RSIHistoryFilter = 'memory'
  let typeLabel = 'Memory'
  let sessionId: string | undefined
  let skillName: string | undefined
  let details: Record<string, unknown> | undefined

  if (channel === 'rsi/reflection') {
    category = 'reflections'
    typeLabel = 'Reflection'
  } else if (channel === 'rsi/crystallization') {
    category = 'crystallizations'
    typeLabel = 'Crystallization'
    skillName = typeof params.skillName === 'string' ? params.skillName : undefined
  } else if (channel === 'rsi/dream') {
    category = 'dream'
    typeLabel = 'Dream'
  } else if (channel === 'rsi/error') {
    category = 'errors'
    typeLabel = 'Error'
  } else if (channel === 'rsi/runtime') {
    const runtime = params as unknown as RsiRuntimeNotification
    const eventType = runtime.eventType
    const payload = runtime.payload ?? {}
    details = payload
    sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined

    if (eventType === 'rsi-checkpoint-written') {
      category = 'reflections'
      typeLabel = 'Checkpoint'
    } else if (eventType === 'rsi-skill-proposed-from-observations') {
      category = 'crystallizations'
      typeLabel = 'Crystallization'
      skillName = typeof payload.skillName === 'string' ? payload.skillName : undefined
    } else if (
      eventType === 'rsi-length-recovery-failed' ||
      eventType === 'rsi-length-recovery-succeeded'
    ) {
      category = payload.recoverable === false ? 'errors' : 'memory'
      typeLabel = category === 'errors' ? 'Error' : 'Memory'
    }
  }

  return {
    id: `runtime:${channel}:${timestamp}:${Math.random().toString(36).slice(2, 6)}`,
    source: 'evolution',
    category,
    title: describeNotification(channel, params),
    summary: describeNotification(channel, params),
    timestamp,
    sessionId,
    skillName,
    typeLabel,
    chips: [{ label: typeLabel, tone: toTone(category) }],
    details,
  }
}

function matchesFilter(entry: RSIHistoryEntryView, filter: RSIHistoryFilter): boolean {
  return filter === 'all' || entry.category === filter
}

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

export function formatAbsoluteTime(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

export function historyDateGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfThisWeek = new Date(startOfToday)
  startOfThisWeek.setDate(startOfThisWeek.getDate() - 7)

  if (date >= startOfToday) return 'Today'
  if (date >= startOfYesterday) return 'Yesterday'
  if (date >= startOfThisWeek) return 'This Week'
  return 'Older'
}

export interface UseRSIReturn {
  serpentState: SerpentState
  drawerOpen: boolean
  openDrawer: () => void
  closeDrawer: () => void
  activeTab: RSITab
  setActiveTab: (tab: RSITab) => void
  historyFilter: RSIHistoryFilter
  setHistoryFilter: (filter: RSIHistoryFilter) => void
  selectedHistoryItemId: string | null
  selectHistoryItem: (id: string | null) => void
  selectedHistoryItem: RSIHistoryEntryView | null
  selectedCheckpoint: RSICheckpointDetail | null
  stats: RSIStats | null
  overviewActivities: RSIActivity[]
  historyEntries: RSIHistoryEntryView[]
  visibleHistoryEntries: RSIHistoryEntryView[]
  skills: SkillInfo[]
  loading: boolean
  historyDetailLoading: boolean
  dreamRunning: boolean
  runDream: () => void
  crystallizations: RSICrystallizationEvent[]
  dismissCrystallization: (id: string) => void
}

export function useRSI(): UseRSIReturn {
  const [serpentState, setSerpentState] = useState<SerpentState>('idle')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<RSITab>('overview')
  const [historyFilter, setHistoryFilter] = useState<RSIHistoryFilter>('all')
  const [selectedHistoryItemId, setSelectedHistoryItemId] = useState<string | null>(null)
  const [stats, setStats] = useState<RSIStats | null>(null)
  const [overviewActivities, setOverviewActivities] = useState<RSIActivity[]>([])
  const [historyEntries, setHistoryEntries] = useState<RSIHistoryEntryView[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false)
  const [dreamRunning, setDreamRunning] = useState(false)
  const [crystallizations, setCrystallizations] = useState<RSICrystallizationEvent[]>([])
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<RSICheckpointDetail | null>(null)

  const skillsCache = useRef<CachedData<SkillInfo[]> | null>(null)
  const statsCache = useRef<CachedData<RSIStats> | null>(null)
  const activitiesCache = useRef<CachedData<RSIActivity[]> | null>(null)
  const evolutionCache = useRef<CachedData<RSIHistoryEntryView[]> | null>(null)
  const checkpointHistoryCache = useRef<CachedData<RSIHistoryEntryView[]> | null>(null)
  const checkpointDetailCache = useRef<Map<string, CachedData<RSICheckpointDetail | null>>>(
    new Map(),
  )

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isCacheValid = useCallback(<T>(cache: CachedData<T> | null): cache is CachedData<T> => {
    if (!cache) return false
    return Date.now() - cache.fetchedAt < CACHE_TTL
  }, [])

  const invalidateCaches = useCallback(() => {
    skillsCache.current = null
    statsCache.current = null
    activitiesCache.current = null
    evolutionCache.current = null
    checkpointHistoryCache.current = null
  }, [])

  const loadDrawerData = useCallback(async () => {
    if (
      isCacheValid(skillsCache.current) &&
      isCacheValid(statsCache.current) &&
      isCacheValid(activitiesCache.current) &&
      isCacheValid(evolutionCache.current) &&
      isCacheValid(checkpointHistoryCache.current)
    ) {
      setSkills(skillsCache.current.data)
      setStats(statsCache.current.data)
      setOverviewActivities((prev) => mergeActivities(prev, activitiesCache.current!.data))
      setHistoryEntries(
        mergeHistoryEntries(checkpointHistoryCache.current.data, evolutionCache.current.data),
      )
      return
    }

    setLoading(true)
    try {
      const [skillsResult, statsResult, evolutionResult, checkpointHistoryResult] =
        await Promise.all([
          window.ouroboros.rpc('skills/list') as Promise<SkillsListResult>,
          window.ouroboros.rpc('evolution/stats') as Promise<EvolutionStatsResult>,
          window.ouroboros.rpc('evolution/list', { limit: 80 }) as Promise<EvolutionListResult>,
          window.ouroboros.rpc('rsi/history', { limit: 40 }) as Promise<RsiHistoryResult>,
        ])

      const now = Date.now()

      const skillsList = skillsResult.skills ?? []
      skillsCache.current = { data: skillsList, fetchedAt: now }
      setSkills(skillsList)

      const rawStats = statsResult.stats ?? {}
      const processedStats: RSIStats = {
        totalSkills: skillsList.length,
        generated: skillsList.filter((skill) => !skill.enabled).length,
        sessionsAnalyzed: (rawStats.sessionsAnalyzed as number) ?? 0,
        successRate: (rawStats.successRate as number) ?? 0,
      }
      statsCache.current = { data: processedStats, fetchedAt: now }
      setStats(processedStats)

      const evolutionEntries = (evolutionResult.entries ?? []).map(historyEntryFromEvolution)
      const checkpointEntries = (checkpointHistoryResult.entries ?? []).map(
        historyEntryFromCheckpoint,
      )
      evolutionCache.current = { data: evolutionEntries, fetchedAt: now }
      checkpointHistoryCache.current = { data: checkpointEntries, fetchedAt: now }
      setHistoryEntries((prev) =>
        mergeHistoryEntries(prev, mergeHistoryEntries(checkpointEntries, evolutionEntries)),
      )

      const entryActivities = (evolutionResult.entries ?? []).map((entry) => ({
        id: entry.id,
        description: describeRSIEvent(entry),
        timestamp: entry.timestamp,
      }))
      activitiesCache.current = { data: entryActivities, fetchedAt: now }
      setOverviewActivities((prev) => mergeActivities(prev, entryActivities))
    } catch {
      // Leave empty state on transport failure.
    } finally {
      setLoading(false)
    }
  }, [isCacheValid])

  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
    loadDrawerData()
  }, [loadDrawerData])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
  }, [])

  const runDream = useCallback(async () => {
    if (dreamRunning) return
    setDreamRunning(true)
    try {
      const result = (await window.ouroboros.rpc('rsi/dream')) as RsiDreamResult
      const now = new Date().toISOString()
      const summary = formatDreamSummary(result)
      const chips: RSIHistoryChip[] = [{ label: 'Dream', tone: 'success' }]
      if (result.durablePromotions.length > 0) {
        chips.push({
          label: `${result.durablePromotions.length} promoted`,
          tone: 'accent',
        })
      }
      if (result.skillProposals.length > 0) {
        chips.push({
          label: `${result.skillProposals.length} skill proposal${result.skillProposals.length === 1 ? '' : 's'}`,
          tone: 'accent',
        })
      }
      const newActivity: RSIActivity = {
        id: `dream-${Date.now()}`,
        description: `Dream cycle completed — ${summary}`,
        timestamp: now,
      }
      const dreamEntry: RSIHistoryEntryView = {
        id: `dream:${Date.now()}`,
        source: 'evolution',
        category: 'dream',
        title: 'Dream cycle completed',
        summary,
        timestamp: now,
        typeLabel: 'Dream',
        chips,
      }
      setOverviewActivities((prev) => mergeActivities([newActivity], prev))
      setHistoryEntries((prev) => mergeHistoryEntries([dreamEntry], prev))
      invalidateCaches()
    } catch (error) {
      const now = new Date().toISOString()
      const message = error instanceof Error ? error.message : 'could not complete'
      const errorActivity: RSIActivity = {
        id: `dream-error-${Date.now()}`,
        description: `Dream cycle failed — ${message}`,
        timestamp: now,
      }
      const errorEntry: RSIHistoryEntryView = {
        id: `dream-error:${Date.now()}`,
        source: 'evolution',
        category: 'errors',
        title: 'Dream cycle failed',
        summary: message,
        timestamp: now,
        typeLabel: 'Dream',
        chips: [{ label: 'Dream', tone: 'danger' }],
      }
      setOverviewActivities((prev) => mergeActivities([errorActivity], prev))
      setHistoryEntries((prev) => mergeHistoryEntries([errorEntry], prev))
    } finally {
      setDreamRunning(false)
    }
  }, [dreamRunning, invalidateCaches])

  const dismissCrystallization = useCallback((id: string) => {
    setCrystallizations((prev) =>
      prev.map((crystallization) =>
        crystallization.id === id ? { ...crystallization, dismissed: true } : crystallization,
      ),
    )
  }, [])

  const selectHistoryItem = useCallback((id: string | null) => {
    setSelectedHistoryItemId(id)
  }, [])

  const visibleHistoryEntries = historyEntries.filter((entry) =>
    matchesFilter(entry, historyFilter),
  )
  const selectedHistoryItem =
    visibleHistoryEntries.find((entry) => entry.id === selectedHistoryItemId) ??
    historyEntries.find((entry) => entry.id === selectedHistoryItemId) ??
    null

  useEffect(() => {
    if (visibleHistoryEntries.length === 0) {
      if (selectedHistoryItemId !== null) {
        setSelectedHistoryItemId(null)
      }
      return
    }

    if (
      selectedHistoryItemId == null ||
      !visibleHistoryEntries.some((entry) => entry.id === selectedHistoryItemId)
    ) {
      setSelectedHistoryItemId(visibleHistoryEntries[0].id)
    }
  }, [selectedHistoryItemId, visibleHistoryEntries])

  useEffect(() => {
    if (
      !drawerOpen ||
      selectedHistoryItem?.source !== 'checkpoint' ||
      !selectedHistoryItem.sessionId
    ) {
      setHistoryDetailLoading(false)
      setSelectedCheckpoint(null)
      return
    }

    const cached = checkpointDetailCache.current.get(selectedHistoryItem.sessionId)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      setSelectedCheckpoint(cached.data)
      return
    }

    let cancelled = false
    setHistoryDetailLoading(true)
    window.ouroboros
      .rpc('rsi/checkpoint', { sessionId: selectedHistoryItem.sessionId })
      .then((result) => {
        if (cancelled) return
        const checkpoint = (result as RsiCheckpointResult).checkpoint ?? null
        checkpointDetailCache.current.set(selectedHistoryItem.sessionId!, {
          data: checkpoint,
          fetchedAt: Date.now(),
        })
        setSelectedCheckpoint(checkpoint)
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedCheckpoint(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryDetailLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [drawerOpen, selectedHistoryItem])

  useEffect(() => {
    const unsubscribers: Array<() => void> = []

    const rsiChannels = [
      'rsi/reflection',
      'rsi/crystallization',
      'rsi/dream',
      'rsi/error',
      'rsi/runtime',
    ] as const

    for (const channel of rsiChannels) {
      const unsubscribe = window.ouroboros.onNotification(channel, (params) => {
        const payload = (params ?? {}) as Record<string, unknown>
        const runtimeParams = (params ?? {}) as RsiRuntimeNotification

        if (channel === 'rsi/crystallization' && payload.outcome === 'promoted') {
          if (flashTimer.current) clearTimeout(flashTimer.current)
          if (activeTimer.current) clearTimeout(activeTimer.current)
          setSerpentState('flash')
          flashTimer.current = setTimeout(() => {
            setSerpentState('idle')
            flashTimer.current = null
          }, 1000)

          const crystallizationEvent: RSICrystallizationEvent = {
            id: `crystal-${Date.now()}`,
            skillName: (payload.skillName as string) || 'unknown',
            dismissed: false,
          }
          setCrystallizations((prev) => [...prev, crystallizationEvent])
        } else if (flashTimer.current === null) {
          setSerpentState('active')
          if (activeTimer.current) clearTimeout(activeTimer.current)
          activeTimer.current = setTimeout(() => {
            setSerpentState('idle')
            activeTimer.current = null
          }, 5000)
        }

        const timestamp = new Date().toISOString()
        const activity: RSIActivity = {
          id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          description:
            channel === 'rsi/runtime'
              ? describeRuntimeEvent(runtimeParams.eventType, runtimeParams.payload ?? {})
              : describeNotification(channel, payload),
          timestamp,
        }
        setOverviewActivities((prev) => mergeActivities([activity], prev))
        setHistoryEntries((prev) =>
          mergeHistoryEntries([historyEntryFromNotification(channel, payload, timestamp)], prev),
        )
        invalidateCaches()
      })
      unsubscribers.push(unsubscribe)
    }

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      if (flashTimer.current) clearTimeout(flashTimer.current)
      if (activeTimer.current) clearTimeout(activeTimer.current)
    }
  }, [invalidateCaches])

  return {
    serpentState,
    drawerOpen,
    openDrawer,
    closeDrawer,
    activeTab,
    setActiveTab,
    historyFilter,
    setHistoryFilter,
    selectedHistoryItemId,
    selectHistoryItem,
    selectedHistoryItem,
    selectedCheckpoint,
    stats,
    overviewActivities,
    historyEntries,
    visibleHistoryEntries,
    skills,
    loading,
    historyDetailLoading,
    dreamRunning,
    runDream,
    crystallizations,
    dismissCrystallization,
  }
}
