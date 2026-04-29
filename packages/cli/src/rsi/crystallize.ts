/**
 * RSI Module — Crystallize
 *
 * Two-stage crystallization pipeline:
 *   1. Reflection — evaluates whether a completed task contains a generalizable
 *      pattern worth crystallizing into a skill.
 *   2. Skill generation — transforms a structured reflection into a portable,
 *      testable skill conforming to the agentskills.io spec.
 *
 * Public API:
 *   - reflect()              — LLM-powered reflection on a completed task
 *   - shouldCrystallize()    — threshold check for novelty/generalizability
 *   - generateSkill()        — LLM-powered skill generation from a ReflectionRecord
 *   - writeSkillToStaging()  — writes a GeneratedSkill to disk with validation
 *   - parseSkillResponse()   — extracts skill components from raw LLM output
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { type Result, ok, err } from '@src/types'
import { generateResponse } from '@src/llm'
import { getReasoningSupport } from '@src/llm/model-capabilities'
import type { GenerateResult, LLMCallOptions, LLMMessage } from '@src/llm/types'
import type { SkillCatalogEntry } from '@src/tools/skill-manager'
import { runSkillTests, type SkillTestResult } from '@src/rsi/validate'
import type { ObservationRecord, ReflectionCheckpoint } from '@src/rsi/types'

// ── ReflectionRecord schema ───────────────────────────────────────────

const PatternTypeSchema = z.enum(['workflow', 'troubleshooting', 'open-loop-resolution'])

export const CrystallizationSourceReferenceSchema = z.object({
  sessionId: z.string().min(1),
  observationIds: z.array(z.string().min(1)),
  observationTimestamps: z.array(z.string().min(1)),
  checkpointUpdatedAt: z.string().min(1).optional(),
})

export type CrystallizationSourceReference = z.infer<typeof CrystallizationSourceReferenceSchema>

export const ReflectionRecordSchema = z.object({
  taskSummary: z.string().describe('Brief description of what the agent just accomplished'),
  novelty: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How novel was this solution? 0 = fully handled by existing skill, 1 = completely new',
    ),
  generalizability: z
    .number()
    .min(0)
    .max(1)
    .describe('How reusable is this pattern for future tasks?'),
  proposedSkillName: z
    .string()
    .optional()
    .describe('kebab-case name if novelty + generalizability exceed threshold'),
  proposedSkillDescription: z
    .string()
    .optional()
    .describe('What the skill would do and when to trigger it'),
  keySteps: z.array(z.string()).optional().describe('Core steps of the generalizable pattern'),
  reasoning: z.string().describe("The agent's reasoning about novelty and generalizability"),
  shouldCrystallize: z
    .boolean()
    .describe('Final decision: true if both novelty and generalizability exceed threshold'),
  patternType: PatternTypeSchema.optional().describe('Observation-derived pattern classification'),
  repeatCount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many times this pattern repeated across source sessions'),
  repeatedAcrossSessions: z
    .boolean()
    .optional()
    .describe('Whether this pattern was observed in multiple sessions'),
  sourceReferences: z
    .array(CrystallizationSourceReferenceSchema)
    .optional()
    .describe('Traceable source observation references for auditability'),
  transcriptExcerpts: z
    .array(z.string())
    .optional()
    .describe('Optional transcript excerpts used as secondary evidence'),
})

export type ReflectionRecord = z.infer<typeof ReflectionRecordSchema>

export interface ObservationCrystallizationSession {
  sessionId: string
  observations: ObservationRecord[]
  checkpoint?: ReflectionCheckpoint | null
  transcriptExcerpt?: string
}

export interface ObservationPatternProposal {
  patternType: z.infer<typeof PatternTypeSchema>
  patternKey: string
  proposedSkillName: string
  proposedSkillDescription: string
  keySteps: string[]
  reasoning: string
  novelty: number
  generalizability: number
  confidence: number
  repeatCount: number
  repeatedAcrossSessions: boolean
  sourceReferences: CrystallizationSourceReference[]
  transcriptExcerpts: string[]
}

export interface ObservationCrystallizationOptions {
  existingSkills?: SkillCatalogEntry[]
  repeatedPatternsOnly?: boolean
  minimumRepeatCount?: number
  noveltyThreshold?: number
}

function isOpenAIReasoningModel(llm: LanguageModel): boolean {
  const info = llm as { provider?: string; modelId?: string }
  return getReasoningSupport(info.modelId ?? '', info.provider)?.kind === 'openai-reasoning'
}

function buildRSILLMCallOptions(
  llm: LanguageModel,
  temperature: number,
  maxTokens: number,
): LLMCallOptions {
  return {
    ...(isOpenAIReasoningModel(llm) ? {} : { temperature }),
    maxTokens,
  }
}

async function generateRSIResponse(
  llm: LanguageModel,
  messages: LLMMessage[],
  options: LLMCallOptions,
): Promise<Result<GenerateResult>> {
  const initial = await generateResponse(llm, messages, options)
  if (initial.ok || !isRetryableBadRequest(initial.error)) {
    return initial
  }

  return generateResponse(llm, messages)
}

function isRetryableBadRequest(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('bad request') || message.includes('400')
}

// ── Skill generation types ───────────────────────────────────────────

/**
 * Skill frontmatter conforming to agentskills.io spec.
 */
export interface SkillFrontmatter {
  name: string
  description: string
  license: string
  metadata: {
    author: string
    version: string
    generated: string
    confidence: number
    source_task: string
    source_sessions?: string[]
    source_observations?: string[]
    source_timestamps?: string[]
  }
}

/**
 * A fully generated skill ready to be written to disk.
 */
export interface GeneratedSkill {
  /** Kebab-case skill name */
  name: string
  /** YAML frontmatter object */
  frontmatter: SkillFrontmatter
  /** Markdown body (instructions) */
  body: string
  /** TypeScript test script content */
  testScript: string
}

// ── Reflection prompt ────────────────────────────────────────────────

function buildReflectionPrompt(taskSummary: string, existingSkills: SkillCatalogEntry[]): string {
  const skillList =
    existingSkills.length > 0
      ? existingSkills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
      : '(No existing skills)'

  return `You are a reflection engine for a self-improving AI agent. Your job is to evaluate whether a completed task contains a generalizable pattern worth crystallizing into a reusable skill.

## Existing Skills

${skillList}

## Completed Task

${taskSummary}

## Instructions

Evaluate the task along two dimensions:

1. **Novelty** (0-1): How novel was the solution approach?
   - 0.0-0.2: An existing skill already handles this exact pattern
   - 0.3-0.5: Similar to existing skills but with minor variations
   - 0.6-0.8: Meaningfully different approach not covered by existing skills
   - 0.9-1.0: Completely new technique or pattern

2. **Generalizability** (0-1): How reusable is this pattern for future, different tasks?
   - 0.0-0.2: Extremely task-specific, unlikely to recur
   - 0.3-0.5: Could apply to a narrow class of similar tasks
   - 0.6-0.8: Broadly applicable pattern across multiple task types
   - 0.9-1.0: Fundamental technique applicable to almost any task

If both novelty and generalizability are high (>= 0.7), propose a skill:
- \`proposedSkillName\`: kebab-case identifier
- \`proposedSkillDescription\`: what the skill does and when to use it
- \`keySteps\`: the core steps of the pattern

## Few-shot examples

### Example 1: Low novelty (existing skill covers it)
Task: "Read a file, extracted key information, and wrote a summary to memory."
Existing skills: ["file-summarizer: Reads files and produces summaries"]
→ novelty: 0.15, generalizability: 0.6, shouldCrystallize: false
Reasoning: "The file-summarizer skill already handles this exact pattern."

### Example 2: High novelty, low generalizability
Task: "Fixed a specific race condition in the WebSocket reconnection logic by adding a mutex around the connection state machine."
Existing skills: []
→ novelty: 0.85, generalizability: 0.25, shouldCrystallize: false
Reasoning: "Novel debugging approach but too specific to WebSocket reconnection to generalize."

### Example 3: High novelty, high generalizability
Task: "Decomposed a complex refactoring into atomic steps, ran tests after each step, and automatically rolled back on failure."
Existing skills: []
→ novelty: 0.9, generalizability: 0.9, shouldCrystallize: true
Reasoning: "Incremental-refactor-with-rollback is a broadly applicable pattern not covered by any existing skill."

## Output

Respond with ONLY a JSON object (no markdown fences, no extra text) matching this schema:

{
  "taskSummary": "string — brief description of the task",
  "novelty": number (0-1),
  "generalizability": number (0-1),
  "proposedSkillName": "string or omit — kebab-case",
  "proposedSkillDescription": "string or omit",
  "keySteps": ["string array or omit"],
  "reasoning": "string — your reasoning",
  "shouldCrystallize": boolean
}`
}

// ── Core reflection logic ────────────────────────────────────────────

/**
 * Run structured reflection on a completed task.
 *
 * Calls the LLM to evaluate novelty and generalizability of the task's
 * solution approach, compared against the existing skill catalog.
 *
 * @param taskSummary - Description of the completed task and its solution
 * @param existingSkills - Current skill catalog for novelty comparison
 * @param llm - Language model instance to use for reflection
 * @returns Result containing a validated ReflectionRecord or a descriptive error
 */
export async function reflect(
  taskSummary: string,
  existingSkills: SkillCatalogEntry[],
  llm: LanguageModel,
): Promise<Result<ReflectionRecord>> {
  const prompt = buildReflectionPrompt(taskSummary, existingSkills)

  const llmResult = await generateRSIResponse(
    llm,
    [{ role: 'user', content: prompt }],
    buildRSILLMCallOptions(llm, 0.2, 1024),
  )

  if (!llmResult.ok) {
    return err(new Error(`Reflection LLM call failed: ${llmResult.error.message}`))
  }

  const rawText = llmResult.value.text.trim()

  // Try to parse JSON from the response, handling possible markdown fences
  let jsonText = rawText
  const fenceMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return err(
      new Error(
        `Failed to parse reflection response as JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? '...' : ''}`,
      ),
    )
  }

  const validation = ReflectionRecordSchema.safeParse(parsed)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return err(new Error(`Reflection response failed schema validation: ${issues}`))
  }

  return ok(validation.data)
}

// ── Crystallization decision ─────────────────────────────────────────

/**
 * Determine whether a reflection record warrants crystallization into a skill.
 *
 * Returns true when both novelty and generalizability exceed the threshold.
 *
 * @param record - The reflection record to evaluate
 * @param threshold - Minimum score (0-1) for both dimensions (default: 0.7)
 */
export function shouldCrystallize(record: ReflectionRecord, threshold: number): boolean {
  return record.novelty > threshold && record.generalizability > threshold
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizePatternText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function slugifyPattern(value: string): string {
  const slug = normalizePatternText(value).replace(/\s+/g, '-')
  return slug || 'skill-pattern'
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

function getTagValue(tags: string[], prefix: string): string | undefined {
  const normalizedPrefix = `${prefix.toLowerCase()}:`
  const match = tags.find((tag) => tag.toLowerCase().startsWith(normalizedPrefix))
  return match?.slice(normalizedPrefix.length).trim()
}

function priorityToConfidence(priority: ObservationRecord['priority']): number {
  switch (priority) {
    case 'critical':
      return 0.95
    case 'high':
      return 0.85
    case 'normal':
      return 0.7
    case 'low':
      return 0.55
  }
}

function getSupersededObservationIds(observations: ObservationRecord[]): Set<string> {
  const superseded = new Set<string>()
  for (const observation of observations) {
    for (const supersededId of observation.supersedes ?? []) {
      superseded.add(supersededId)
    }
  }

  return superseded
}

function getActiveObservations(observations: ObservationRecord[]): ObservationRecord[] {
  const superseded = getSupersededObservationIds(observations)
  return observations.filter((observation) => !superseded.has(observation.id))
}

interface ObservationPatternSeed {
  patternType: ObservationPatternProposal['patternType']
  patternKey: string
  proposedSkillName: string
  proposedSkillDescription: string
  keySteps: string[]
  confidence: number
  sourceReference: CrystallizationSourceReference
  transcriptExcerpt?: string
}

function buildSourceReference(
  session: ObservationCrystallizationSession,
  observationIds: string[],
): CrystallizationSourceReference {
  const timestamps = session.observations
    .filter((observation) => observationIds.includes(observation.id))
    .map((observation) => observation.observedAt)

  return {
    sessionId: session.sessionId,
    observationIds: dedupeStrings(observationIds),
    observationTimestamps: dedupeStrings(timestamps),
    checkpointUpdatedAt: session.checkpoint?.updatedAt,
  }
}

function validateObservationSession(
  session: ObservationCrystallizationSession,
): Result<ObservationCrystallizationSession> {
  const mismatchedObservation = session.observations.find(
    (observation) => observation.sessionId !== session.sessionId,
  )
  if (mismatchedObservation) {
    return err(
      new Error(
        `Observation session mismatch: expected "${session.sessionId}" but found "${mismatchedObservation.sessionId}"`,
      ),
    )
  }

  if (session.checkpoint && session.checkpoint.sessionId !== session.sessionId) {
    return err(
      new Error(
        `Checkpoint session mismatch: expected "${session.sessionId}" but found "${session.checkpoint.sessionId}"`,
      ),
    )
  }

  return ok(session)
}

function buildCheckpointSkillSeeds(
  session: ObservationCrystallizationSession,
): ObservationPatternSeed[] {
  const checkpoint = session.checkpoint
  if (!checkpoint) {
    return []
  }

  return checkpoint.skillCandidates.map((candidate) => ({
    patternType: 'workflow',
    patternKey: [
      'checkpoint-skill',
      normalizePatternText(candidate.name),
      candidate.workflow.map(normalizePatternText).join('>'),
    ].join(':'),
    proposedSkillName: candidate.name,
    proposedSkillDescription: `${candidate.summary}. Activate when ${candidate.trigger}.`,
    keySteps: dedupeStrings(candidate.workflow),
    confidence: clamp01(candidate.confidence),
    sourceReference: {
      sessionId: session.sessionId,
      observationIds: dedupeStrings(candidate.sourceObservationIds),
      observationTimestamps: dedupeStrings(
        session.observations
          .filter((observation) => candidate.sourceObservationIds.includes(observation.id))
          .map((observation) => observation.observedAt),
      ),
      checkpointUpdatedAt: checkpoint.updatedAt,
    },
    transcriptExcerpt: session.transcriptExcerpt,
  }))
}

function buildWorkflowSequenceSeed(
  session: ObservationCrystallizationSession,
): ObservationPatternSeed | undefined {
  const activeObservations = getActiveObservations(session.observations)
  const workflowObservations = activeObservations.filter((observation) =>
    ['progress', 'decision', 'warning'].includes(observation.kind),
  )

  if (workflowObservations.length < 2) {
    return undefined
  }

  const normalizedSteps = dedupeStrings(
    workflowObservations.map((observation) => observation.summary),
  )
  if (normalizedSteps.length < 2) {
    return undefined
  }

  const taggedName =
    workflowObservations
      .map((observation) => getTagValue(observation.tags, 'workflow'))
      .find(Boolean) ??
    workflowObservations
      .map((observation) => getTagValue(observation.tags, 'pattern'))
      .find(Boolean) ??
    workflowObservations.map((observation) => getTagValue(observation.tags, 'name')).find(Boolean)

  const patternType = workflowObservations.some((observation) => observation.kind === 'warning')
    ? 'troubleshooting'
    : 'workflow'
  const seedName = taggedName ?? normalizedSteps.slice(0, 3).join(' ')
  const descriptionBase =
    session.checkpoint?.goal || workflowObservations[workflowObservations.length - 1]?.summary

  return {
    patternType,
    patternKey: `workflow:${taggedName ? normalizePatternText(taggedName) : normalizedSteps.map(normalizePatternText).join('>')}`,
    proposedSkillName: slugifyPattern(seedName),
    proposedSkillDescription: `Captures the repeated ${patternType} for ${descriptionBase}. Activate when similar constraints or steps appear again.`,
    keySteps: normalizedSteps,
    confidence: clamp01(
      workflowObservations.reduce(
        (sum, observation) => sum + priorityToConfidence(observation.priority),
        0,
      ) / workflowObservations.length,
    ),
    sourceReference: buildSourceReference(
      session,
      workflowObservations.map((observation) => observation.id),
    ),
    transcriptExcerpt: session.transcriptExcerpt,
  }
}

function buildOpenLoopResolutionSeeds(
  session: ObservationCrystallizationSession,
): ObservationPatternSeed[] {
  const sortedObservations = [...session.observations].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  )

  return sortedObservations
    .filter((observation) => observation.kind === 'open-loop')
    .flatMap((openLoop) => {
      const resolvers = sortedObservations.filter(
        (candidate) =>
          (candidate.supersedes ?? []).includes(openLoop.id) &&
          ['progress', 'decision', 'warning'].includes(candidate.kind),
      )

      if (resolvers.length === 0) {
        return []
      }

      const label =
        getTagValue(openLoop.tags, 'workflow') ??
        getTagValue(openLoop.tags, 'pattern') ??
        getTagValue(openLoop.tags, 'name') ??
        resolvers.map((resolver) => getTagValue(resolver.tags, 'workflow')).find(Boolean) ??
        resolvers.map((resolver) => getTagValue(resolver.tags, 'pattern')).find(Boolean) ??
        resolvers.map((resolver) => getTagValue(resolver.tags, 'name')).find(Boolean)

      const keySteps = dedupeStrings([
        openLoop.summary,
        ...resolvers.map((resolver) => resolver.summary),
      ])
      return [
        {
          patternType: 'open-loop-resolution' as const,
          patternKey: `resolution:${label ? normalizePatternText(label) : keySteps.map(normalizePatternText).join('>')}`,
          proposedSkillName: slugifyPattern(label ?? `resolve ${openLoop.summary}`),
          proposedSkillDescription: `Resolves "${openLoop.summary}" using a repeatable sequence. Activate when the same class of issue blocks forward progress.`,
          keySteps,
          confidence: clamp01(
            resolvers.reduce((sum, resolver) => sum + priorityToConfidence(resolver.priority), 0) /
              resolvers.length,
          ),
          sourceReference: buildSourceReference(session, [
            openLoop.id,
            ...resolvers.map((resolver) => resolver.id),
          ]),
          transcriptExcerpt: session.transcriptExcerpt,
        },
      ]
    })
}

function isCoveredByExistingSkill(
  proposal: Pick<ObservationPatternProposal, 'proposedSkillName' | 'proposedSkillDescription'>,
  existingSkills: SkillCatalogEntry[],
): boolean {
  const normalizedName = normalizePatternText(proposal.proposedSkillName)
  const normalizedDescription = normalizePatternText(proposal.proposedSkillDescription)

  return existingSkills.some((skill) => {
    const skillName = normalizePatternText(skill.name)
    const skillDescription = normalizePatternText(skill.description)

    return (
      skillName === normalizedName ||
      normalizedDescription.includes(skillName) ||
      skillDescription.includes(normalizedName)
    )
  })
}

export function proposeCrystallizationsFromObservations(
  sessions: ObservationCrystallizationSession[],
  options: ObservationCrystallizationOptions = {},
): Result<ObservationPatternProposal[]> {
  const {
    existingSkills = [],
    repeatedPatternsOnly = true,
    minimumRepeatCount = 2,
    noveltyThreshold = 0.7,
  } = options

  const seeds: ObservationPatternSeed[] = []

  for (const session of sessions) {
    const validatedSession = validateObservationSession(session)
    if (!validatedSession.ok) {
      return validatedSession
    }

    seeds.push(...buildCheckpointSkillSeeds(validatedSession.value))

    const workflowSeed = buildWorkflowSequenceSeed(validatedSession.value)
    if (workflowSeed) {
      seeds.push(workflowSeed)
    }

    seeds.push(...buildOpenLoopResolutionSeeds(validatedSession.value))
  }

  const grouped = new Map<string, ObservationPatternSeed[]>()
  for (const seed of seeds) {
    const bucket = grouped.get(seed.patternKey) ?? []
    bucket.push(seed)
    grouped.set(seed.patternKey, bucket)
  }

  const proposals: ObservationPatternProposal[] = []

  for (const [patternKey, patternSeeds] of grouped.entries()) {
    const sourceReferences = patternSeeds.map((seed) => seed.sourceReference)
    const sessionIds = new Set(sourceReferences.map((reference) => reference.sessionId))
    const repeatCount = sessionIds.size
    const repeatedAcrossSessions = repeatCount > 1
    const confidence = clamp01(
      patternSeeds.reduce((sum, seed) => sum + seed.confidence, 0) / patternSeeds.length,
    )

    const keySteps = dedupeStrings(patternSeeds.flatMap((seed) => seed.keySteps))
    const seed = patternSeeds[0]
    let novelty = clamp01(
      0.4 +
        confidence * 0.25 +
        Math.min(repeatCount - 1, 2) * 0.15 +
        (seed.patternType === 'troubleshooting'
          ? 0.1
          : seed.patternType === 'open-loop-resolution'
            ? 0.05
            : 0),
    )
    let generalizability = clamp01(0.35 + confidence * 0.25 + Math.min(repeatCount, 3) * 0.2)

    const proposal: ObservationPatternProposal = {
      patternType: seed.patternType,
      patternKey,
      proposedSkillName: seed.proposedSkillName,
      proposedSkillDescription: seed.proposedSkillDescription,
      keySteps,
      reasoning: repeatedAcrossSessions
        ? `Detected a repeated ${seed.patternType} across ${repeatCount} sessions with consistent steps and evidence.`
        : `Detected a single-session ${seed.patternType} with strong evidence and a stable multi-step workflow.`,
      novelty,
      generalizability,
      confidence,
      repeatCount,
      repeatedAcrossSessions,
      sourceReferences: sourceReferences.map((reference) => ({
        ...reference,
        observationIds: dedupeStrings(reference.observationIds),
        observationTimestamps: dedupeStrings(reference.observationTimestamps),
      })),
      transcriptExcerpts: dedupeStrings(
        patternSeeds
          .map((candidate) => candidate.transcriptExcerpt?.trim() ?? '')
          .filter((value) => value.length > 0),
      ),
    }

    const exceptionalSingleSession =
      !repeatedAcrossSessions &&
      proposal.novelty >= noveltyThreshold + 0.15 &&
      proposal.confidence >= 0.9

    if (repeatedPatternsOnly && repeatCount < minimumRepeatCount && !exceptionalSingleSession) {
      continue
    }

    if (isCoveredByExistingSkill(proposal, existingSkills)) {
      novelty = 0.15
      generalizability = clamp01(generalizability - 0.2)
      proposal.novelty = novelty
      proposal.generalizability = generalizability
      proposal.reasoning = `${proposal.reasoning} A similarly named skill already exists, so novelty is reduced.`
    }

    proposals.push(proposal)
  }

  return ok(
    proposals.sort((left, right) => {
      if (left.repeatedAcrossSessions !== right.repeatedAcrossSessions) {
        return Number(right.repeatedAcrossSessions) - Number(left.repeatedAcrossSessions)
      }
      if (left.repeatCount !== right.repeatCount) {
        return right.repeatCount - left.repeatCount
      }
      if (left.generalizability !== right.generalizability) {
        return right.generalizability - left.generalizability
      }
      return right.confidence - left.confidence
    }),
  )
}

export function reflectFromObservationPatterns(
  taskSummary: string,
  sessions: ObservationCrystallizationSession[],
  options: ObservationCrystallizationOptions = {},
): Result<ReflectionRecord> {
  const proposalResult = proposeCrystallizationsFromObservations(sessions, options)
  if (!proposalResult.ok) {
    return proposalResult
  }

  const topProposal = proposalResult.value[0]
  if (!topProposal) {
    return ok({
      taskSummary,
      novelty: 0.15,
      generalizability: 0.25,
      reasoning: 'No repeated observation or checkpoint pattern met the crystallization threshold.',
      shouldCrystallize: false,
      repeatCount: 1,
      repeatedAcrossSessions: false,
      sourceReferences: [],
      transcriptExcerpts: [],
    })
  }

  return ok({
    taskSummary:
      taskSummary.trim().length > 0
        ? taskSummary
        : `Repeated ${topProposal.patternType} across ${topProposal.repeatCount} sessions`,
    novelty: topProposal.novelty,
    generalizability: topProposal.generalizability,
    proposedSkillName: topProposal.proposedSkillName,
    proposedSkillDescription: topProposal.proposedSkillDescription,
    keySteps: topProposal.keySteps,
    reasoning: topProposal.reasoning,
    shouldCrystallize:
      topProposal.repeatedAcrossSessions ||
      (topProposal.novelty > (options.noveltyThreshold ?? 0.7) && topProposal.confidence >= 0.9),
    patternType: topProposal.patternType,
    repeatCount: topProposal.repeatCount,
    repeatedAcrossSessions: topProposal.repeatedAcrossSessions,
    sourceReferences: topProposal.sourceReferences,
    transcriptExcerpts: topProposal.transcriptExcerpts,
  })
}

// ── Skill name / frontmatter validation ──────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * Validate that a skill name is lowercase kebab-case and at most 64 chars.
 */
export function validateSkillName(name: string): Result<string> {
  if (name.length === 0) {
    return err(new Error('Skill name cannot be empty'))
  }
  if (name.length > 64) {
    return err(new Error(`Skill name exceeds 64 characters: "${name}"`))
  }
  if (!KEBAB_CASE_RE.test(name)) {
    return err(new Error(`Skill name must be lowercase kebab-case: "${name}"`))
  }
  return ok(name)
}

/**
 * Check that a skill name is not already taken in any of the skill directories.
 */
export function checkNameUniqueness(name: string, basePath: string): Result<true> {
  const dirs = ['skills/core', 'skills/generated', 'skills/staging']
  for (const dir of dirs) {
    const fullPath = join(basePath, dir, name)
    if (existsSync(fullPath)) {
      return err(
        new Error(`Skill name "${name}" already exists in ${dir}/. Choose a different name.`),
      )
    }
  }
  return ok(true as const)
}

/**
 * Validate that frontmatter has all required agentskills.io fields.
 */
export function validateFrontmatter(fm: SkillFrontmatter): Result<true> {
  if (!fm.name || fm.name.trim() === '') {
    return err(new Error('Frontmatter missing required "name" field'))
  }
  if (!fm.description || fm.description.trim() === '') {
    return err(new Error('Frontmatter missing required "description" field'))
  }
  if (fm.description.length > 1024) {
    return err(
      new Error(`Frontmatter "description" exceeds 1024 characters (${fm.description.length})`),
    )
  }
  if (!fm.license) {
    return err(new Error('Frontmatter missing required "license" field'))
  }
  if (!fm.metadata?.author) {
    return err(new Error('Frontmatter missing required "metadata.author" field'))
  }
  if (!fm.metadata?.version) {
    return err(new Error('Frontmatter missing required "metadata.version" field'))
  }
  return ok(true as const)
}

/**
 * Verify that a SKILL.md string can be round-tripped (parse frontmatter + body).
 */
export function validateRoundTrip(skillMdContent: string): Result<true> {
  const trimmed = skillMdContent.trimStart()
  if (!trimmed.startsWith('---')) {
    return err(new Error('SKILL.md does not start with --- frontmatter delimiter'))
  }
  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return err(new Error('SKILL.md missing closing --- frontmatter delimiter'))
  }
  const yamlBlock = trimmed.slice(3, endIndex).trim()
  try {
    const parsed = parseYaml(yamlBlock)
    if (parsed == null || typeof parsed !== 'object') {
      return err(new Error('YAML frontmatter is not an object'))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to parse YAML frontmatter: ${message}`))
  }
  return ok(true as const)
}

// ── Skill generation prompt ─────────────────────────────────────────

/**
 * Load example skills from skills/core/ for prompt exemplars.
 * Returns up to 2 examples, or empty string if none exist.
 */
function loadExampleSkills(basePath: string): string {
  const coreDir = join(basePath, 'skills', 'core')
  if (!existsSync(coreDir)) return ''

  let entries: string[]
  try {
    entries = readdirSync(coreDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return ''
  }

  const examples: string[] = []
  for (const entry of entries.slice(0, 2)) {
    const skillMdPath = join(coreDir, entry, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        examples.push(`### Example: ${entry}\n\`\`\`markdown\n${content}\n\`\`\``)
      } catch {
        // Skip unreadable files
      }
    }
  }

  return examples.length > 0 ? `\n## Example SKILL.md files\n\n${examples.join('\n\n')}\n` : ''
}

/**
 * Build the LLM prompt for skill generation.
 */
export function buildGenerationPrompt(
  record: ReflectionRecord,
  transcript: string | undefined,
  basePath: string,
): string {
  const exampleSkills = loadExampleSkills(basePath)
  const keySteps = record.keySteps ?? []
  const sourceReferences = record.sourceReferences ?? []
  const transcriptEvidence = dedupeStrings([
    ...(record.transcriptExcerpts ?? []),
    transcript ?? '',
  ]).join('\n\n')
  const sourceSection =
    sourceReferences.length > 0
      ? `\n## Observation Evidence\n\n${sourceReferences
          .map((reference, index) => {
            const timestamps =
              reference.observationTimestamps.length > 0
                ? ` (${reference.observationTimestamps.join(', ')})`
                : ''
            return `${index + 1}. Session \`${reference.sessionId}\`${timestamps} — observations: ${reference.observationIds.join(', ')}`
          })
          .join('\n')}\n`
      : ''

  return `You are a skill generator for the Ouroboros RSI engine. Your job is to transform a structured reflection record into a complete, portable skill conforming to the agentskills.io spec.

## Reflection Record

- **Task Summary:** ${record.taskSummary}
- **Key Steps:**
${keySteps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}
- **Proposed Skill Name:** ${record.proposedSkillName ?? 'unnamed'}
- **Generalizability:** ${record.generalizability}
- **Reasoning:** ${record.reasoning}
${sourceSection}${transcriptEvidence ? `\n## Supporting Transcript Evidence (secondary)\n\n${transcriptEvidence}\n` : ''}
${exampleSkills}
## Your Task

Generate THREE outputs, each in a fenced code block with a specific label. Follow this EXACT format:

### DESCRIPTION

Write a skill description (max 1024 chars) optimized for LLM-based routing. The description MUST answer:
1. "What does this skill do?" — be specific about the capability
2. "When should this skill be activated?" — describe trigger conditions in concrete, pattern-oriented language

Do NOT be vague (e.g., "helps with coding"). DO be specific (e.g., "Generates pagination logic for REST APIs when the user needs to implement cursor-based or offset-based pagination over database query results").

\`\`\`description
[Your description here — plain text, no markdown, max 1024 chars]
\`\`\`

### SKILL.md Body

Write the markdown body (everything AFTER the frontmatter). Include:
- Step-by-step instructions derived from the key steps
- Input/output examples where helpful
- Edge case handling
- The body must be self-contained — an agent reading only this skill should be able to apply it

\`\`\`markdown
[Your markdown body here]
\`\`\`

### Test Script

Write a Bun test file (\`scripts/test.ts\`) that validates the skill's core behavior:
- Import from \`bun:test\`: \`import { describe, it, expect } from 'bun:test'\`
- Include at least one positive test case
- Include at least one edge case test
- Tests should validate the patterns/logic described in the skill, not the SKILL.md file itself

\`\`\`typescript
[Your test script here]
\`\`\`

Generate all three outputs now.`
}

// ── LLM output parsing ───────────────────────────────────────────────

/**
 * Extract content from a labeled fenced code block.
 * Looks for ```<label>\n...\n``` pattern.
 */
function extractBlock(text: string, label: string): string | undefined {
  // Match ```label ... ``` with possible whitespace
  const pattern = new RegExp('```' + label + '\\s*\\n([\\s\\S]*?)\\n\\s*```', 'i')
  const match = text.match(pattern)
  return match ? match[1].trim() : undefined
}

/**
 * Parse raw LLM output into skill components.
 * Expects three labeled fenced code blocks: description, markdown, typescript.
 */
export function parseSkillResponse(
  llmOutput: string,
  record: ReflectionRecord,
): Result<GeneratedSkill> {
  const description = extractBlock(llmOutput, 'description')
  if (!description) {
    return err(
      new Error('LLM output missing ```description``` block. Cannot extract skill description.'),
    )
  }

  const body = extractBlock(llmOutput, 'markdown')
  if (!body) {
    return err(new Error('LLM output missing ```markdown``` block. Cannot extract skill body.'))
  }

  const testScript = extractBlock(llmOutput, 'typescript')
  if (!testScript) {
    return err(new Error('LLM output missing ```typescript``` block. Cannot extract test script.'))
  }

  // Validate description length
  if (description.length > 1024) {
    return err(
      new Error(
        `Generated description exceeds 1024 characters (${description.length}). Ask the LLM to be more concise.`,
      ),
    )
  }

  const skillName = record.proposedSkillName ?? 'unnamed-skill'

  const frontmatter: SkillFrontmatter = {
    name: skillName,
    description,
    license: 'Apache-2.0',
    metadata: {
      author: 'ouroboros-rsi',
      version: '1.0',
      generated: 'true',
      confidence: record.generalizability,
      source_task: record.taskSummary,
      source_sessions: dedupeStrings(
        (record.sourceReferences ?? []).map((reference) => reference.sessionId),
      ),
      source_observations: dedupeStrings(
        (record.sourceReferences ?? []).flatMap((reference) => reference.observationIds),
      ),
      source_timestamps: dedupeStrings(
        (record.sourceReferences ?? []).flatMap((reference) => reference.observationTimestamps),
      ),
    },
  }

  const fmValidation = validateFrontmatter(frontmatter)
  if (!fmValidation.ok) return fmValidation as Result<never>

  return ok({
    name: skillName,
    frontmatter,
    body,
    testScript,
  })
}

// ── Core skill generation API ───────────────────────────────────────

/**
 * Generate a skill from a reflection record using an LLM.
 *
 * @param record     - The reflection record (must have shouldCrystallize: true)
 * @param transcript - Optional task transcript for richer context
 * @param llm        - The language model to use for generation
 * @param basePath   - Project root for loading example skills (defaults to cwd)
 * @returns Result containing the generated skill or an error
 */
export async function generateSkill(
  record: ReflectionRecord,
  transcript: string | undefined,
  llm: LanguageModel,
  basePath?: string,
): Promise<Result<GeneratedSkill>> {
  // 1. Validate reflection record
  if (!record.shouldCrystallize) {
    return err(
      new Error(
        'Reflection record has shouldCrystallize: false. ' +
          'Only crystallizable reflections can be turned into skills.',
      ),
    )
  }

  const skillName = record.proposedSkillName
  if (!skillName) {
    return err(new Error('Reflection record is missing proposedSkillName'))
  }

  // 2. Validate skill name format
  const nameResult = validateSkillName(skillName)
  if (!nameResult.ok) return nameResult as Result<never>

  const resolvedBase = basePath ?? process.cwd()

  // 3. Build generation prompt
  const prompt = buildGenerationPrompt(record, transcript, resolvedBase)

  // 4. Call the LLM
  const llmResult = await generateRSIResponse(
    llm,
    [{ role: 'user', content: prompt }],
    buildRSILLMCallOptions(llm, 0.7, 4096),
  )

  if (!llmResult.ok) {
    return err(new Error(`LLM generation failed: ${llmResult.error.message}`))
  }

  const llmOutput = llmResult.value.text
  if (!llmOutput || llmOutput.trim() === '') {
    return err(new Error('LLM returned empty output'))
  }

  // 5. Parse LLM output into skill components
  return parseSkillResponse(llmOutput, record)
}

/**
 * Write a generated skill to the staging directory.
 *
 * Validates name uniqueness and frontmatter before writing.
 * Creates: skills/staging/<name>/SKILL.md and skills/staging/<name>/scripts/test.ts
 *
 * @param skill      - The generated skill to write
 * @param basePath   - Project root (skills/staging/ is resolved relative to this)
 * @returns Result containing the absolute path to the skill directory or an error
 */
export async function writeSkillToStaging(
  skill: GeneratedSkill,
  basePath: string,
): Promise<Result<string>> {
  // 1. Validate skill name
  const nameResult = validateSkillName(skill.name)
  if (!nameResult.ok) return nameResult as Result<never>

  // 2. Check uniqueness
  const uniqueResult = checkNameUniqueness(skill.name, basePath)
  if (!uniqueResult.ok) return uniqueResult as Result<never>

  // 3. Validate frontmatter
  const fmResult = validateFrontmatter(skill.frontmatter)
  if (!fmResult.ok) return fmResult as Result<never>

  // 4. Build SKILL.md content
  const yamlContent = stringifyYaml(skill.frontmatter as unknown as Record<string, unknown>)
  const skillMdContent = `---\n${yamlContent}---\n\n${skill.body}\n`

  // 5. Validate round-trip
  const rtResult = validateRoundTrip(skillMdContent)
  if (!rtResult.ok) return rtResult as Result<never>

  // 6. Write files
  const stagingDir = join(basePath, 'skills', 'staging', skill.name)
  const scriptsDir = join(stagingDir, 'scripts')

  try {
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(stagingDir, 'SKILL.md'), skillMdContent, 'utf-8')
    writeFileSync(join(scriptsDir, 'test.ts'), skill.testScript, 'utf-8')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write skill files: ${message}`))
  }

  return ok(stagingDir)
}

// ── Crystallization pipeline types ──────────────────────────────────

export { type SkillTestResult } from '@src/rsi/validate'

export interface CrystallizationResult {
  outcome: 'no-crystallization' | 'generated' | 'test-failed' | 'promoted'
  reflection?: ReflectionRecord
  skillName?: string
  skillPath?: string
  testResult?: SkillTestResult
}

export interface CrystallizeOptions {
  transcript?: string
  llm: LanguageModel
  skillDirs: { staging: string; generated: string; core: string }
  noveltyThreshold?: number
  existingSkills?: SkillCatalogEntry[]
  observationSessions?: ObservationCrystallizationSession[]
}

// ── Crystallization pipeline ─────────────────────────────────────────

/**
 * Orchestrate the full crystallization pipeline:
 *   1. Reflect — Analyze the task for reusable patterns
 *   2. Generate — Produce a skill directory in staging
 *   3. Validate — Check SKILL.md against requirements
 *   4. Test — Run skill tests
 *   5. Promote — Move to generated/
 *
 * If any stage fails, the pipeline stops and reports the failure.
 */
export async function crystallize(
  taskSummary: string,
  options: CrystallizeOptions,
): Promise<Result<CrystallizationResult>> {
  const {
    transcript,
    llm,
    skillDirs,
    noveltyThreshold = 0.7,
    existingSkills = [],
    observationSessions = [],
  } = options

  // ── Stage 1: Reflect ────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 1/5: Reflecting on task...\n')

  const reflectionResult =
    observationSessions.length > 0
      ? reflectFromObservationPatterns(taskSummary, observationSessions, {
          existingSkills,
          noveltyThreshold,
        })
      : await reflect(taskSummary, existingSkills, llm)
  if (!reflectionResult.ok) {
    return err(new Error(`[reflect] ${reflectionResult.error.message}`))
  }

  const reflection = reflectionResult.value

  if (!shouldCrystallize(reflection, noveltyThreshold)) {
    process.stderr.write(
      `[crystallize] Novelty ${reflection.novelty} below threshold ${noveltyThreshold}. No crystallization.\n`,
    )
    return ok({
      outcome: 'no-crystallization',
      reflection,
    })
  }

  process.stderr.write(
    `[crystallize] Novelty ${reflection.novelty} >= ${noveltyThreshold}. Proceeding.\n`,
  )

  const skillName = reflection.proposedSkillName
  if (!skillName) {
    return err(
      new Error('[reflect] Reflection marked shouldCrystallize but missing proposedSkillName'),
    )
  }

  // ── Stage 2: Generate ───────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 2/5: Generating skill...\n')

  // basePath = project root; skillDirs.staging is <root>/skills/staging
  const basePath = join(skillDirs.staging, '..', '..')

  const genResult = await generateSkill(reflection, transcript, llm, basePath)
  if (!genResult.ok) {
    return err(new Error(`[generate] ${genResult.error.message}`))
  }

  const skill = genResult.value

  const writeResult = await writeSkillToStaging(skill, basePath)
  if (!writeResult.ok) {
    return err(new Error(`[generate] ${writeResult.error.message}`))
  }

  const stagingPath = writeResult.value

  process.stderr.write(`[crystallize] Skill written to ${stagingPath}\n`)

  // ── Stage 3: Validate ───────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 3/5: Validating skill...\n')

  const fmResult = validateFrontmatter(skill.frontmatter)
  if (!fmResult.ok) {
    return err(new Error(`[validate] ${fmResult.error.message}`))
  }

  const skillMdPath = join(stagingPath, 'SKILL.md')
  let skillMdContent: string
  try {
    skillMdContent = readFileSync(skillMdPath, 'utf-8')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`[validate] Could not read SKILL.md: ${message}`))
  }

  const rtResult = validateRoundTrip(skillMdContent)
  if (!rtResult.ok) {
    return err(new Error(`[validate] ${rtResult.error.message}`))
  }

  const scriptsDir = join(stagingPath, 'scripts')
  if (!existsSync(scriptsDir) || readdirSync(scriptsDir).length === 0) {
    return err(new Error('[validate] No test files found in scripts/ directory'))
  }

  process.stderr.write('[crystallize] Validation passed.\n')

  // ── Stage 4: Test ───────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 4/5: Running tests...\n')

  const testResult = await runSkillTests(stagingPath)
  if (!testResult.ok) {
    return err(new Error(`[test] ${testResult.error.message}`))
  }

  if (testResult.value.overall !== 'pass') {
    process.stderr.write(`[crystallize] Tests failed. Skill remains in staging at ${stagingPath}\n`)
    return ok({
      outcome: 'test-failed',
      reflection,
      skillName: skill.name,
      skillPath: stagingPath,
      testResult: testResult.value,
    })
  }

  process.stderr.write('[crystallize] Tests passed.\n')

  // ── Stage 5: Promote ────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 5/5: Promoting skill...\n')

  const generatedPath = join(skillDirs.generated, skill.name)

  try {
    mkdirSync(skillDirs.generated, { recursive: true })
    cpSync(stagingPath, generatedPath, { recursive: true })
    rmSync(stagingPath, { recursive: true, force: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`[promote] Failed to move skill to generated: ${message}`))
  }

  process.stderr.write(`[crystallize] Skill promoted to ${generatedPath}\n`)

  return ok({
    outcome: 'promoted',
    reflection,
    skillName: skill.name,
    skillPath: generatedPath,
    testResult: testResult.value,
  })
}
