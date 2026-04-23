import { describe, expect, test } from 'bun:test'
import { TaskGraphStore } from '@src/team/task-graph'
import {
  createBlindRedTeamContext,
  createDebateRecordFromVerdict,
  createWorkflowTemplate,
  validateDebateRecord,
  type DebateRecord,
} from '@src/team/workflow-templates'
import { synthesizeAgentVerdict } from '@src/tools/subagent-synthesis'
import type { SubAgentResult } from '@src/tools/subagent-result'

function result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    summary: 'Subagent summary.',
    claims: [],
    uncertainty: [],
    suggestedNextSteps: [],
    ...overrides,
  }
}

describe('workflow templates', () => {
  test('parallel-investigation creates explorer tasks and synthesis task', () => {
    const template = createWorkflowTemplate({
      template: 'parallel-investigation',
      taskContext: 'Investigate the task graph runtime.',
    })
    expect(template.ok).toBe(true)
    if (!template.ok) throw template.error

    const store = new TaskGraphStore()
    const graph = store.createGraph(template.value)
    expect(graph.ok).toBe(true)
    if (!graph.ok) throw graph.error

    const taskIds = graph.value.tasks.map((task) => task.id)
    expect(taskIds).toEqual([
      'explorer-primary',
      'explorer-alternative',
      'explorer-risk',
      'synthesis',
    ])
    expect(graph.value.tasks.filter((task) => task.id.startsWith('explorer-'))).toHaveLength(3)
    expect(graph.value.tasks.find((task) => task.id === 'synthesis')).toMatchObject({
      status: 'blocked',
      dependencies: ['explorer-primary', 'explorer-alternative', 'explorer-risk'],
    })
  })

  test('every built-in workflow creates a deterministic task graph template', () => {
    const templates = [
      'parallel-investigation',
      'pre-merge-red-team',
      'architecture-decision',
      'review-triad',
    ] as const

    for (const templateName of templates) {
      const first = createWorkflowTemplate({
        template: templateName,
        taskContext: 'Implement Ticket 18.',
      })
      const second = createWorkflowTemplate({
        template: templateName,
        taskContext: 'Implement Ticket 18.',
      })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok) throw first.error
      if (!second.ok) throw second.error
      expect(first.value).toEqual(second.value)
      expect(first.value.tasks?.length).toBeGreaterThan(0)
    }
  })

  test('blind red-team context excludes worker rationale', () => {
    const context = createBlindRedTeamContext('Fix the CLI regression.', {
      taskId: 'ticket-18',
      branchName: 'worker/ticket-18',
      worktreePath: '/tmp/worker-ticket-18',
      changedFiles: ['packages/cli/src/team/workflow-templates.ts'],
      diff: 'diff --git a/file b/file\n+new line',
      unresolvedRisks: [],
      reviewStatus: 'awaiting-review',
      rationale: 'I chose this design because of private chain-of-thought.',
      reasoning: 'Hidden worker reasoning.',
    })

    expect(context.taskContext).toBe('Fix the CLI regression.')
    expect(context.workerDiff.diff).toContain('+new line')
    expect(JSON.stringify(context)).not.toContain('rationale')
    expect(JSON.stringify(context)).not.toContain('private chain-of-thought')
    expect(JSON.stringify(context)).not.toContain('Hidden worker reasoning')
  })

  test('debate record requires an evidence-backed verdict claim', () => {
    const verdict = synthesizeAgentVerdict('Is the workflow ready?', [
      result({
        claims: [
          {
            claim: 'The workflow is ready.',
            evidence: [],
            confidence: 0.6,
          } as SubAgentResult['claims'][number],
        ],
      }),
    ])
    const record = createDebateRecordFromVerdict('The workflow is ready.', verdict)
    const validation = validateDebateRecord(record)

    expect(record).toMatchObject({
      hypothesis: 'The workflow is ready.',
      objections: [],
      rebuttals: [],
      evidence: [],
      finalVerdict: {
        evidenceIds: [],
        decision: 'needs-work',
      },
      unresolvedRisks: [],
    })
    expect(validation.canCompleteAutomatically).toBe(false)
    expect(validation.blockedReasons).toContain(
      'Final verdict requires at least one evidence-backed claim.',
    )
  })

  test('contradictions prevent automatic completion', () => {
    const verdict = synthesizeAgentVerdict('Does the workflow validate evidence?', [
      {
        agentId: 'explore',
        status: 'completed',
        result: result({
          claims: [
            {
              claim: 'The workflow has evidence validation before completion.',
              evidence: [{ type: 'file', path: 'packages/cli/src/team/workflow-templates.ts' }],
              confidence: 0.9,
            },
          ],
        }),
      },
      {
        agentId: 'review',
        status: 'completed',
        result: result({
          claims: [
            {
              claim: 'The workflow has no evidence validation before completion.',
              evidence: [{ type: 'output', excerpt: 'validation is missing and fails' }],
              confidence: 0.8,
            },
          ],
        }),
      },
    ])
    const record = createDebateRecordFromVerdict(
      'The workflow validates evidence before completion.',
      verdict,
    )
    const validation = validateDebateRecord(record)

    expect(record.contradictions).toHaveLength(1)
    expect(validation.canCompleteAutomatically).toBe(false)
    expect(validation.blockedReasons).toContain(
      'Contradictions must be resolved before automatic completion.',
    )
  })

  test('complete debate record passes validation', () => {
    const record: DebateRecord = {
      hypothesis: 'The workflow is ready.',
      objections: [],
      rebuttals: [],
      evidence: [
        {
          id: 'evidence-1',
          claim: 'The workflow is covered by tests.',
          source: 'bun test',
        },
      ],
      finalVerdict: {
        claim: 'The workflow is ready.',
        evidenceIds: ['evidence-1'],
        decision: 'accept',
      },
      unresolvedRisks: [],
      contradictions: [],
    }

    expect(validateDebateRecord(record)).toEqual({
      canCompleteAutomatically: true,
      blockedReasons: [],
    })
  })
})
