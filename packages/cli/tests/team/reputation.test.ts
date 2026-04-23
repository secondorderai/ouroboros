import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'
import {
  buildReputationSnapshot,
  extractWorkflowRSICandidates,
  readAgentOutcomes,
  readReputationSnapshot,
  recordAgentOutcome,
  type AgentOutcomeRecord,
} from '@src/team/reputation'

describe('team agent outcome reputation', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('team-reputation')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
  })

  test('persists agent outcomes and updates accepted finding reputation', () => {
    const before = buildReputationSnapshot([])
    expect(before.summaries).toEqual([])

    const result = recordAgentOutcome(
      {
        projectId: 'ouroboros',
        role: 'review',
        agentId: 'reviewer-1',
        metrics: {
          completedTasks: 1,
          acceptedFindings: 1,
        },
        recordedAt: '2026-04-20T00:00:00.000Z',
      },
      tempDir,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error

    expect(existsSync(join(tempDir, 'memory', 'team', 'agent-outcomes.jsonl'))).toBe(true)
    expect(existsSync(join(tempDir, 'memory', 'team', 'reputation-summary.json'))).toBe(true)

    const outcomes = readAgentOutcomes(tempDir)
    expect(outcomes.ok).toBe(true)
    if (!outcomes.ok) throw outcomes.error
    expect(outcomes.value).toHaveLength(1)
    expect(outcomes.value[0]).toMatchObject({
      projectId: 'ouroboros',
      role: 'review',
      categories: ['task', 'finding'],
      metrics: {
        acceptedFindings: 1,
        rejectedFindings: 0,
      },
    })

    const reputation = readReputationSnapshot(tempDir)
    expect(reputation.ok).toBe(true)
    if (!reputation.ok) throw reputation.error

    const reviewSummary = reputation.value.summaries.find(
      (summary) => summary.projectId === 'ouroboros' && summary.role === 'review',
    )
    expect(reviewSummary).toBeDefined()
    expect(reviewSummary?.scores.finding).toBeGreaterThan(0)
    expect(reviewSummary?.scores.finding).toBe(1)
  })

  test('rejected findings reduce reputation for that category', () => {
    const accepted = recordAgentOutcome(
      {
        projectId: 'ouroboros',
        role: 'review',
        metrics: { acceptedFindings: 1 },
      },
      tempDir,
    )
    expect(accepted.ok).toBe(true)

    const rejected = recordAgentOutcome(
      {
        projectId: 'ouroboros',
        role: 'review',
        metrics: { rejectedFindings: 1 },
      },
      tempDir,
    )
    expect(rejected.ok).toBe(true)
    if (!rejected.ok) throw rejected.error

    const summary = rejected.value.reputation.summaries[0]
    expect(summary.metrics.acceptedFindings).toBe(1)
    expect(summary.metrics.rejectedFindings).toBe(1)
    expect(summary.scores.finding).toBe(0.5)
  })
})

describe('workflow outcome RSI candidates', () => {
  test('repeated successful workflow creates memory and skill candidates', () => {
    const outcomes: AgentOutcomeRecord[] = [
      {
        id: 'outcome-1',
        projectId: 'ouroboros',
        role: 'worker',
        runId: 'run-a',
        recordedAt: '2026-04-20T00:00:00.000Z',
        categories: ['task', 'test'],
        workflowPattern: 'review test pair',
        workflowSteps: ['Review the patch', 'Run focused tests', 'Summarize risks'],
        metrics: {
          completedTasks: 1,
          failedTasks: 0,
          acceptedFindings: 1,
          rejectedFindings: 0,
          acceptedPatches: 0,
          rejectedPatches: 0,
          testsPassed: 1,
          testsFailed: 0,
          userOverrides: 0,
        },
      },
      {
        id: 'outcome-2',
        projectId: 'ouroboros',
        role: 'worker',
        runId: 'run-b',
        recordedAt: '2026-04-21T00:00:00.000Z',
        categories: ['task', 'test'],
        workflowPattern: 'review test pair',
        workflowSteps: ['Review the patch', 'Run focused tests', 'Summarize risks'],
        metrics: {
          completedTasks: 1,
          failedTasks: 0,
          acceptedFindings: 0,
          rejectedFindings: 0,
          acceptedPatches: 1,
          rejectedPatches: 0,
          testsPassed: 1,
          testsFailed: 0,
          userOverrides: 0,
        },
      },
      {
        id: 'outcome-failed',
        projectId: 'ouroboros',
        role: 'worker',
        runId: 'run-c',
        recordedAt: '2026-04-22T00:00:00.000Z',
        categories: ['task', 'test'],
        workflowPattern: 'review test pair',
        workflowSteps: ['Review the patch', 'Run focused tests', 'Summarize risks'],
        metrics: {
          completedTasks: 0,
          failedTasks: 1,
          acceptedFindings: 0,
          rejectedFindings: 0,
          acceptedPatches: 0,
          rejectedPatches: 0,
          testsPassed: 0,
          testsFailed: 1,
          userOverrides: 0,
        },
      },
    ]

    const result = extractWorkflowRSICandidates(outcomes, {
      observedAt: '2026-04-22T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error

    expect(result.value.durableMemoryCandidates).toHaveLength(1)
    expect(result.value.skillCandidates).toHaveLength(1)
    expect(result.value.skillCandidates[0]).toMatchObject({
      name: 'review-test-pair-workflow',
      sourceObservationIds: ['outcome-1', 'outcome-2'],
      sourceSessionIds: ['run-a', 'run-b'],
    })
    expect(result.value.durableMemoryCandidates[0]).toMatchObject({
      kind: 'workflow',
      evidence: ['outcome-1', 'outcome-2'],
    })
    expect(result.value.sourceOutcomeIds).toEqual(['outcome-1', 'outcome-2'])
  })
})
