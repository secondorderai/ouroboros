import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OuroborosConfig } from '@src/config'
import { DEFAULT_MEMORY_CONFIG } from '@src/config'
import { readCheckpoint } from '@src/memory/checkpoints'
import { getMemoryIndex } from '@src/memory/index'
import { resolveDailyMemoryDir } from '@src/memory/paths'
import type { ReflectionCheckpoint } from '@src/rsi/types'
import { err, ok, type Result } from '@src/types'

export interface LayeredMemorySections {
  durableMemory?: string
  checkpointMemory?: string
  workingMemory?: string
}

export interface LoadLayeredMemoryOptions {
  basePath?: string
  sessionId?: string
  config?: Pick<
    OuroborosConfig['memory'],
    | 'dailyLoadDays'
    | 'durableMemoryBudgetTokens'
    | 'checkpointBudgetTokens'
    | 'workingMemoryBudgetTokens'
  >
}

const CHECKPOINT_SECTION_PRIORITY = [
  'Next Best Step',
  'Constraints',
  'Open Loops',
  'Goal',
  'Current Plan',
  'Decisions Made',
  'Files / Artifacts In Play',
  'Completed Work',
  'Durable Memory Candidates',
  'Skill Candidates',
] as const

const CHECKPOINT_RENDER_ORDER = [
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

function estimateTokens(text: string): number {
  const normalized = text.trim()
  if (normalized.length === 0) {
    return 0
  }

  return Math.ceil(normalized.length / 4)
}

function splitByParagraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function splitMarkdownBlocks(text: string): string[] {
  const normalized = text.trim()
  if (normalized.length === 0) {
    return []
  }

  const matches = [...normalized.matchAll(/^#{1,6} .+$/gm)]
  if (matches.length === 0) {
    return splitByParagraphs(normalized)
  }

  const blocks: string[] = []
  let start = 0
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    const position = match.index ?? 0
    if (position > start) {
      const preamble = normalized.slice(start, position).trim()
      if (preamble.length > 0) {
        blocks.push(preamble)
      }
    }

    const nextPosition =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? normalized.length)
        : normalized.length
    const block = normalized.slice(position, nextPosition).trim()
    if (block.length > 0) {
      blocks.push(block)
    }
    start = nextPosition
  }

  return blocks
}

function packBlocks(blocks: string[], budgetTokens: number): string {
  if (budgetTokens <= 0) {
    return ''
  }

  const packed: string[] = []
  let usedTokens = 0

  for (const block of blocks) {
    const blockTokens = estimateTokens(block)
    if (blockTokens > budgetTokens) {
      if (packed.length === 0) {
        const paragraphs = splitByParagraphs(block)
        if (paragraphs.length > 1) {
          return packBlocks(paragraphs, budgetTokens)
        }
      }
      continue
    }

    const separatorTokens = packed.length > 0 ? estimateTokens('\n\n') : 0
    if (usedTokens + separatorTokens + blockTokens > budgetTokens) {
      continue
    }

    packed.push(block)
    usedTokens += separatorTokens + blockTokens
  }

  return packed.join('\n\n')
}

export function trimMarkdownBySectionBudget(markdown: string, budgetTokens: number): string {
  const normalized = markdown.trim()
  if (normalized.length === 0 || budgetTokens <= 0) {
    return ''
  }

  if (estimateTokens(normalized) <= budgetTokens) {
    return normalized
  }

  return packBlocks(splitMarkdownBlocks(normalized), budgetTokens).trim()
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return '_None_'
  }

  return items.map((item) => `- ${item}`).join('\n')
}

function renderScalar(value: string): string {
  return value.trim().length > 0 ? value.trim() : '_None_'
}

function renderYaml(values: unknown[]): string {
  const serialized = JSON.stringify(values, null, 2)
  return ['```json', serialized, '```'].join('\n')
}

function checkpointSectionMap(checkpoint: ReflectionCheckpoint): Record<string, string> {
  return {
    Goal: `## Goal\n${renderScalar(checkpoint.goal)}`,
    'Current Plan': `## Current Plan\n${renderList(checkpoint.currentPlan)}`,
    Constraints: `## Constraints\n${renderList(checkpoint.constraints)}`,
    'Decisions Made': `## Decisions Made\n${renderList(checkpoint.decisionsMade)}`,
    'Files / Artifacts In Play': `## Files / Artifacts In Play\n${renderList(checkpoint.filesInPlay)}`,
    'Completed Work': `## Completed Work\n${renderList(checkpoint.completedWork)}`,
    'Open Loops': `## Open Loops\n${renderList(checkpoint.openLoops)}`,
    'Next Best Step': `## Next Best Step\n${renderScalar(checkpoint.nextBestStep)}`,
    'Durable Memory Candidates': `## Durable Memory Candidates\n${renderYaml(
      checkpoint.durableMemoryCandidates,
    )}`,
    'Skill Candidates': `## Skill Candidates\n${renderYaml(checkpoint.skillCandidates)}`,
  }
}

export function renderCheckpointForPrompt(
  checkpoint: ReflectionCheckpoint,
  budgetTokens: number,
): string {
  if (budgetTokens <= 0) {
    return ''
  }

  const frontmatter = [
    '---',
    `sessionId: ${checkpoint.sessionId}`,
    `updatedAt: ${checkpoint.updatedAt}`,
    '---',
  ]
  const header = [...frontmatter, '', '# Reflection Checkpoint']
  const baseTokens = estimateTokens(header.join('\n'))
  const remainingBudget = budgetTokens - baseTokens
  if (remainingBudget <= 0) {
    return ''
  }

  const sections = checkpointSectionMap(checkpoint)
  const selected = new Set<string>()
  let usedTokens = 0

  for (const title of CHECKPOINT_SECTION_PRIORITY) {
    const section = sections[title]
    const sectionTokens = estimateTokens(section)
    const separatorTokens = selected.size > 0 ? estimateTokens('\n\n') : 0
    if (usedTokens + separatorTokens + sectionTokens > remainingBudget) {
      continue
    }

    selected.add(title)
    usedTokens += separatorTokens + sectionTokens
  }

  if (selected.size === 0) {
    return ''
  }

  const renderedSections = CHECKPOINT_RENDER_ORDER.filter((title) => selected.has(title)).map(
    (title) => sections[title],
  )

  return [...header, '', ...renderedSections, ''].join('\n').trim()
}

function readRecentDailyMemory(
  basePath: string | undefined,
  budgetTokens: number,
  dailyLoadDays: number,
): Result<string> {
  if (budgetTokens <= 0 || dailyLoadDays <= 0) {
    return ok('')
  }

  try {
    const dailyDir = resolveDailyMemoryDir(basePath)
    if (!existsSync(dailyDir)) {
      return ok('')
    }

    const entries = readdirSync(dailyDir)
      .filter((entry) => entry.endsWith('.md'))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, dailyLoadDays)

    const blocks = entries
      .map((entry) => {
        const content = readFileSync(join(dailyDir, entry), 'utf-8').trim()
        if (content.length === 0) {
          return ''
        }
        return `## ${entry.replace(/\.md$/, '')}\n\n${content}`
      })
      .filter((block) => block.length > 0)

    return ok(packBlocks(blocks, budgetTokens).trim())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to load daily memory: ${message}`))
  }
}

export function loadLayeredMemory(
  options: LoadLayeredMemoryOptions = {},
): Result<LayeredMemorySections> {
  const config = {
    dailyLoadDays: options.config?.dailyLoadDays ?? DEFAULT_MEMORY_CONFIG.dailyLoadDays,
    durableMemoryBudgetTokens:
      options.config?.durableMemoryBudgetTokens ?? DEFAULT_MEMORY_CONFIG.durableMemoryBudgetTokens,
    checkpointBudgetTokens:
      options.config?.checkpointBudgetTokens ?? DEFAULT_MEMORY_CONFIG.checkpointBudgetTokens,
    workingMemoryBudgetTokens:
      options.config?.workingMemoryBudgetTokens ?? DEFAULT_MEMORY_CONFIG.workingMemoryBudgetTokens,
  }

  const durableResult = getMemoryIndex(options.basePath)
  if (!durableResult.ok) {
    return durableResult
  }

  const checkpointResult = options.sessionId
    ? readCheckpoint(options.sessionId, options.basePath)
    : ok<ReflectionCheckpoint | null>(null)
  if (!checkpointResult.ok) {
    return checkpointResult
  }

  const dailyResult = readRecentDailyMemory(
    options.basePath,
    config.workingMemoryBudgetTokens,
    config.dailyLoadDays,
  )
  if (!dailyResult.ok) {
    return dailyResult
  }

  return ok({
    durableMemory: trimMarkdownBySectionBudget(
      durableResult.value,
      config.durableMemoryBudgetTokens,
    ),
    checkpointMemory: checkpointResult.value
      ? renderCheckpointForPrompt(checkpointResult.value, config.checkpointBudgetTokens)
      : '',
    workingMemory: dailyResult.value,
  })
}
