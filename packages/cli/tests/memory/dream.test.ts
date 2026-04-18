import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getMemoryIndex } from '@src/memory/index'
import { appendObservationBatch } from '@src/memory/observations'
import { resolveDailyMemoryPath } from '@src/memory/paths'
import { writeCheckpoint } from '@src/memory/checkpoints'
import { ok, err } from '@src/types'
import {
  analyzeTranscripts,
  dream,
  loadProposals,
  storeProposals,
  type DreamDeps,
  type LLMGenerateFn,
  type SkillProposal,
  type StoredSkillProposal,
} from '@src/memory/dream'
import type { ReflectionCheckpoint } from '@src/rsi/types'
import type { SessionWithMessages } from '@src/memory/transcripts'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-dream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function setupMemoryDir(basePath: string): void {
  mkdirSync(join(basePath, 'memory', 'topics'), { recursive: true })
  mkdirSync(join(basePath, 'memory', 'daily'), { recursive: true })
  writeFileSync(join(basePath, 'memory', 'MEMORY.md'), '# Memory Index\n', 'utf-8')
}

function makeSession(
  id: string,
  messages: Array<{ role: string; content: string; toolName?: string }>,
): SessionWithMessages {
  return {
    id,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    summary: null,
    workspacePath: null,
    messages: messages.map((m, i) => ({
      id: `msg-${id}-${i}`,
      sessionId: id,
      role: m.role as 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'system',
      content: m.content,
      toolName: m.toolName ?? null,
      toolArgs: null,
      createdAt: new Date().toISOString(),
    })),
  }
}

function makeMockDeps(
  sessions: SessionWithMessages[],
  generateFn: LLMGenerateFn,
  basePath: string,
): DreamDeps {
  return {
    generateFn,
    getRecentSessions: (limit: number) => ok(sessions.slice(0, limit).map((s) => ({ id: s.id }))),
    getSession: (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (!session) return err(new Error(`Session "${sessionId}" not found`))
      return ok(session)
    },
    basePath,
  }
}

function writeReflectionCheckpoint(
  checkpoint: Partial<ReflectionCheckpoint> & Pick<ReflectionCheckpoint, 'sessionId' | 'updatedAt'>,
  basePath: string,
): void {
  const result = writeCheckpoint(
    {
      goal: '',
      currentPlan: [],
      constraints: [],
      decisionsMade: [],
      filesInPlay: [],
      completedWork: [],
      openLoops: [],
      nextBestStep: '',
      durableMemoryCandidates: [],
      skillCandidates: [],
      ...checkpoint,
    },
    basePath,
  )
  expect(result.ok).toBe(true)
}

describe('Dream Cycle — Structured Memory Consolidation', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
    setupMemoryDir(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('returns ok with zero counts when no sessions or structured memory exist', async () => {
    const deps = makeMockDeps([], async () => ok('{}'), tempDir)

    const result = await dream(deps, { mode: 'full' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.sessionsAnalyzed).toBe(0)
    expect(result.value.durablePromotions).toEqual([])
    expect(result.value.dailyMemoryFilesUpdated).toEqual([])
  })

  test('promotes durable facts from structured memory even when transcript data is sparse', async () => {
    const observationResult = appendObservationBatch(
      'sess-1',
      [
        {
          kind: 'candidate-durable',
          summary: 'API approach settled on GraphQL',
          evidence: ['packages/cli/src/api/client.ts'],
          priority: 'high',
          tags: ['title:API approach', 'content:Use GraphQL for internal APIs', 'kind:fact'],
        },
      ],
      tempDir,
    )
    expect(observationResult.ok).toBe(true)

    writeReflectionCheckpoint(
      {
        sessionId: 'sess-2',
        updatedAt: '2026-04-15T11:00:00.000Z',
        durableMemoryCandidates: [
          {
            title: 'API approach',
            summary: 'Use GraphQL for internal APIs',
            content: 'Use GraphQL for internal APIs',
            kind: 'fact',
            confidence: 0.95,
            observedAt: '2026-04-15T11:00:00.000Z',
            tags: ['source:checkpoint'],
            evidence: ['memory/checkpoints/sess-2.md'],
          },
        ],
      },
      tempDir,
    )

    const deps = makeMockDeps([], async () => ok('{}'), tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.topicsCreated).toBe(1)
    expect(result.value.durablePromotions).toContain('API approach (fact)')

    const memoryResult = getMemoryIndex(tempDir)
    expect(memoryResult.ok).toBe(true)
    if (!memoryResult.ok) return
    expect(memoryResult.value).toContain('## Durable Memory')
    expect(memoryResult.value).toContain('API approach :: Use GraphQL for internal APIs')
  })

  test('keeps transient checkpoint and working-state content out of durable memory', async () => {
    const observationResult = appendObservationBatch(
      'sess-1',
      [
        {
          kind: 'candidate-durable',
          summary: 'Currently investigating flaky checkpoint parsing',
          evidence: ['packages/cli/src/memory/checkpoints.ts'],
          priority: 'critical',
          tags: [
            'title:Checkpoint investigation',
            'content:Currently investigating flaky checkpoint parsing',
            'transient',
            'daily-only',
          ],
        },
      ],
      tempDir,
    )
    expect(observationResult.ok).toBe(true)

    const deps = makeMockDeps([], async () => ok('{}'), tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.durablePromotions).toEqual([])
    const memoryResult = getMemoryIndex(tempDir)
    expect(memoryResult.ok).toBe(true)
    if (!memoryResult.ok) return
    expect(memoryResult.value).not.toContain('Checkpoint investigation')
  })

  test('prunes contradicted durable entries and records contradiction resolution', async () => {
    writeFileSync(
      join(tempDir, 'memory', 'MEMORY.md'),
      [
        '# Memory Index',
        '',
        '<!-- dream:durable:start -->',
        '## Durable Memory',
        '### Facts',
        '- API approach :: Use REST for internal APIs',
        '<!-- dream:durable:end -->',
      ].join('\n'),
      'utf-8',
    )

    const observationResult = appendObservationBatch(
      'sess-1',
      [
        {
          kind: 'candidate-durable',
          summary: 'API approach settled on GraphQL',
          evidence: ['recent design review'],
          priority: 'critical',
          tags: ['title:API approach', 'content:Use GraphQL for internal APIs', 'kind:fact'],
        },
      ],
      tempDir,
    )
    expect(observationResult.ok).toBe(true)

    const deps = makeMockDeps([], async () => ok('{}'), tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.durablePrunes).toContain('API approach (fact)')
    expect(
      result.value.contradictionsResolvedEntries.some((entry) => entry.includes('API approach')),
    ).toBe(true)

    const memory = readFileSync(join(tempDir, 'memory', 'MEMORY.md'), 'utf-8')
    expect(memory).toContain('API approach :: Use GraphQL for internal APIs')
    const durableBlock = memory.slice(
      memory.indexOf('<!-- dream:durable:start -->'),
      memory.indexOf('<!-- dream:durable:end -->'),
    )
    expect(durableBlock).not.toContain('Use REST for internal APIs')
  })

  test('updates daily rollups to carry forward unresolved work and mark resolved items', async () => {
    writeFileSync(
      resolveDailyMemoryPath('2026-04-15', tempDir),
      ['# 2026-04-15', '', '- Investigated memory compaction edge cases'].join('\n'),
      'utf-8',
    )

    const observationResult = appendObservationBatch(
      'sess-1',
      [
        {
          observedAt: '2026-04-15T09:00:00.000Z',
          kind: 'open-loop',
          summary: 'Wire checkpoint resume into the agent loop',
          evidence: ['packages/cli/src/agent.ts'],
          priority: 'high',
          tags: [],
        },
        {
          observedAt: '2026-04-15T09:30:00.000Z',
          kind: 'open-loop',
          summary: 'Retire the transcript-only dream prompt',
          evidence: ['packages/cli/src/memory/dream.ts'],
          priority: 'normal',
          tags: [],
        },
      ],
      tempDir,
    )
    expect(observationResult.ok).toBe(true)

    writeReflectionCheckpoint(
      {
        sessionId: 'sess-1',
        updatedAt: '2026-04-15T10:00:00.000Z',
        openLoops: ['Wire checkpoint resume into the agent loop'],
      },
      tempDir,
    )

    const deps = makeMockDeps([], async () => ok('{}'), tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.dailyMemoryFilesUpdated).toHaveLength(1)
    const dailyContent = readFileSync(resolveDailyMemoryPath('2026-04-15', tempDir), 'utf-8')
    expect(dailyContent).toContain('### Carry Forward')
    expect(dailyContent).toContain('Wire checkpoint resume into the agent loop')
    expect(dailyContent).toContain('### Resolved')
    expect(dailyContent).toContain('Retire the transcript-only dream prompt')
  })

  test('generates skill proposals based on cross-session patterns', async () => {
    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Refactor the auth module' },
        { role: 'assistant', content: 'Refactored auth module following the pattern' },
      ]),
      makeSession('sess-2', [
        { role: 'user', content: 'Refactor the payment module' },
        { role: 'assistant', content: 'Refactored payment module following the pattern' },
      ]),
      makeSession('sess-3', [
        { role: 'user', content: 'Refactor the user module' },
        { role: 'assistant', content: 'Refactored user module following the pattern' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex <= 3) {
        return ok(
          JSON.stringify({
            summary: 'Refactored a module following a common pattern',
            tasksAttempted: ['Module refactoring'],
            toolsUsed: ['file-read', 'file-write'],
            outcomes: [{ task: 'Module refactoring', success: true }],
            patterns: ['multi-step file refactoring'],
          }),
        )
      }
      if (callIndex === 4) {
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['Repeated multi-step module refactoring pattern'],
            repeatedSequences: ['Read file, analyze structure, write refactored version'],
            struggles: [],
          }),
        )
      }
      return ok(
        JSON.stringify([
          {
            proposedName: 'module-refactor',
            description: 'Automate common module refactoring patterns',
            rationale: 'Sessions sess-1, sess-2, sess-3 followed the same refactoring arc',
            estimatedImpact: 'high',
            sourceSessions: ['sess-1', 'sess-2', 'sess-3'],
          },
        ]),
      )
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'propose-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.skillProposals[0]?.proposedName).toBe('module-refactor')
    expect(existsSync(join(tempDir, 'memory', 'skill-proposals.json'))).toBe(true)
  })

  test('proposal file appends new proposals without overwriting existing', () => {
    const proposalsPath = join(tempDir, 'memory', 'skill-proposals.json')
    const existing: StoredSkillProposal[] = [
      {
        proposedName: 'existing-skill-1',
        description: 'First existing skill',
        rationale: 'Historical reason',
        estimatedImpact: 'medium',
        sourceSessions: ['old-1'],
        timestamp: '2025-01-01T00:00:00.000Z',
        status: 'pending',
      },
      {
        proposedName: 'existing-skill-2',
        description: 'Second existing skill',
        rationale: 'Historical reason',
        estimatedImpact: 'low',
        sourceSessions: ['old-2'],
        timestamp: '2025-01-02T00:00:00.000Z',
        status: 'accepted',
      },
    ]
    writeFileSync(proposalsPath, JSON.stringify(existing, null, 2), 'utf-8')

    const newProposals: SkillProposal[] = [
      {
        proposedName: 'new-skill',
        description: 'A new proposed skill',
        rationale: 'Pattern observed',
        estimatedImpact: 'high',
        sourceSessions: ['sess-1', 'sess-2'],
      },
    ]

    const result = storeProposals(newProposals, tempDir)
    expect(result.ok).toBe(true)

    const stored = JSON.parse(readFileSync(proposalsPath, 'utf-8')) as StoredSkillProposal[]
    expect(stored).toHaveLength(3)
    expect(stored[2].proposedName).toBe('new-skill')
  })

  test('loadProposals returns empty array when file does not exist', () => {
    const result = loadProposals(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  test('analyzeTranscripts handles LLM failure gracefully per session', async () => {
    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Test message' },
        { role: 'assistant', content: 'Response', toolName: 'file-read' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        return err(new Error('LLM temporarily unavailable'))
      }
      return ok(
        JSON.stringify({
          crossSessionPatterns: [],
          repeatedSequences: [],
          struggles: [],
        }),
      )
    }

    const result = await analyzeTranscripts(mockGenerate, sessions)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.sessions[0].summary).toBe('Failed to analyze session')
    expect(result.value.sessions[0].toolsUsed).toContain('file-read')
  })

  test('dream never throws, returns Result.err on unexpected errors', async () => {
    const deps: DreamDeps = {
      generateFn: async () => ok('{}'),
      getRecentSessions: () => {
        throw new Error('Database connection failed')
      },
      getSession: () => err(new Error('unreachable')),
      basePath: tempDir,
    }

    const result = await dream(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Dream cycle failed')
  })
})
