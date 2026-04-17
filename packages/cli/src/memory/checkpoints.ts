import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { resolveCheckpointPath } from '@src/memory/paths'
import { readObservations } from '@src/memory/observations'
import type {
  DurableMemoryCandidate,
  ObservationPriority,
  ObservationRecord,
  ReflectionCheckpoint,
  SkillCandidate,
} from '@src/rsi/types'
import { type Result, err, ok } from '@src/types'

const CHECKPOINT_TITLE = '# Reflection Checkpoint'
const NONE_PLACEHOLDER = '_None_'
const checkpointSectionTitles = [
  'Goal',
  'Current Plan',
  'Constraints',
  'Decisions Made',
  'Files / Artifacts In Play',
  'Completed Work',
  'Open Loops',
  'Next Best Step',
  'Durable Memory Candidates',
  'Skill Candidates',
] as const

const listSectionTitles = new Set([
  'Current Plan',
  'Constraints',
  'Decisions Made',
  'Files / Artifacts In Play',
  'Completed Work',
  'Open Loops',
])

const scalarSectionTitles = new Set(['Goal', 'Next Best Step'])

const durableKinds = ['fact', 'preference', 'constraint', 'workflow'] as const

const nonEmptyStringSchema = z.string().trim().min(1)
const timestampSchema = nonEmptyStringSchema.refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'Invalid ISO 8601 timestamp',
)

const durableMemoryCandidateSchema = z.object({
  title: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  content: nonEmptyStringSchema,
  kind: z.enum(durableKinds),
  confidence: z.number().min(0).max(1),
  observedAt: timestampSchema,
  tags: z.array(nonEmptyStringSchema),
  evidence: z.array(nonEmptyStringSchema),
})

const skillCandidateSchema = z.object({
  name: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  trigger: nonEmptyStringSchema,
  workflow: z.array(nonEmptyStringSchema),
  confidence: z.number().min(0).max(1),
  sourceObservationIds: z.array(nonEmptyStringSchema),
  sourceSessionIds: z.array(nonEmptyStringSchema),
})

const reflectionCheckpointSchema = z.object({
  sessionId: nonEmptyStringSchema,
  updatedAt: timestampSchema,
  goal: z.string(),
  currentPlan: z.array(nonEmptyStringSchema),
  constraints: z.array(nonEmptyStringSchema),
  decisionsMade: z.array(nonEmptyStringSchema),
  filesInPlay: z.array(nonEmptyStringSchema),
  completedWork: z.array(nonEmptyStringSchema),
  openLoops: z.array(nonEmptyStringSchema),
  nextBestStep: z.string(),
  durableMemoryCandidates: z.array(durableMemoryCandidateSchema),
  skillCandidates: z.array(skillCandidateSchema),
})

interface ParsedCheckpointFrontmatter {
  sessionId: string
  updatedAt: string
}

function formatZodIssues(prefix: string, error: z.ZodError): Error {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ')
  return new Error(`${prefix}: ${issues}`)
}

function normalizeObservations(observations: ObservationRecord[]): Result<ObservationRecord[]> {
  const sessionIds = new Set(observations.map((observation) => observation.sessionId))
  if (sessionIds.size > 1) {
    return err(new Error('Checkpoint reflections require observations from a single session'))
  }

  return ok(
    [...observations].sort((left, right) => {
      const timeDiff = Date.parse(left.observedAt) - Date.parse(right.observedAt)
      if (timeDiff !== 0) {
        return timeDiff
      }
      return left.id.localeCompare(right.id)
    }),
  )
}

function confidenceFromPriority(priority: ObservationPriority): number {
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

function getTagValue(tags: string[], prefix: string): string | undefined {
  const match = tags.find((tag) => tag.startsWith(`${prefix}:`))
  return match ? match.slice(prefix.length + 1).trim() : undefined
}

function hasTag(tags: string[], candidates: string[]): boolean {
  return tags.some((tag) => candidates.includes(tag))
}

function extractActiveObservations(observations: ObservationRecord[]): ObservationRecord[] {
  const superseded = new Set<string>()
  for (const observation of observations) {
    for (const supersededId of observation.supersedes ?? []) {
      superseded.add(supersededId)
    }
  }

  return observations.filter((observation) => !superseded.has(observation.id))
}

function uniquePush(target: string[], value: string | undefined): void {
  if (!value) {
    return
  }

  const normalized = value.trim()
  if (normalized.length === 0 || target.includes(normalized)) {
    return
  }

  target.push(normalized)
}

function inferProgressSection(observation: ObservationRecord): 'plan' | 'next-step' | 'completed' {
  if (hasTag(observation.tags, ['next-step', 'next_step'])) {
    return 'next-step'
  }

  if (hasTag(observation.tags, ['plan', 'current-plan', 'current_plan'])) {
    return 'plan'
  }

  return 'completed'
}

function inferDurableKind(observation: ObservationRecord): DurableMemoryCandidate['kind'] {
  const explicit = getTagValue(observation.tags, 'kind')
  if (explicit && durableKinds.includes(explicit as DurableMemoryCandidate['kind'])) {
    return explicit as DurableMemoryCandidate['kind']
  }

  if (hasTag(observation.tags, ['preference'])) {
    return 'preference'
  }

  if (hasTag(observation.tags, ['constraint'])) {
    return 'constraint'
  }

  if (hasTag(observation.tags, ['workflow'])) {
    return 'workflow'
  }

  return 'fact'
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'candidate'
}

function toDurableMemoryCandidate(observation: ObservationRecord): DurableMemoryCandidate {
  return {
    title: getTagValue(observation.tags, 'title') ?? observation.summary,
    summary: observation.summary,
    content: getTagValue(observation.tags, 'content') ?? observation.summary,
    kind: inferDurableKind(observation),
    confidence: confidenceFromPriority(observation.priority),
    observedAt: observation.observedAt,
    tags: observation.tags,
    evidence: observation.evidence,
  }
}

function toSkillCandidate(observation: ObservationRecord): SkillCandidate {
  return {
    name: getTagValue(observation.tags, 'name') ?? slugify(observation.summary),
    summary: observation.summary,
    trigger: getTagValue(observation.tags, 'trigger') ?? observation.summary,
    workflow: observation.evidence,
    confidence: confidenceFromPriority(observation.priority),
    sourceObservationIds: [observation.id],
    sourceSessionIds: [observation.sessionId],
  }
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return NONE_PLACEHOLDER
  }

  return items.map((item) => `- ${item}`).join('\n')
}

function renderScalar(value: string): string {
  return value.trim().length > 0 ? value : NONE_PLACEHOLDER
}

function renderYamlBlock(value: unknown): string {
  const yamlText = stringifyYaml(value).trim() || '[]'
  return ['```yaml', yamlText, '```'].join('\n')
}

function parseListSection(content: string): string[] {
  const trimmed = content.trim()
  if (trimmed.length === 0 || trimmed === NONE_PLACEHOLDER) {
    return []
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
}

function parseScalarSection(content: string): string {
  const trimmed = content.trim()
  return trimmed === NONE_PLACEHOLDER ? '' : trimmed
}

function extractYamlBlock(content: string): Result<unknown> {
  const trimmed = content.trim()
  const fenceMatch = trimmed.match(/^```yaml\n([\s\S]*?)\n```$/)
  const yamlText = fenceMatch ? fenceMatch[1] : trimmed

  try {
    return ok(parseYaml(yamlText))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Invalid checkpoint YAML block: ${message}`))
  }
}

function extractFrontmatter(
  markdown: string,
): Result<{ meta: ParsedCheckpointFrontmatter; body: string }> {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!frontmatterMatch) {
    return err(new Error('Checkpoint markdown is missing YAML frontmatter'))
  }

  let parsedMeta: unknown
  try {
    parsedMeta = parseYaml(frontmatterMatch[1])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Invalid checkpoint frontmatter: ${message}`))
  }

  const parsed = z
    .object({
      sessionId: nonEmptyStringSchema,
      updatedAt: timestampSchema,
    })
    .safeParse(parsedMeta)

  if (!parsed.success) {
    return err(formatZodIssues('Invalid checkpoint frontmatter', parsed.error))
  }

  return ok({ meta: parsed.data, body: frontmatterMatch[2] })
}

function extractSections(
  body: string,
): Result<Map<(typeof checkpointSectionTitles)[number], string>> {
  const normalizedBody = body.startsWith(`${CHECKPOINT_TITLE}\n`)
    ? body.slice(CHECKPOINT_TITLE.length).trimStart()
    : body.trimStart()
  const headingPattern = /^## (.+)$/gm
  const matches = [...normalizedBody.matchAll(headingPattern)]
  const sections = new Map<(typeof checkpointSectionTitles)[number], string>()

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const title = match[1] as (typeof checkpointSectionTitles)[number]
    const sectionStart = (match.index ?? 0) + match[0].length
    const nextIndex = matches[index + 1]?.index ?? normalizedBody.length
    const content = normalizedBody.slice(sectionStart, nextIndex).trim()
    sections.set(title, content)
  }

  const missingSection = checkpointSectionTitles.find((title) => !sections.has(title))
  if (missingSection) {
    return err(new Error(`Checkpoint markdown is missing required section "${missingSection}"`))
  }

  return ok(sections)
}

export function buildCheckpointFromObservations(
  observations: ObservationRecord[],
  options?: { sessionId?: string; updatedAt?: string },
): Result<ReflectionCheckpoint> {
  const normalizedResult = normalizeObservations(observations)
  if (!normalizedResult.ok) {
    return normalizedResult
  }

  const sessionId = options?.sessionId ?? normalizedResult.value[0]?.sessionId
  if (!sessionId) {
    return err(new Error('Cannot build checkpoint without observations or an explicit session ID'))
  }

  const updatedAt = options?.updatedAt ?? new Date().toISOString()
  const parsedUpdatedAt = timestampSchema.safeParse(updatedAt)
  if (!parsedUpdatedAt.success) {
    return err(formatZodIssues('Invalid checkpoint timestamp', parsedUpdatedAt.error))
  }

  const activeObservations = extractActiveObservations(normalizedResult.value)
  const currentPlan: string[] = []
  const constraints: string[] = []
  const decisionsMade: string[] = []
  const filesInPlay: string[] = []
  const completedWork: string[] = []
  const openLoops: string[] = []
  const durableMemoryCandidates: DurableMemoryCandidate[] = []
  const skillCandidates: SkillCandidate[] = []

  let goal = ''
  let nextBestStep = ''

  for (const observation of activeObservations) {
    switch (observation.kind) {
      case 'goal':
        goal = observation.summary
        break
      case 'constraint':
      case 'warning':
        uniquePush(constraints, observation.summary)
        break
      case 'decision':
        uniquePush(decisionsMade, observation.summary)
        break
      case 'artifact':
        uniquePush(filesInPlay, getTagValue(observation.tags, 'file') ?? observation.summary)
        break
      case 'progress': {
        const section = inferProgressSection(observation)
        if (section === 'plan') {
          uniquePush(currentPlan, observation.summary)
        } else if (section === 'next-step') {
          nextBestStep = observation.summary
        } else {
          uniquePush(completedWork, observation.summary)
        }
        break
      }
      case 'open-loop':
        uniquePush(openLoops, observation.summary)
        break
      case 'candidate-durable':
        durableMemoryCandidates.push(toDurableMemoryCandidate(observation))
        break
      case 'candidate-skill':
        skillCandidates.push(toSkillCandidate(observation))
        break
      case 'preference':
      case 'fact':
        break
    }
  }

  return ok({
    sessionId,
    updatedAt: parsedUpdatedAt.data,
    goal,
    currentPlan,
    constraints,
    decisionsMade,
    filesInPlay,
    completedWork,
    openLoops,
    nextBestStep,
    durableMemoryCandidates,
    skillCandidates,
  })
}

export function renderCheckpointMarkdown(checkpoint: ReflectionCheckpoint): Result<string> {
  const parsed = reflectionCheckpointSchema.safeParse(checkpoint)
  if (!parsed.success) {
    return err(formatZodIssues('Invalid reflection checkpoint', parsed.error))
  }

  const frontmatter = stringifyYaml({
    sessionId: parsed.data.sessionId,
    updatedAt: parsed.data.updatedAt,
  }).trim()

  const sections = [
    `## Goal\n${renderScalar(parsed.data.goal)}`,
    `## Current Plan\n${renderList(parsed.data.currentPlan)}`,
    `## Constraints\n${renderList(parsed.data.constraints)}`,
    `## Decisions Made\n${renderList(parsed.data.decisionsMade)}`,
    `## Files / Artifacts In Play\n${renderList(parsed.data.filesInPlay)}`,
    `## Completed Work\n${renderList(parsed.data.completedWork)}`,
    `## Open Loops\n${renderList(parsed.data.openLoops)}`,
    `## Next Best Step\n${renderScalar(parsed.data.nextBestStep)}`,
    `## Durable Memory Candidates\n${renderYamlBlock(parsed.data.durableMemoryCandidates)}`,
    `## Skill Candidates\n${renderYamlBlock(parsed.data.skillCandidates)}`,
  ]

  return ok(['---', frontmatter, '---', '', CHECKPOINT_TITLE, '', ...sections, ''].join('\n'))
}

export function parseCheckpointMarkdown(markdown: string): Result<ReflectionCheckpoint> {
  const frontmatterResult = extractFrontmatter(markdown)
  if (!frontmatterResult.ok) {
    return frontmatterResult
  }

  const sectionsResult = extractSections(frontmatterResult.value.body)
  if (!sectionsResult.ok) {
    return sectionsResult
  }

  const sections = sectionsResult.value
  const durableResult = extractYamlBlock(sections.get('Durable Memory Candidates') ?? '')
  if (!durableResult.ok) {
    return durableResult
  }
  const skillResult = extractYamlBlock(sections.get('Skill Candidates') ?? '')
  if (!skillResult.ok) {
    return skillResult
  }

  const parsed = reflectionCheckpointSchema.safeParse({
    sessionId: frontmatterResult.value.meta.sessionId,
    updatedAt: frontmatterResult.value.meta.updatedAt,
    goal: parseScalarSection(sections.get('Goal') ?? ''),
    currentPlan: parseListSection(sections.get('Current Plan') ?? ''),
    constraints: parseListSection(sections.get('Constraints') ?? ''),
    decisionsMade: parseListSection(sections.get('Decisions Made') ?? ''),
    filesInPlay: parseListSection(sections.get('Files / Artifacts In Play') ?? ''),
    completedWork: parseListSection(sections.get('Completed Work') ?? ''),
    openLoops: parseListSection(sections.get('Open Loops') ?? ''),
    nextBestStep: parseScalarSection(sections.get('Next Best Step') ?? ''),
    durableMemoryCandidates: durableResult.value,
    skillCandidates: skillResult.value,
  })

  if (!parsed.success) {
    return err(formatZodIssues('Invalid parsed reflection checkpoint', parsed.error))
  }

  return ok(parsed.data)
}

export function writeCheckpoint(
  checkpoint: ReflectionCheckpoint,
  basePath?: string,
): Result<string> {
  const markdownResult = renderCheckpointMarkdown(checkpoint)
  if (!markdownResult.ok) {
    return markdownResult
  }

  try {
    const checkpointPath = resolveCheckpointPath(checkpoint.sessionId, basePath)
    mkdirSync(dirname(checkpointPath), { recursive: true })
    writeFileSync(checkpointPath, markdownResult.value, 'utf-8')
    return ok(checkpointPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to write checkpoint: ${message}`))
  }
}

export function readCheckpoint(
  sessionId: string,
  basePath?: string,
): Result<ReflectionCheckpoint | null> {
  try {
    const checkpointPath = resolveCheckpointPath(sessionId, basePath)
    if (!existsSync(checkpointPath)) {
      return ok(null)
    }

    return parseCheckpointMarkdown(readFileSync(checkpointPath, 'utf-8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to read checkpoint: ${message}`))
  }
}

export function reflectCheckpoint(
  sessionId: string,
  options?: { observations?: ObservationRecord[]; updatedAt?: string; basePath?: string },
): Result<ReflectionCheckpoint> {
  const observationsResult = options?.observations
    ? ok(options.observations)
    : readObservations(sessionId, options?.basePath)
  if (!observationsResult.ok) {
    return observationsResult
  }

  const checkpointResult = buildCheckpointFromObservations(observationsResult.value, {
    sessionId,
    updatedAt: options?.updatedAt,
  })
  if (!checkpointResult.ok) {
    return checkpointResult
  }

  const writeResult = writeCheckpoint(checkpointResult.value, options?.basePath)
  if (!writeResult.ok) {
    return writeResult
  }

  return checkpointResult
}

export const CHECKPOINT_SECTION_ORDER = [...checkpointSectionTitles]
export const CHECKPOINT_LIST_SECTIONS = [...listSectionTitles]
export const CHECKPOINT_SCALAR_SECTIONS = [...scalarSectionTitles]
