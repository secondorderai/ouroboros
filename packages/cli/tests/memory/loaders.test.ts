import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  loadLayeredMemory,
  renderCheckpointForPrompt,
  trimMarkdownBySectionBudget,
} from '@src/memory/loaders'
import { writeCheckpoint } from '@src/memory/checkpoints'
import { updateMemoryIndex } from '@src/memory/index'
import { resolveDailyMemoryPath } from '@src/memory/paths'
import type { ReflectionCheckpoint } from '@src/rsi/types'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'

describe('memory loaders', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-memory-loaders')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('loads durable, checkpoint, and recent working memory independently', () => {
    updateMemoryIndex(
      [
        '# MEMORY',
        '',
        '## Durable Facts',
        '- Uses Bun',
        '',
        '## Preferences',
        '- Prefer concise answers',
      ].join('\n'),
      tempDir,
    )

    const checkpoint: ReflectionCheckpoint = {
      sessionId: 'session-1',
      updatedAt: '2026-04-15T09:00:00.000Z',
      goal: 'Finish prompt layering',
      currentPlan: ['Load memory sections', 'Refactor prompt'],
      constraints: ['Do not regress AGENTS prompt behavior'],
      decisionsMade: ['Use checkpoint as prompt subsection'],
      filesInPlay: ['packages/cli/src/llm/prompt.ts'],
      completedWork: ['Added memory loader API'],
      openLoops: ['Verify daily memory ordering'],
      nextBestStep: 'Add prompt tests',
      durableMemoryCandidates: [],
      skillCandidates: [],
    }
    writeCheckpoint(checkpoint, tempDir)

    mkdirSync(dirname(resolveDailyMemoryPath('2026-04-15', tempDir)), { recursive: true })
    writeFileSync(
      resolveDailyMemoryPath('2026-04-14', tempDir),
      '# Yesterday\n\nClosed an earlier loop.',
      'utf-8',
    )
    writeFileSync(
      resolveDailyMemoryPath('2026-04-15', tempDir),
      '# Today\n\nCaptured fresh working notes.',
      'utf-8',
    )

    const result = loadLayeredMemory({
      basePath: tempDir,
      sessionId: 'session-1',
      config: {
        dailyLoadDays: 2,
        durableMemoryBudgetTokens: 200,
        checkpointBudgetTokens: 200,
        workingMemoryBudgetTokens: 200,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.durableMemory).toContain('## Durable Facts')
    expect(result.value.checkpointMemory).toContain('# Reflection Checkpoint')
    expect(result.value.checkpointMemory).toContain('## Next Best Step')
    expect(result.value.workingMemory).toContain('## 2026-04-15')
    expect(result.value.workingMemory).toContain('## 2026-04-14')
    expect(result.value.workingMemory?.indexOf('## 2026-04-15')).toBeLessThan(
      result.value.workingMemory?.indexOf('## 2026-04-14') ?? 0,
    )
  })

  test('durable memory trimming happens on section boundaries', () => {
    const content = ['# MEMORY', '', '## A', 'one', '', '## B', 'two', '', '## C', 'three'].join(
      '\n',
    )

    const trimmed = trimMarkdownBySectionBudget(content, 5)

    expect(trimmed).toContain('## A')
    expect(trimmed).not.toContain('## C')
    expect(trimmed.endsWith('th')).toBe(false)
  })

  test('checkpoint prompt trimming preserves active state before lower-priority sections', () => {
    const checkpoint: ReflectionCheckpoint = {
      sessionId: 'session-2',
      updatedAt: '2026-04-15T10:00:00.000Z',
      goal: 'Keep the session resumable',
      currentPlan: ['Do first thing', 'Do second thing'],
      constraints: ['Keep constraints', 'Preserve checkpoint integrity'],
      decisionsMade: ['Decision one', 'Decision two', 'Decision three'],
      filesInPlay: ['a.ts', 'b.ts', 'c.ts'],
      completedWork: ['Task one', 'Task two', 'Task three', 'Task four'],
      openLoops: ['Still need to finish tests'],
      nextBestStep: 'Write budget enforcement coverage',
      durableMemoryCandidates: [
        {
          title: 'Candidate',
          summary: 'Long candidate summary',
          content: 'Long candidate content',
          kind: 'workflow',
          confidence: 0.9,
          observedAt: '2026-04-15T10:00:00.000Z',
          tags: ['candidate'],
          evidence: ['evidence'],
        },
      ],
      skillCandidates: [
        {
          name: 'skill-candidate',
          summary: 'Long skill summary',
          trigger: 'When this happens',
          workflow: ['step 1', 'step 2'],
          confidence: 0.9,
          sourceObservationIds: ['obs-1'],
          sourceSessionIds: ['session-2'],
        },
      ],
    }

    const trimmed = renderCheckpointForPrompt(checkpoint, 90)

    expect(trimmed).toContain('## Constraints')
    expect(trimmed).toContain('## Open Loops')
    expect(trimmed).toContain('## Next Best Step')
    expect(trimmed).not.toContain('## Durable Memory Candidates')
    expect(trimmed).not.toContain('## Skill Candidates')
  })

  test('working memory respects daily load day limit', () => {
    mkdirSync(dirname(resolveDailyMemoryPath('2026-04-15', tempDir)), { recursive: true })
    writeFileSync(resolveDailyMemoryPath('2026-04-13', tempDir), 'Oldest', 'utf-8')
    writeFileSync(resolveDailyMemoryPath('2026-04-14', tempDir), 'Middle', 'utf-8')
    writeFileSync(resolveDailyMemoryPath('2026-04-15', tempDir), 'Newest', 'utf-8')

    const result = loadLayeredMemory({
      basePath: tempDir,
      config: {
        dailyLoadDays: 2,
        durableMemoryBudgetTokens: 50,
        checkpointBudgetTokens: 50,
        workingMemoryBudgetTokens: 50,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.workingMemory).toContain('2026-04-15')
    expect(result.value.workingMemory).toContain('2026-04-14')
    expect(result.value.workingMemory).not.toContain('2026-04-13')
  })
})
