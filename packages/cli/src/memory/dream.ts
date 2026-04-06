/**
 * Dream Cycle — Between-Session Memory Consolidation
 *
 * Inspired by biological memory consolidation during sleep, the dream cycle:
 * 1. Analyzes recent session transcripts
 * 2. Merges redundant topic files and resolves contradictions
 * 3. Updates the MEMORY.md index
 * 4. Generates skill proposals based on cross-session patterns
 *
 * This is the most LLM-intensive operation in the RSI engine.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { type Result, ok, err } from '@src/types'
import type { SessionWithMessages } from './transcripts'
import { listTopics, readTopic, writeTopic, deleteTopic } from './topics'
import { getMemoryIndex, updateMemoryIndex } from './index'

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

    // Load recent sessions
    const recentResult = deps.getRecentSessions(sessionCount)
    if (!recentResult.ok) return recentResult

    const sessionSummaries = recentResult.value
    if (sessionSummaries.length === 0) {
      return ok({
        sessionsAnalyzed: 0,
        topicsMerged: 0,
        topicsCreated: 0,
        topicsPruned: 0,
        contradictionsResolved: 0,
        skillProposals: [],
        memoryIndexUpdated: false,
      })
    }

    // Load full sessions
    const sessions: SessionWithMessages[] = []
    for (const summary of sessionSummaries) {
      const sessionResult = deps.getSession(summary.id)
      if (sessionResult.ok) {
        sessions.push(sessionResult.value)
      }
    }

    if (sessions.length === 0) {
      return ok({
        sessionsAnalyzed: 0,
        topicsMerged: 0,
        topicsCreated: 0,
        topicsPruned: 0,
        contradictionsResolved: 0,
        skillProposals: [],
        memoryIndexUpdated: false,
      })
    }

    // Stage 1: Analyze transcripts
    const insightsResult = await analyzeTranscripts(deps.generateFn, sessions)
    if (!insightsResult.ok) return insightsResult
    const insights = insightsResult.value

    let consolidation: ConsolidationResult = {
      topicsMerged: 0,
      topicsCreated: 0,
      topicsPruned: 0,
      contradictionsResolved: 0,
      memoryIndexUpdated: false,
    }

    let proposals: SkillProposal[] = []

    // Stage 2: Memory consolidation (if applicable)
    if (mode === 'full' || mode === 'consolidate-only') {
      const topicsResult = listTopics(deps.basePath)
      if (!topicsResult.ok) return topicsResult

      const topicContents: Array<{ name: string; content: string }> = []
      for (const topicName of topicsResult.value) {
        const readResult = readTopic(topicName, deps.basePath)
        if (readResult.ok) {
          topicContents.push({ name: topicName, content: readResult.value })
        }
      }

      const memoryResult = getMemoryIndex(deps.basePath)
      if (!memoryResult.ok) return memoryResult

      const consolidationResult = await consolidateMemory(
        deps.generateFn,
        insights,
        memoryResult.value,
        topicContents,
        deps.basePath,
      )
      if (!consolidationResult.ok) return consolidationResult
      consolidation = consolidationResult.value
    }

    // Stage 3: Skill proposal generation (if applicable)
    if (mode === 'full' || mode === 'propose-only') {
      const proposalResult = await proposeSkills(deps.generateFn, insights, [])
      if (!proposalResult.ok) return proposalResult
      proposals = proposalResult.value

      // Stage 4: Store proposals
      if (proposals.length > 0) {
        const storeResult = storeProposals(proposals, deps.basePath)
        if (!storeResult.ok) return storeResult
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

    // Pass 1: Summarize each session independently
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
        // If LLM fails for one session, use a minimal insight
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
          sessionId: session.id,
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

    // Pass 2: Cross-reference summaries for patterns
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
        // Non-fatal: continue with empty cross-session data
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

// ── Stage 2: Memory Consolidation ─────────────────────────────────

/**
 * Consolidate memory by merging redundant topics, resolving contradictions,
 * and updating the MEMORY.md index.
 */
export async function consolidateMemory(
  generateFn: LLMGenerateFn,
  insights: TranscriptInsights,
  _memoryIndex: string,
  topics: Array<{ name: string; content: string }>,
  basePath?: string,
): Promise<Result<ConsolidationResult>> {
  try {
    let topicsMerged = 0
    let topicsCreated = 0
    let topicsPruned = 0
    let contradictionsResolved = 0
    let memoryIndexUpdated = false

    if (topics.length === 0 && insights.sessions.length === 0) {
      return ok({
        topicsMerged,
        topicsCreated,
        topicsPruned,
        contradictionsResolved,
        memoryIndexUpdated,
      })
    }

    // Build a description of existing topics for the LLM
    const topicDescriptions = topics
      .map((t) => `Topic: ${t.name}\nContent: ${t.content.slice(0, 300)}`)
      .join('\n---\n')

    const insightsSummary = insights.sessions
      .map(
        (s) =>
          `Session ${s.sessionId}: ${s.summary}\nTasks: ${s.tasksAttempted.join(', ')}\nOutcomes: ${s.outcomes.map((o) => `${o.task}: ${o.success ? 'success' : 'failure'}`).join(', ')}`,
      )
      .join('\n\n')

    const consolidationPrompt = `You are a memory consolidation engine. Analyze the existing topic files and recent session insights, then return a JSON object with consolidation actions.

Existing topics:
${topicDescriptions || '(none)'}

Recent session insights:
${insightsSummary}

Return a JSON object with:
- merges (array of {source: string[], target: string, mergedContent: string}): Groups of topic names to merge into a single topic
- contradictions (array of {topicName: string, issue: string, resolution: string, updatedContent: string}): Contradictions found and resolved
- newTopics (array of {name: string, content: string}): New topics to create from session insights not yet captured
- prunedTopics (string[]): Topic names that are obsolete and should be removed
- updatedIndex (string): Updated MEMORY.md content reflecting all changes

Return ONLY valid JSON, no markdown fences.`

    const result = await generateFn(consolidationPrompt)
    if (!result.ok) return result

    try {
      const actions = JSON.parse(result.value) as {
        merges?: Array<{ source: string[]; target: string; mergedContent: string }>
        contradictions?: Array<{
          topicName: string
          issue: string
          resolution: string
          updatedContent: string
        }>
        newTopics?: Array<{ name: string; content: string }>
        prunedTopics?: string[]
        updatedIndex?: string
      }

      // Apply merges
      if (actions.merges) {
        for (const merge of actions.merges) {
          // Write the merged topic
          const writeResult = writeTopic(merge.target, merge.mergedContent, basePath)
          if (!writeResult.ok) continue

          // Delete source topics (except the target if it's also a source)
          for (const source of merge.source) {
            if (source !== merge.target) {
              deleteTopic(source, basePath)
            }
          }
          topicsMerged += merge.source.length
        }
      }

      // Resolve contradictions
      if (actions.contradictions) {
        for (const contradiction of actions.contradictions) {
          const writeResult = writeTopic(
            contradiction.topicName,
            contradiction.updatedContent,
            basePath,
          )
          if (writeResult.ok) {
            contradictionsResolved++
          }
        }
      }

      // Create new topics
      if (actions.newTopics) {
        for (const newTopic of actions.newTopics) {
          const writeResult = writeTopic(newTopic.name, newTopic.content, basePath)
          if (writeResult.ok) {
            topicsCreated++
          }
        }
      }

      // Prune obsolete topics
      if (actions.prunedTopics) {
        for (const topicName of actions.prunedTopics) {
          const deleteResult = deleteTopic(topicName, basePath)
          if (deleteResult.ok) {
            topicsPruned++
          }
        }
      }

      // Update MEMORY.md index
      if (actions.updatedIndex) {
        const updateResult = updateMemoryIndex(actions.updatedIndex, basePath)
        if (updateResult.ok) {
          memoryIndexUpdated = true
        }
      }
    } catch {
      // LLM returned invalid JSON — non-fatal, just skip consolidation actions
    }

    return ok({
      topicsMerged,
      topicsCreated,
      topicsPruned,
      contradictionsResolved,
      memoryIndexUpdated,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Memory consolidation failed: ${message}`))
  }
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
      // Validate each proposal has required fields
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

/**
 * Path to the skill proposals file.
 */
function resolveProposalsPath(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, 'memory', 'skill-proposals.json')
}

/**
 * Load existing proposals from the JSON file.
 */
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

/**
 * Append new proposals to the skill proposals file (atomic write).
 */
export function storeProposals(newProposals: SkillProposal[], basePath?: string): Result<void> {
  try {
    const filePath = resolveProposalsPath(basePath)
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Load existing proposals
    const existing = loadProposals(basePath)
    const existingProposals = existing.ok ? existing.value : []

    // Convert new proposals to stored format
    const timestamp = new Date().toISOString()
    const storedNew: StoredSkillProposal[] = newProposals.map((p) => ({
      ...p,
      timestamp,
      status: 'pending' as const,
    }))

    // Append new proposals
    const allProposals = [...existingProposals, ...storedNew]

    // Atomic write: write to temp file, then rename
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

/**
 * Extract tool names from session messages without LLM.
 */
function extractToolNames(session: SessionWithMessages): string[] {
  const tools = new Set<string>()
  for (const msg of session.messages) {
    if (msg.toolName) {
      tools.add(msg.toolName)
    }
  }
  return Array.from(tools)
}
