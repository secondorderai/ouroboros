/**
 * Dream Cycle — Between-Session Memory Consolidation
 *
 * The dream cycle consolidates structured RSI memory into curated durable memory,
 * updates daily rollups, and can still generate skill proposals from transcripts.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readCheckpoint } from '@src/memory/checkpoints'
import { getMemoryIndex, updateMemoryIndex } from '@src/memory/index'
import {
  resolveCheckpointsDir,
  resolveDailyMemoryDir,
  resolveObservationsDir,
} from '@src/memory/paths'
import { readObservations } from '@src/memory/observations'
import type {
  DurableMemoryCandidate,
  ObservationRecord,
  ReflectionCheckpoint,
} from '@src/rsi/types'
import { type Result, err, ok } from '@src/types'
import type { SessionWithMessages } from './transcripts'

// ── Types ──────────────────────────────────────────────────────────

export interface DreamOptions {
  /** How many recent sessions to analyze (default 5) */
  sessionCount?: number
  /** What aspects of the dream cycle to run */
  mode?: 'full' | 'consolidate-only' | 'propose-only'
}

export interface DreamResult {
  sessionsAnalyzed: number
  topicsMerged: number
  topicsCreated: number
  topicsPruned: number
  contradictionsResolved: number
  skillProposals: SkillProposal[]
  memoryIndexUpdated: boolean
  durablePromotions: string[]
  durablePrunes: string[]
  contradictionsResolvedEntries: string[]
  dailyMemoryFilesUpdated: string[]
}

export interface SkillProposal {
  proposedName: string
  description: string
  rationale: string
  estimatedImpact: 'high' | 'medium' | 'low'
  sourceSessions: string[]
}

export interface StoredSkillProposal extends SkillProposal {
  timestamp: string
  status: 'pending' | 'accepted' | 'rejected' | 'built'
}

export interface TranscriptInsights {
  sessions: SessionInsight[]
  crossSessionPatterns: string[]
  repeatedSequences: string[]
  struggles: string[]
}

export interface SessionInsight {
  sessionId: string
  summary: string
  tasksAttempted: string[]
  toolsUsed: string[]
  outcomes: Array<{ task: string; success: boolean }>
  patterns: string[]
}

export interface ConsolidationResult {
  topicsMerged: number
  topicsCreated: number
  topicsPruned: number
  contradictionsResolved: number
  memoryIndexUpdated: boolean
  durablePromotions: string[]
  durablePrunes: string[]
  contradictionsResolvedEntries: string[]
  dailyMemoryFilesUpdated: string[]
}

export interface SkillCatalogEntry {
  name: string
  description: string
}

/**
 * LLM function signature for dependency injection.
 * Accepts a prompt and returns a string response.
 */
export type LLMGenerateFn = (prompt: string) => Promise<Result<string>>

/**
 * Dependencies for the dream cycle, injected for testability.
 */
export interface DreamDeps {
  /** LLM generation function */
  generateFn: LLMGenerateFn
  /** Get recent sessions from the transcript store */
  getRecentSessions: (limit: number) => Result<Array<{ id: string }>>
  /** Get a full session with messages */
  getSession: (sessionId: string) => Result<SessionWithMessages>
  /** Base path for memory operations */
  basePath?: string
}

type DurableKind = DurableMemoryCandidate['kind']

interface StructuredDreamState {
  checkpoints: ReflectionCheckpoint[]
  observations: ObservationRecord[]
  dailyFiles: DailyMemoryFile[]
}

interface DailyMemoryFile {
  date: string
  path: string
  content: string
}

interface CandidateRecord extends DurableMemoryCandidate {
  sessionId: string
  source: 'checkpoint' | 'observation'
  sourceId: string
}

interface ManagedDurableEntry {
  key: string
  title: string
  content: string
  kind: DurableKind
}

interface PromotionDecision {
  key: string
  title: string
  content: string
  kind: DurableKind
  observedAt: string
  sources: CandidateRecord[]
}

const EMPTY_INSIGHTS: TranscriptInsights = {
  sessions: [],
  crossSessionPatterns: [],
  repeatedSequences: [],
  struggles: [],
}

const DURABLE_START = '<!-- dream:durable:start -->'
const DURABLE_END = '<!-- dream:durable:end -->'
const AUDIT_START = '<!-- dream:audit:start -->'
const AUDIT_END = '<!-- dream:audit:end -->'
const ROLLUP_START = '<!-- dream:rollup:start -->'
const ROLLUP_END = '<!-- dream:rollup:end -->'
const NONE = '_None_'
const durableKinds: DurableKind[] = ['fact', 'preference', 'constraint', 'workflow']
const durableSectionLabels: Record<DurableKind, string> = {
  fact: 'Facts',
  preference: 'Preferences',
  constraint: 'Constraints',
  workflow: 'Workflows',
}
const durableSectionKinds = Object.fromEntries(
  Object.entries(durableSectionLabels).map(([kind, label]) => [label, kind]),
) as Record<string, DurableKind>
const transientTags = new Set([
  'transient',
  'daily-only',
  'daily_only',
  'working-memory',
  'working_memory',
  'checkpoint',
  'plan',
  'current-plan',
  'current_plan',
  'next-step',
  'next_step',
  'open-loop',
])

// ── Main Entry Point ──────────────────────────────────────────────

/**
 * Run the dream cycle — between-session memory consolidation.
 *
 * @param deps - Injected dependencies (LLM, transcript store, base path)
 * @param options - Configuration for this dream run
 * @returns Result containing the DreamResult summary
 */
export async function dream(
  deps: DreamDeps,
  options: DreamOptions = {},
): Promise<Result<DreamResult>> {
  try {
    const sessionCount = options.sessionCount ?? 5
    const mode = options.mode ?? 'full'
    const structuredResult = loadStructuredDreamState(deps.basePath)
    if (!structuredResult.ok) {
      return structuredResult
    }

    const sessionSummaryResult = deps.getRecentSessions(sessionCount)
    if (!sessionSummaryResult.ok) {
      return sessionSummaryResult
    }

    const sessions: SessionWithMessages[] = []
    for (const summary of sessionSummaryResult.value) {
      const sessionResult = deps.getSession(summary.id)
      if (sessionResult.ok) {
        sessions.push(sessionResult.value)
      }
    }

    const shouldAnalyzeSessions =
      sessions.length > 0 && (mode === 'full' || mode === 'propose-only')
    const insightsResult = shouldAnalyzeSessions
      ? await analyzeTranscripts(deps.generateFn, sessions)
      : ok(EMPTY_INSIGHTS)
    if (!insightsResult.ok) {
      return insightsResult
    }
    const insights = insightsResult.value

    const hasStructuredMemory =
      structuredResult.value.checkpoints.length > 0 ||
      structuredResult.value.observations.length > 0 ||
      structuredResult.value.dailyFiles.length > 0

    if (sessions.length === 0 && !hasStructuredMemory) {
      return ok({
        sessionsAnalyzed: 0,
        topicsMerged: 0,
        topicsCreated: 0,
        topicsPruned: 0,
        contradictionsResolved: 0,
        skillProposals: [],
        memoryIndexUpdated: false,
        durablePromotions: [],
        durablePrunes: [],
        contradictionsResolvedEntries: [],
        dailyMemoryFilesUpdated: [],
      })
    }

    let consolidation: ConsolidationResult = {
      topicsMerged: 0,
      topicsCreated: 0,
      topicsPruned: 0,
      contradictionsResolved: 0,
      memoryIndexUpdated: false,
      durablePromotions: [],
      durablePrunes: [],
      contradictionsResolvedEntries: [],
      dailyMemoryFilesUpdated: [],
    }

    let proposals: SkillProposal[] = []

    if (mode === 'full' || mode === 'consolidate-only') {
      const memoryResult = getMemoryIndex(deps.basePath)
      if (!memoryResult.ok) {
        return memoryResult
      }

      const consolidationResult = await consolidateMemory(
        insights,
        memoryResult.value,
        structuredResult.value,
        deps.basePath,
      )
      if (!consolidationResult.ok) {
        return consolidationResult
      }
      consolidation = consolidationResult.value
    }

    if (mode === 'full' || mode === 'propose-only') {
      if (insights.sessions.length > 0) {
        const proposalResult = await proposeSkills(deps.generateFn, insights, [])
        if (!proposalResult.ok) {
          return proposalResult
        }
        proposals = proposalResult.value

        if (proposals.length > 0) {
          const storeResult = storeProposals(proposals, deps.basePath)
          if (!storeResult.ok) {
            return storeResult
          }
        }
      }
    }

    return ok({
      sessionsAnalyzed: sessions.length,
      topicsMerged: consolidation.topicsMerged,
      topicsCreated: consolidation.topicsCreated,
      topicsPruned: consolidation.topicsPruned,
      contradictionsResolved: consolidation.contradictionsResolved,
      skillProposals: proposals,
      memoryIndexUpdated: consolidation.memoryIndexUpdated,
      durablePromotions: consolidation.durablePromotions,
      durablePrunes: consolidation.durablePrunes,
      contradictionsResolvedEntries: consolidation.contradictionsResolvedEntries,
      dailyMemoryFilesUpdated: consolidation.dailyMemoryFilesUpdated,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Dream cycle failed: ${message}`))
  }
}

// ── Stage 1: Transcript Analysis ──────────────────────────────────

/**
 * Analyze session transcripts to extract insights.
 * Uses a two-pass approach: summarize each session, then cross-reference.
 */
export async function analyzeTranscripts(
  generateFn: LLMGenerateFn,
  sessions: SessionWithMessages[],
): Promise<Result<TranscriptInsights>> {
  try {
    const sessionInsights: SessionInsight[] = []

    for (const session of sessions) {
      const messagesText = session.messages
        .map((m) => {
          const toolInfo = m.toolName ? ` [tool: ${m.toolName}]` : ''
          return `${m.role}${toolInfo}: ${m.content.slice(0, 500)}`
        })
        .join('\n')

      const prompt = `Analyze this session transcript and return a JSON object with the following fields:
- summary (string): A brief summary of the session
- tasksAttempted (string[]): List of tasks the user/agent attempted
- toolsUsed (string[]): List of tool names used
- outcomes (array of {task: string, success: boolean}): Outcome of each task
- patterns (string[]): Any notable patterns or approaches observed

Session ID: ${session.id}
Transcript:
${messagesText}

Return ONLY valid JSON, no markdown fences.`

      const result = await generateFn(prompt)
      if (!result.ok) {
        sessionInsights.push({
          sessionId: session.id,
          summary: 'Failed to analyze session',
          tasksAttempted: [],
          toolsUsed: extractToolNames(session),
          outcomes: [],
          patterns: [],
        })
        continue
      }

      try {
        const parsed = JSON.parse(result.value) as {
          summary?: string
          tasksAttempted?: string[]
          toolsUsed?: string[]
          outcomes?: Array<{ task: string; success: boolean }>
          patterns?: string[]
        }
        sessionInsights.push({
          sessionId: parsed.summary ? session.id : session.id,
          summary: parsed.summary ?? 'No summary',
          tasksAttempted: parsed.tasksAttempted ?? [],
          toolsUsed: parsed.toolsUsed ?? extractToolNames(session),
          outcomes: parsed.outcomes ?? [],
          patterns: parsed.patterns ?? [],
        })
      } catch {
        sessionInsights.push({
          sessionId: session.id,
          summary: result.value.slice(0, 200),
          tasksAttempted: [],
          toolsUsed: extractToolNames(session),
          outcomes: [],
          patterns: [],
        })
      }
    }

    const summariesText = sessionInsights
      .map((s) => `Session ${s.sessionId}: ${s.summary}\nPatterns: ${s.patterns.join(', ')}`)
      .join('\n\n')

    const crossRefPrompt = `Analyze these session summaries and identify cross-session patterns. Return a JSON object with:
- crossSessionPatterns (string[]): Patterns that appear across multiple sessions
- repeatedSequences (string[]): Multi-step sequences repeated across sessions
- struggles (string[]): Areas where the agent struggled repeatedly

Summaries:
${summariesText}

Return ONLY valid JSON, no markdown fences.`

    const crossRefResult = await generateFn(crossRefPrompt)
    let crossSessionPatterns: string[] = []
    let repeatedSequences: string[] = []
    let struggles: string[] = []

    if (crossRefResult.ok) {
      try {
        const parsed = JSON.parse(crossRefResult.value) as {
          crossSessionPatterns?: string[]
          repeatedSequences?: string[]
          struggles?: string[]
        }
        crossSessionPatterns = parsed.crossSessionPatterns ?? []
        repeatedSequences = parsed.repeatedSequences ?? []
        struggles = parsed.struggles ?? []
      } catch {
        // Keep empty cross-session data.
      }
    }

    return ok({
      sessions: sessionInsights,
      crossSessionPatterns,
      repeatedSequences,
      struggles,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Transcript analysis failed: ${message}`))
  }
}

// ── Stage 2: Structured Memory Consolidation ──────────────────────

/**
 * Consolidate structured memory into curated durable memory and daily rollups.
 */
export async function consolidateMemory(
  insights: TranscriptInsights,
  memoryIndex: string,
  structured: StructuredDreamState,
  basePath?: string,
): Promise<Result<ConsolidationResult>> {
  try {
    const existingEntries = parseManagedDurableEntries(memoryIndex)
    const candidates = collectDurableCandidates(structured)
    const selection = selectPromotions(candidates, existingEntries, insights)

    const updatedMemory = renderUpdatedMemoryIndex(memoryIndex, selection)
    let memoryIndexUpdated = false
    if (updatedMemory !== memoryIndex) {
      const updateResult = updateMemoryIndex(updatedMemory, basePath)
      if (!updateResult.ok) {
        return updateResult
      }
      memoryIndexUpdated = true
    }

    const dailyUpdateResult = updateDailyMemoryFiles(structured, selection)
    if (!dailyUpdateResult.ok) {
      return dailyUpdateResult
    }

    return ok({
      topicsMerged: 0,
      topicsCreated: selection.promotions.length,
      topicsPruned: selection.prunes.length,
      contradictionsResolved: selection.contradictions.length,
      memoryIndexUpdated,
      durablePromotions: selection.promotions.map((entry) => `${entry.title} (${entry.kind})`),
      durablePrunes: selection.prunes.map((entry) => `${entry.title} (${entry.kind})`),
      contradictionsResolvedEntries: selection.contradictions,
      dailyMemoryFilesUpdated: dailyUpdateResult.value,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Memory consolidation failed: ${message}`))
  }
}

interface PromotionSelection {
  promotions: PromotionDecision[]
  prunes: ManagedDurableEntry[]
  contradictions: string[]
}

function loadStructuredDreamState(basePath?: string): Result<StructuredDreamState> {
  try {
    const checkpoints = loadCheckpoints(basePath)
    if (!checkpoints.ok) {
      return checkpoints
    }

    const observations = loadObservations(basePath)
    if (!observations.ok) {
      return observations
    }

    const dailyFiles = loadDailyFiles(basePath)
    return ok({
      checkpoints: checkpoints.value,
      observations: observations.value,
      dailyFiles,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to load structured dream state: ${message}`))
  }
}

function loadCheckpoints(basePath?: string): Result<ReflectionCheckpoint[]> {
  const dir = resolveCheckpointsDir(basePath)
  if (!existsSync(dir)) {
    return ok([])
  }

  const checkpoints: ReflectionCheckpoint[] = []
  for (const entry of readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    const sessionId = entry.slice(0, -3)
    const checkpointResult = readCheckpoint(sessionId, basePath)
    if (!checkpointResult.ok) {
      return checkpointResult
    }
    if (checkpointResult.value) {
      checkpoints.push(checkpointResult.value)
    }
  }

  return ok(checkpoints)
}

function loadObservations(basePath?: string): Result<ObservationRecord[]> {
  const dir = resolveObservationsDir(basePath)
  if (!existsSync(dir)) {
    return ok([])
  }

  const observations: ObservationRecord[] = []
  for (const entry of readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()) {
    const sessionId = entry.slice(0, -'.jsonl'.length)
    const observationResult = readObservations(sessionId, basePath)
    if (!observationResult.ok) {
      return observationResult
    }
    observations.push(...observationResult.value)
  }

  return ok(
    observations.sort((left, right) => {
      const timeDiff = Date.parse(left.observedAt) - Date.parse(right.observedAt)
      if (timeDiff !== 0) {
        return timeDiff
      }
      return left.id.localeCompare(right.id)
    }),
  )
}

function loadDailyFiles(basePath?: string): DailyMemoryFile[] {
  const dir = resolveDailyMemoryDir(basePath)
  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      date: name.slice(0, -3),
      path: join(dir, name),
      content: readFileSync(join(dir, name), 'utf-8'),
    }))
}

function getTagValue(tags: string[], prefix: string): string | undefined {
  const match = tags.find((tag) => tag.startsWith(`${prefix}:`))
  return match ? match.slice(prefix.length + 1).trim() : undefined
}

function hasTransientTag(tags: string[]): boolean {
  return tags.some((tag) => transientTags.has(tag))
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildDurableKey(kind: DurableKind, title: string): string {
  return `${kind}:${normalizeKey(title)}`
}

function observationPriorityToConfidence(priority: ObservationRecord['priority']): number {
  switch (priority) {
    case 'critical':
      return 0.95
    case 'high':
      return 0.85
    case 'normal':
      return 0.7
    case 'low':
      return 0.5
  }
}

function inferObservationDurableKind(observation: ObservationRecord): DurableKind {
  const explicit = getTagValue(observation.tags, 'kind')
  if (explicit && durableKinds.includes(explicit as DurableKind)) {
    return explicit as DurableKind
  }

  if (observation.kind === 'preference' || observation.tags.includes('preference')) {
    return 'preference'
  }

  if (observation.kind === 'constraint' || observation.tags.includes('constraint')) {
    return 'constraint'
  }

  if (observation.tags.includes('workflow')) {
    return 'workflow'
  }

  return 'fact'
}

function candidateFromObservation(observation: ObservationRecord): CandidateRecord | null {
  if (!['candidate-durable', 'fact', 'preference', 'constraint'].includes(observation.kind)) {
    return null
  }

  if (hasTransientTag(observation.tags)) {
    return null
  }

  const title = getTagValue(observation.tags, 'title') ?? observation.summary
  const content = getTagValue(observation.tags, 'content') ?? observation.summary
  const kind = inferObservationDurableKind(observation)

  return {
    title,
    summary: observation.summary,
    content,
    kind,
    confidence: observationPriorityToConfidence(observation.priority),
    observedAt: observation.effectiveAt ?? observation.observedAt,
    tags: observation.tags,
    evidence: observation.evidence,
    sessionId: observation.sessionId,
    source: 'observation',
    sourceId: observation.id,
  }
}

function collectDurableCandidates(structured: StructuredDreamState): CandidateRecord[] {
  const candidates: CandidateRecord[] = []

  for (const checkpoint of structured.checkpoints) {
    for (const candidate of checkpoint.durableMemoryCandidates) {
      candidates.push({
        ...candidate,
        sessionId: checkpoint.sessionId,
        source: 'checkpoint',
        sourceId: `${checkpoint.sessionId}:${normalizeKey(candidate.title)}`,
      })
    }
  }

  for (const observation of structured.observations) {
    const candidate = candidateFromObservation(observation)
    if (candidate) {
      candidates.push(candidate)
    }
  }

  return candidates
}

function parseManagedDurableEntries(memoryIndex: string): ManagedDurableEntry[] {
  const block = extractManagedBlock(memoryIndex, DURABLE_START, DURABLE_END)
  if (!block) {
    return []
  }

  const lines = block.split('\n')
  const entries: ManagedDurableEntry[] = []
  let currentKind: DurableKind | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('### ')) {
      currentKind = durableSectionKinds[line.slice(4).trim()] ?? null
      continue
    }

    if (!currentKind || !line.startsWith('- ')) {
      continue
    }

    const match = line.slice(2).split(' :: ')
    if (match.length < 2) {
      continue
    }

    const title = match[0].trim()
    const content = match.slice(1).join(' :: ').trim()
    entries.push({
      key: buildDurableKey(currentKind, title),
      title,
      content,
      kind: currentKind,
    })
  }

  return entries
}

function selectPromotions(
  candidates: CandidateRecord[],
  existingEntries: ManagedDurableEntry[],
  insights: TranscriptInsights,
): PromotionSelection {
  const groups = new Map<string, CandidateRecord[]>()
  for (const candidate of candidates) {
    const key = buildDurableKey(candidate.kind, candidate.title)
    const current = groups.get(key) ?? []
    current.push(candidate)
    groups.set(key, current)
  }

  const promotions: PromotionDecision[] = []
  const prunes: ManagedDurableEntry[] = []
  const contradictions: string[] = []
  const existingByKey = new Map(existingEntries.map((entry) => [entry.key, entry]))

  for (const [key, group] of groups) {
    const contentGroups = new Map<string, CandidateRecord[]>()
    for (const candidate of group) {
      const current = contentGroups.get(candidate.content) ?? []
      current.push(candidate)
      contentGroups.set(candidate.content, current)
    }

    let selectedContent = ''
    let selectedSources: CandidateRecord[] = []
    let selectedScore = -1
    for (const [content, contentSources] of contentGroups) {
      const distinctSessions = new Set(contentSources.map((item) => item.sessionId)).size
      const maxConfidence = Math.max(...contentSources.map((item) => item.confidence))
      const latestObservedAt = Math.max(
        ...contentSources.map((item) => Date.parse(item.observedAt)),
      )
      const score = distinctSessions * 100 + contentSources.length * 10 + maxConfidence * 10
      if (
        score > selectedScore ||
        (score === selectedScore &&
          latestObservedAt >
            Date.parse(selectedSources[0]?.observedAt ?? '1970-01-01T00:00:00.000Z'))
      ) {
        selectedScore = score
        selectedContent = content
        selectedSources = contentSources
      }
    }

    if (selectedSources.length === 0) {
      continue
    }

    const distinctSessions = new Set(selectedSources.map((item) => item.sessionId)).size
    const maxConfidence = Math.max(...selectedSources.map((item) => item.confidence))
    const shouldPromote =
      selectedSources.length >= 2 || distinctSessions >= 2 || maxConfidence >= 0.9
    if (!shouldPromote) {
      continue
    }

    const exemplar = selectedSources.sort(
      (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
    )[0]

    promotions.push({
      key,
      title: exemplar.title,
      content: selectedContent,
      kind: exemplar.kind,
      observedAt: exemplar.observedAt,
      sources: selectedSources,
    })

    const conflictingContents = Array.from(contentGroups.keys()).filter(
      (content) => content !== selectedContent,
    )
    if (conflictingContents.length > 0) {
      contradictions.push(
        `Resolved contradiction for "${exemplar.title}" by keeping "${selectedContent}" and discarding ${conflictingContents.length} conflicting variant${conflictingContents.length === 1 ? '' : 's'}.`,
      )
    }

    const existingEntry = existingByKey.get(key)
    if (existingEntry && existingEntry.content !== selectedContent) {
      prunes.push(existingEntry)
      const fallbackEvidence =
        selectedSources
          .map((source) => source.evidence.join(', '))
          .filter((value) => value.length > 0)[0] ??
        insights.sessions.find((session) => session.sessionId === exemplar.sessionId)?.summary
      contradictions.push(
        `Updated durable memory for "${existingEntry.title}" from "${existingEntry.content}" to "${selectedContent}"${fallbackEvidence ? ` using evidence: ${fallbackEvidence}` : ''}.`,
      )
    }
  }

  return {
    promotions: promotions.sort((left, right) => left.title.localeCompare(right.title)),
    prunes,
    contradictions,
  }
}

function stripManagedBlocks(content: string): string {
  return [DURABLE_START, AUDIT_START].reduce((current, startMarker, index) => {
    const endMarker = index === 0 ? DURABLE_END : AUDIT_END
    return removeManagedBlock(current, startMarker, endMarker)
  }, content)
}

function removeManagedBlock(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) {
    return content
  }

  const before = content.slice(0, start).trimEnd()
  const after = content.slice(end + endMarker.length).trimStart()
  return [before, after].filter((part) => part.length > 0).join('\n\n')
}

function extractManagedBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) {
    return null
  }

  return content.slice(start + startMarker.length, end).trim()
}

function renderUpdatedMemoryIndex(memoryIndex: string, selection: PromotionSelection): string {
  const preservedContent = stripManagedBlocks(memoryIndex).trim()
  const parts = preservedContent.length > 0 ? [preservedContent] : []

  if (selection.promotions.length > 0) {
    parts.push(renderDurableMemoryBlock(selection.promotions))
  }

  if (
    selection.promotions.length > 0 ||
    selection.prunes.length > 0 ||
    selection.contradictions.length > 0
  ) {
    parts.push(renderAuditBlock(selection))
  }

  return `${parts.join('\n\n').trim()}\n`
}

function renderDurableMemoryBlock(promotions: PromotionDecision[]): string {
  const grouped = new Map<DurableKind, PromotionDecision[]>()
  for (const kind of durableKinds) {
    grouped.set(
      kind,
      promotions.filter((entry) => entry.kind === kind),
    )
  }

  const sections = [DURABLE_START, '## Durable Memory']
  for (const kind of durableKinds) {
    const entries = grouped.get(kind) ?? []
    if (entries.length === 0) {
      continue
    }

    sections.push(`### ${durableSectionLabels[kind]}`)
    for (const entry of entries) {
      sections.push(`- ${entry.title} :: ${entry.content}`)
    }
  }
  sections.push(DURABLE_END)
  return sections.join('\n')
}

function renderAuditBlock(selection: PromotionSelection): string {
  const lines = [
    AUDIT_START,
    '## Dream Audit',
    '### Durable Promotions',
    ...renderBulletList(selection.promotions.map((entry) => `${entry.title} :: ${entry.content}`)),
    '### Durable Prunes',
    ...renderBulletList(selection.prunes.map((entry) => `${entry.title} :: ${entry.content}`)),
    '### Contradictions Resolved',
    ...renderBulletList(selection.contradictions),
    AUDIT_END,
  ]
  return lines.join('\n')
}

function updateDailyMemoryFiles(
  structured: StructuredDreamState,
  selection: PromotionSelection,
): Result<string[]> {
  try {
    const activeOpenLoops = new Set(
      structured.checkpoints.flatMap((checkpoint) => checkpoint.openLoops),
    )
    const updatedPaths: string[] = []

    for (const dailyFile of structured.dailyFiles) {
      const dateObservations = structured.observations.filter(
        (observation) => observation.observedAt.slice(0, 10) === dailyFile.date,
      )
      const openLoopItems = uniqueStrings(
        dateObservations
          .filter((observation) => observation.kind === 'open-loop')
          .map((observation) => observation.summary),
      )
      const carryForward = openLoopItems.filter((item) => activeOpenLoops.has(item))
      const resolved = openLoopItems.filter((item) => !activeOpenLoops.has(item))
      const promoted = selection.promotions
        .filter((entry) => entry.observedAt.slice(0, 10) === dailyFile.date)
        .map((entry) => `${entry.title} :: ${entry.content}`)

      const nextContent = renderUpdatedDailyFile(dailyFile.content, {
        carryForward,
        resolved,
        promoted,
      })

      if (nextContent !== dailyFile.content) {
        writeFileSync(dailyFile.path, nextContent, 'utf-8')
        updatedPaths.push(dailyFile.path)
      }
    }

    return ok(updatedPaths)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to update daily memory files: ${message}`))
  }
}

function renderUpdatedDailyFile(
  originalContent: string,
  rollup: { carryForward: string[]; resolved: string[]; promoted: string[] },
): string {
  const preserved = removeManagedBlock(originalContent, ROLLUP_START, ROLLUP_END).trim()
  const hasRollup =
    rollup.carryForward.length > 0 || rollup.resolved.length > 0 || rollup.promoted.length > 0
  if (!hasRollup) {
    return preserved.length > 0 ? `${preserved}\n` : ''
  }

  const block = [
    ROLLUP_START,
    '## Dream Rollup',
    '### Carry Forward',
    ...renderBulletList(rollup.carryForward),
    '### Resolved',
    ...renderBulletList(rollup.resolved),
    '### Promoted To Durable Memory',
    ...renderBulletList(rollup.promoted),
    ROLLUP_END,
  ].join('\n')

  const parts = preserved.length > 0 ? [preserved, block] : [block]
  return `${parts.join('\n\n').trim()}\n`
}

function renderBulletList(items: string[]): string[] {
  if (items.length === 0) {
    return [NONE]
  }

  return items.map((item) => `- ${item}`)
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

// ── Stage 3: Skill Proposal Generation ────────────────────────────

/**
 * Analyze cross-session patterns to generate skill proposals.
 */
export async function proposeSkills(
  generateFn: LLMGenerateFn,
  insights: TranscriptInsights,
  _existingSkills: SkillCatalogEntry[],
): Promise<Result<SkillProposal[]>> {
  try {
    if (insights.sessions.length === 0) {
      return ok([])
    }

    const patternsText = [
      `Cross-session patterns: ${insights.crossSessionPatterns.join('; ')}`,
      `Repeated sequences: ${insights.repeatedSequences.join('; ')}`,
      `Struggle areas: ${insights.struggles.join('; ')}`,
      '',
      'Session details:',
      ...insights.sessions.map(
        (s) =>
          `Session ${s.sessionId}: ${s.summary}\n  Tools: ${s.toolsUsed.join(', ')}\n  Patterns: ${s.patterns.join(', ')}`,
      ),
    ].join('\n')

    const prompt = `You are a skill proposal engine. Based on the following cross-session analysis, suggest skills that would help automate repeated patterns or address common struggles.

${patternsText}

Return a JSON array of skill proposals, each with:
- proposedName (string): kebab-case name for the skill
- description (string): What the skill would do
- rationale (string): Why this would be useful (which sessions showed the pattern)
- estimatedImpact ("high" | "medium" | "low"): Expected impact
- sourceSessions (string[]): Session IDs that exhibited the pattern

Return ONLY a valid JSON array, no markdown fences. If no skills are worth proposing, return an empty array [].`

    const result = await generateFn(prompt)
    if (!result.ok) return result

    try {
      const proposals = JSON.parse(result.value) as SkillProposal[]
      if (!Array.isArray(proposals)) {
        return ok([])
      }
      return ok(
        proposals.filter(
          (p) =>
            typeof p.proposedName === 'string' &&
            typeof p.description === 'string' &&
            typeof p.rationale === 'string' &&
            typeof p.estimatedImpact === 'string' &&
            Array.isArray(p.sourceSessions),
        ),
      )
    } catch {
      return ok([])
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Skill proposal generation failed: ${message}`))
  }
}

// ── Stage 4: Proposal Storage ─────────────────────────────────────

function resolveProposalsPath(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, 'memory', 'skill-proposals.json')
}

export function loadProposals(basePath?: string): Result<StoredSkillProposal[]> {
  try {
    const filePath = resolveProposalsPath(basePath)
    if (!existsSync(filePath)) {
      return ok([])
    }
    const content = readFileSync(filePath, 'utf-8')
    const proposals = JSON.parse(content) as StoredSkillProposal[]
    if (!Array.isArray(proposals)) {
      return ok([])
    }
    return ok(proposals)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to load skill proposals: ${message}`))
  }
}

export function storeProposals(newProposals: SkillProposal[], basePath?: string): Result<void> {
  try {
    const filePath = resolveProposalsPath(basePath)
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const existing = loadProposals(basePath)
    const existingProposals = existing.ok ? existing.value : []

    const timestamp = new Date().toISOString()
    const storedNew: StoredSkillProposal[] = newProposals.map((p) => ({
      ...p,
      timestamp,
      status: 'pending' as const,
    }))

    const allProposals = [...existingProposals, ...storedNew]

    const tempPath = join(dir, `.skill-proposals.tmp.${Date.now()}.json`)
    writeFileSync(tempPath, JSON.stringify(allProposals, null, 2), 'utf-8')
    renameSync(tempPath, filePath)

    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to store skill proposals: ${message}`))
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function extractToolNames(session: SessionWithMessages): string[] {
  const tools = new Set<string>()
  for (const msg of session.messages) {
    if (msg.toolName) {
      tools.add(msg.toolName)
    }
  }
  return Array.from(tools)
}
