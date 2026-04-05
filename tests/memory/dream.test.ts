import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ok, err } from '@src/types'
import { writeTopic, readTopic } from '@src/memory/topics'
import { getMemoryIndex } from '@src/memory/index'
import {
  dream,
  analyzeTranscripts,
  loadProposals,
  storeProposals,
  type DreamDeps,
  type LLMGenerateFn,
  type SkillProposal,
  type StoredSkillProposal,
} from '@src/memory/dream'
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
    getRecentSessions: (limit: number) => {
      const result = sessions.slice(0, limit).map((s) => ({ id: s.id }))
      return ok(result)
    },
    getSession: (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return err(new Error(`Session "${sessionId}" not found`))
      return ok(session)
    },
    basePath,
  }
}

describe('Dream Cycle — Between-Session Memory Consolidation', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
    setupMemoryDir(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Test: No sessions to analyze ────────────────────────────────

  test('returns ok with zero counts when no sessions exist', async () => {
    const mockGenerate: LLMGenerateFn = async () => ok('{}')
    const deps = makeMockDeps([], mockGenerate, tempDir)

    const result = await dream(deps, { mode: 'full' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.sessionsAnalyzed).toBe(0)
    expect(result.value.topicsMerged).toBe(0)
    expect(result.value.topicsCreated).toBe(0)
    expect(result.value.topicsPruned).toBe(0)
    expect(result.value.contradictionsResolved).toBe(0)
    expect(result.value.skillProposals).toEqual([])
    expect(result.value.memoryIndexUpdated).toBe(false)
  })

  // ── Test: Consolidation merges redundant topics ─────────────────

  test('consolidation merges redundant topics', async () => {
    // Setup: two overlapping topics
    writeTopic('typescript-patterns', '# TypeScript Patterns\n\nUse strict mode.', tempDir)
    writeTopic('ts-coding-patterns', '# TS Coding Patterns\n\nAlways use strict mode.', tempDir)

    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Help me with TypeScript patterns' },
        { role: 'assistant', content: 'I used strict mode patterns' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        // Session analysis
        return ok(
          JSON.stringify({
            summary: 'TypeScript patterns session',
            tasksAttempted: ['TypeScript patterns'],
            toolsUsed: [],
            outcomes: [{ task: 'TypeScript patterns', success: true }],
            patterns: ['strict mode usage'],
          }),
        )
      }
      if (callIndex === 2) {
        // Cross-session patterns
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['TypeScript strict mode'],
            repeatedSequences: [],
            struggles: [],
          }),
        )
      }
      // Consolidation prompt
      return ok(
        JSON.stringify({
          merges: [
            {
              source: ['typescript-patterns', 'ts-coding-patterns'],
              target: 'typescript-patterns',
              mergedContent:
                '# TypeScript Patterns\n\nAlways use strict mode. Comprehensive guide.',
            },
          ],
          contradictions: [],
          newTopics: [],
          prunedTopics: [],
          updatedIndex: '# Memory Index\n\n- typescript-patterns: Merged TypeScript patterns',
        }),
      )
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.topicsMerged).toBe(2)

    // Verify the merged topic exists with merged content
    const mergedTopic = readTopic('typescript-patterns', tempDir)
    expect(mergedTopic.ok).toBe(true)
    if (mergedTopic.ok) {
      expect(mergedTopic.value).toContain('Comprehensive guide')
    }

    // Verify the source topic was deleted
    const deletedTopic = readTopic('ts-coding-patterns', tempDir)
    expect(deletedTopic.ok).toBe(false)

    // Verify MEMORY.md was updated
    const memResult = getMemoryIndex(tempDir)
    expect(memResult.ok).toBe(true)
    if (memResult.ok) {
      expect(memResult.value).toContain('typescript-patterns')
    }
  })

  // ── Test: Contradiction resolution favors recent ────────────────

  test('contradiction resolution favors recent information', async () => {
    writeTopic(
      'api-approach',
      '# API Approach\n\nUse REST for all API calls. REST is preferred.',
      tempDir,
    )

    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Switch to GraphQL for the API' },
        {
          role: 'assistant',
          content: 'Switched the API to GraphQL. It works better for our needs.',
        },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        return ok(
          JSON.stringify({
            summary: 'Switched API approach from REST to GraphQL',
            tasksAttempted: ['Switch to GraphQL'],
            toolsUsed: [],
            outcomes: [{ task: 'Switch to GraphQL', success: true }],
            patterns: ['GraphQL adoption'],
          }),
        )
      }
      if (callIndex === 2) {
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['GraphQL preference'],
            repeatedSequences: [],
            struggles: [],
          }),
        )
      }
      return ok(
        JSON.stringify({
          merges: [],
          contradictions: [
            {
              topicName: 'api-approach',
              issue: 'Topic says REST but recent sessions show GraphQL preference',
              resolution: 'Updated to reflect GraphQL preference per recent sessions',
              updatedContent:
                '# API Approach\n\nUse GraphQL for API calls. GraphQL is preferred based on recent experience.',
            },
          ],
          newTopics: [],
          prunedTopics: [],
          updatedIndex: '# Memory Index\n\n- api-approach: Updated to GraphQL preference',
        }),
      )
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.contradictionsResolved).toBe(1)

    const topicResult = readTopic('api-approach', tempDir)
    expect(topicResult.ok).toBe(true)
    if (topicResult.ok) {
      expect(topicResult.value).toContain('GraphQL')
    }
  })

  // ── Test: Skill proposal generation ─────────────────────────────

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
        // Session analyses
        return ok(
          JSON.stringify({
            summary: `Refactored a module following common pattern`,
            tasksAttempted: ['Module refactoring'],
            toolsUsed: ['file-read', 'file-write'],
            outcomes: [{ task: 'Module refactoring', success: true }],
            patterns: ['multi-step file refactoring'],
          }),
        )
      }
      if (callIndex === 4) {
        // Cross-session patterns
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['Repeated multi-step module refactoring pattern'],
            repeatedSequences: ['Read file, analyze structure, write refactored version'],
            struggles: [],
          }),
        )
      }
      // Skill proposals
      return ok(
        JSON.stringify([
          {
            proposedName: 'module-refactor',
            description: 'Automate common module refactoring patterns',
            rationale:
              'Sessions sess-1, sess-2, sess-3 all performed similar multi-step refactoring',
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

    expect(result.value.skillProposals.length).toBeGreaterThanOrEqual(1)
    expect(result.value.skillProposals[0].proposedName).toBe('module-refactor')

    // Verify proposals were written to file
    const proposalsPath = join(tempDir, 'memory', 'skill-proposals.json')
    expect(existsSync(proposalsPath)).toBe(true)

    const stored = JSON.parse(readFileSync(proposalsPath, 'utf-8')) as StoredSkillProposal[]
    expect(stored.length).toBeGreaterThanOrEqual(1)
    expect(stored[0].status).toBe('pending')
    expect(stored[0].timestamp).toBeTruthy()
  })

  // ── Test: Proposal file is append-only ──────────────────────────

  test('proposal file appends new proposals without overwriting existing', async () => {
    const proposalsPath = join(tempDir, 'memory', 'skill-proposals.json')

    // Seed with 2 existing proposals
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

    // Store one new proposal
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

    // Verify: file has 3 proposals total
    const stored = JSON.parse(readFileSync(proposalsPath, 'utf-8')) as StoredSkillProposal[]
    expect(stored.length).toBe(3)

    // Original 2 unchanged
    expect(stored[0].proposedName).toBe('existing-skill-1')
    expect(stored[0].status).toBe('pending')
    expect(stored[1].proposedName).toBe('existing-skill-2')
    expect(stored[1].status).toBe('accepted')

    // New proposal appended
    expect(stored[2].proposedName).toBe('new-skill')
    expect(stored[2].status).toBe('pending')
    expect(stored[2].timestamp).toBeTruthy()
  })

  // ── Test: Mode filtering works ──────────────────────────────────

  test('consolidate-only mode does not generate skill proposals', async () => {
    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'Done' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        return ok(
          JSON.stringify({
            summary: 'Simple task',
            tasksAttempted: ['Something'],
            toolsUsed: [],
            outcomes: [{ task: 'Something', success: true }],
            patterns: [],
          }),
        )
      }
      if (callIndex === 2) {
        return ok(
          JSON.stringify({
            crossSessionPatterns: [],
            repeatedSequences: [],
            struggles: [],
          }),
        )
      }
      // Consolidation
      return ok(
        JSON.stringify({
          merges: [],
          contradictions: [],
          newTopics: [],
          prunedTopics: [],
          updatedIndex: '# Memory Index\n\nUpdated.',
        }),
      )
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'consolidate-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.skillProposals).toEqual([])
    expect(result.value.sessionsAnalyzed).toBe(1)
  })

  test('propose-only mode does not consolidate memory', async () => {
    // Write a topic that should NOT be touched
    writeTopic('untouched-topic', 'Original content', tempDir)

    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: 'Done' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        return ok(
          JSON.stringify({
            summary: 'Simple task',
            tasksAttempted: ['Something'],
            toolsUsed: [],
            outcomes: [{ task: 'Something', success: true }],
            patterns: ['pattern-a'],
          }),
        )
      }
      if (callIndex === 2) {
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['pattern-a'],
            repeatedSequences: [],
            struggles: [],
          }),
        )
      }
      // Proposal generation
      return ok(JSON.stringify([]))
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'propose-only' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Memory consolidation should not have run
    expect(result.value.topicsMerged).toBe(0)
    expect(result.value.topicsCreated).toBe(0)
    expect(result.value.contradictionsResolved).toBe(0)
    expect(result.value.memoryIndexUpdated).toBe(false)

    // Topic should be untouched
    const topicResult = readTopic('untouched-topic', tempDir)
    expect(topicResult.ok).toBe(true)
    if (topicResult.ok) {
      expect(topicResult.value).toBe('Original content')
    }
  })

  // ── Test: analyzeTranscripts with LLM failure ───────────────────

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
        // Fail the session analysis
        return err(new Error('LLM temporarily unavailable'))
      }
      // Cross-ref still works
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

    // Should have a fallback insight
    expect(result.value.sessions.length).toBe(1)
    expect(result.value.sessions[0].summary).toBe('Failed to analyze session')
    expect(result.value.sessions[0].toolsUsed).toContain('file-read')
  })

  // ── Test: loadProposals from non-existent file ──────────────────

  test('loadProposals returns empty array when file does not exist', () => {
    const result = loadProposals(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  // ── Test: dream returns Result — never throws ───────────────────

  test('dream never throws, returns Result.err on unexpected errors', async () => {
    const mockGenerate: LLMGenerateFn = async () => ok('{}')
    const deps: DreamDeps = {
      generateFn: mockGenerate,
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

  // ── Test: full mode runs both consolidation and proposals ───────

  test('full mode runs consolidation and proposal generation', async () => {
    writeTopic('test-topic', '# Test\n\nSome content.', tempDir)

    const sessions = [
      makeSession('sess-1', [
        { role: 'user', content: 'Work on feature' },
        { role: 'assistant', content: 'Done with feature' },
      ]),
    ]

    let callIndex = 0
    const mockGenerate: LLMGenerateFn = async () => {
      callIndex++
      if (callIndex === 1) {
        return ok(
          JSON.stringify({
            summary: 'Feature work',
            tasksAttempted: ['Feature implementation'],
            toolsUsed: ['file-write'],
            outcomes: [{ task: 'Feature implementation', success: true }],
            patterns: ['feature development'],
          }),
        )
      }
      if (callIndex === 2) {
        return ok(
          JSON.stringify({
            crossSessionPatterns: ['feature development'],
            repeatedSequences: [],
            struggles: [],
          }),
        )
      }
      if (callIndex === 3) {
        // Consolidation
        return ok(
          JSON.stringify({
            merges: [],
            contradictions: [],
            newTopics: [
              {
                name: 'feature-dev-notes',
                content: '# Feature Dev Notes\n\nNotes from recent sessions.',
              },
            ],
            prunedTopics: [],
            updatedIndex: '# Memory Index\n\n- test-topic\n- feature-dev-notes',
          }),
        )
      }
      // Proposals
      return ok(
        JSON.stringify([
          {
            proposedName: 'auto-feature',
            description: 'Automate feature scaffolding',
            rationale: 'Repeated pattern',
            estimatedImpact: 'medium',
            sourceSessions: ['sess-1'],
          },
        ]),
      )
    }

    const deps = makeMockDeps(sessions, mockGenerate, tempDir)
    const result = await dream(deps, { mode: 'full' })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.sessionsAnalyzed).toBe(1)
    expect(result.value.topicsCreated).toBe(1)
    expect(result.value.memoryIndexUpdated).toBe(true)
    expect(result.value.skillProposals.length).toBe(1)
    expect(result.value.skillProposals[0].proposedName).toBe('auto-feature')
  })
})
