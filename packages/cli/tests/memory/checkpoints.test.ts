import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKPOINT_SECTION_ORDER,
  buildCheckpointFromObservations,
  parseCheckpointMarkdown,
  reflectCheckpoint,
  renderCheckpointMarkdown,
} from '@src/memory/checkpoints'
import { appendObservationBatch } from '@src/memory/observations'
import { resolveCheckpointPath } from '@src/memory/paths'
import type { ObservationRecord } from '@src/rsi/types'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-checkpoints-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeCheckpointObservations(sessionId: string): ObservationRecord[] {
  return [
    {
      id: 'goal-1',
      sessionId,
      observedAt: '2026-04-15T00:00:01.000Z',
      kind: 'goal',
      summary: 'Ship reflection checkpoints for RSI memory',
      evidence: ['ticket-03'],
      priority: 'high',
      tags: ['phase-1'],
    },
    {
      id: 'constraint-1',
      sessionId,
      observedAt: '2026-04-15T00:00:02.000Z',
      kind: 'constraint',
      summary: 'Keep checkpoints independent from compaction',
      evidence: ['ticket-03 requirement'],
      priority: 'normal',
      tags: ['constraint'],
    },
    {
      id: 'constraint-2',
      sessionId,
      observedAt: '2026-04-15T00:00:03.000Z',
      kind: 'constraint',
      summary: 'Keep checkpoints independent from prompt loading and compaction',
      evidence: ['ticket-03 requirement'],
      priority: 'high',
      tags: ['constraint'],
      supersedes: ['constraint-1'],
    },
    {
      id: 'decision-1',
      sessionId,
      observedAt: '2026-04-15T00:00:04.000Z',
      kind: 'decision',
      summary: 'Use YAML frontmatter for checkpoint metadata',
      evidence: ['design note'],
      priority: 'normal',
      tags: ['checkpoint'],
    },
    {
      id: 'decision-2',
      sessionId,
      observedAt: '2026-04-15T00:00:05.000Z',
      kind: 'decision',
      summary: 'Render candidates in fenced YAML blocks',
      evidence: ['design note'],
      priority: 'high',
      tags: ['checkpoint'],
      supersedes: ['decision-1'],
    },
    {
      id: 'artifact-1',
      sessionId,
      observedAt: '2026-04-15T00:00:06.000Z',
      kind: 'artifact',
      summary: 'packages/cli/src/memory/checkpoints.ts',
      evidence: ['checkpoint module'],
      priority: 'normal',
      tags: ['file:packages/cli/src/memory/checkpoints.ts'],
    },
    {
      id: 'plan-1',
      sessionId,
      observedAt: '2026-04-15T00:00:07.000Z',
      kind: 'progress',
      summary: 'Add round-trip parsing coverage',
      evidence: ['checkpoint tests'],
      priority: 'normal',
      tags: ['plan'],
    },
    {
      id: 'completed-1',
      sessionId,
      observedAt: '2026-04-15T00:00:08.000Z',
      kind: 'progress',
      summary: 'Built deterministic checkpoint renderer',
      evidence: ['checkpoints.ts'],
      priority: 'high',
      tags: ['completed'],
    },
    {
      id: 'open-loop-1',
      sessionId,
      observedAt: '2026-04-15T00:00:09.000Z',
      kind: 'open-loop',
      summary: 'Wire checkpoint reflection into the orchestrator',
      evidence: ['follow-up'],
      priority: 'normal',
      tags: ['orchestrator'],
    },
    {
      id: 'next-step-1',
      sessionId,
      observedAt: '2026-04-15T00:00:10.000Z',
      kind: 'progress',
      summary: 'Run memory checkpoint unit tests',
      evidence: ['bun test'],
      priority: 'high',
      tags: ['next-step'],
    },
    {
      id: 'candidate-durable-1',
      sessionId,
      observedAt: '2026-04-15T00:00:11.000Z',
      kind: 'candidate-durable',
      summary: 'Checkpoint markdown should stay parseable after compaction',
      evidence: ['checkpoint parser'],
      priority: 'high',
      tags: ['title:Checkpoint markdown remains parseable', 'kind:constraint', 'workflow'],
    },
    {
      id: 'candidate-skill-1',
      sessionId,
      observedAt: '2026-04-15T00:00:12.000Z',
      kind: 'candidate-skill',
      summary: 'Checkpoint reflection from observation logs',
      evidence: ['read observations', 'build checkpoint', 'write markdown'],
      priority: 'high',
      tags: [
        'name:reflection-checkpoints',
        'trigger:when observation logs need compaction-safe state',
      ],
    },
  ]
}

describe('Reflection checkpoints', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('builds, renders, and parses a checkpoint in stable section order', () => {
    const sessionId = 'session-reflect-1'
    const checkpointResult = buildCheckpointFromObservations(
      makeCheckpointObservations(sessionId),
      {
        updatedAt: '2026-04-15T00:30:00.000Z',
      },
    )

    expect(checkpointResult.ok).toBe(true)
    if (!checkpointResult.ok) return

    const checkpoint = checkpointResult.value
    expect(checkpoint.goal).toBe('Ship reflection checkpoints for RSI memory')
    expect(checkpoint.currentPlan).toEqual(['Add round-trip parsing coverage'])
    expect(checkpoint.constraints).toEqual([
      'Keep checkpoints independent from prompt loading and compaction',
    ])
    expect(checkpoint.decisionsMade).toEqual(['Render candidates in fenced YAML blocks'])
    expect(checkpoint.filesInPlay).toEqual(['packages/cli/src/memory/checkpoints.ts'])
    expect(checkpoint.completedWork).toEqual(['Built deterministic checkpoint renderer'])
    expect(checkpoint.openLoops).toEqual(['Wire checkpoint reflection into the orchestrator'])
    expect(checkpoint.nextBestStep).toBe('Run memory checkpoint unit tests')
    expect(checkpoint.durableMemoryCandidates).toHaveLength(1)
    expect(checkpoint.skillCandidates).toHaveLength(1)

    const markdownResult = renderCheckpointMarkdown(checkpoint)
    expect(markdownResult.ok).toBe(true)
    if (!markdownResult.ok) return

    let previousIndex = -1
    for (const title of CHECKPOINT_SECTION_ORDER) {
      const currentIndex = markdownResult.value.indexOf(`## ${title}`)
      expect(currentIndex).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }

    const parsedResult = parseCheckpointMarkdown(markdownResult.value)
    expect(parsedResult.ok).toBe(true)
    if (!parsedResult.ok) return

    expect(parsedResult.value).toEqual(checkpoint)
  })

  test('resolved open loops and superseded decisions disappear from active checkpoint state', () => {
    const sessionId = 'session-reflect-2'
    const observations: ObservationRecord[] = [
      {
        id: 'loop-1',
        sessionId,
        observedAt: '2026-04-15T00:00:01.000Z',
        kind: 'open-loop',
        summary: 'Decide how to render checkpoint candidates',
        evidence: ['ticket-03'],
        priority: 'high',
        tags: ['checkpoint'],
      },
      {
        id: 'decision-1',
        sessionId,
        observedAt: '2026-04-15T00:00:02.000Z',
        kind: 'decision',
        summary: 'Use fenced YAML blocks for candidate sections',
        evidence: ['design update'],
        priority: 'high',
        tags: ['checkpoint'],
        supersedes: ['loop-1'],
      },
      {
        id: 'decision-2',
        sessionId,
        observedAt: '2026-04-15T00:00:03.000Z',
        kind: 'decision',
        summary: 'Use fenced YAML blocks plus YAML frontmatter',
        evidence: ['design update'],
        priority: 'critical',
        tags: ['checkpoint'],
        supersedes: ['decision-1'],
      },
      {
        id: 'progress-1',
        sessionId,
        observedAt: '2026-04-15T00:00:04.000Z',
        kind: 'progress',
        summary: 'Checkpoint rendering logic implemented',
        evidence: ['checkpoints.ts'],
        priority: 'normal',
        tags: ['completed'],
      },
    ]

    const checkpointResult = buildCheckpointFromObservations(observations, {
      updatedAt: '2026-04-15T00:45:00.000Z',
    })

    expect(checkpointResult.ok).toBe(true)
    if (!checkpointResult.ok) return

    expect(checkpointResult.value.openLoops).toEqual([])
    expect(checkpointResult.value.decisionsMade).toEqual([
      'Use fenced YAML blocks plus YAML frontmatter',
    ])
    expect(checkpointResult.value.completedWork).toEqual(['Checkpoint rendering logic implemented'])
  })

  test('reflection can build a checkpoint from stored observations and write it to disk', () => {
    const sessionId = 'session-reflect-3'
    const appendResult = appendObservationBatch(
      sessionId,
      makeCheckpointObservations(sessionId).map(({ sessionId: _sessionId, ...input }) => input),
      tempDir,
    )
    expect(appendResult.ok).toBe(true)
    if (!appendResult.ok) return

    const reflectionResult = reflectCheckpoint(sessionId, {
      updatedAt: '2026-04-15T01:00:00.000Z',
      basePath: tempDir,
    })
    expect(reflectionResult.ok).toBe(true)
    if (!reflectionResult.ok) return

    const checkpointPath = resolveCheckpointPath(sessionId, tempDir)
    expect(existsSync(checkpointPath)).toBe(true)

    const parsedResult = parseCheckpointMarkdown(readFileSync(checkpointPath, 'utf-8'))
    expect(parsedResult.ok).toBe(true)
    if (!parsedResult.ok) return

    expect(parsedResult.value).toEqual(reflectionResult.value)
  })
})
