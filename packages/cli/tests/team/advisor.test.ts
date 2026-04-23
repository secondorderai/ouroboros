import { describe, expect, test } from 'bun:test'
import { adviseTeamSize } from '@src/team/advisor'

describe('team size advisor', () => {
  test('avoids overkill for same-file sequential work', () => {
    const result = adviseTeamSize({
      taskSummary: 'Refactor one parser file after the previous change lands.',
      files: ['packages/cli/src/parser.ts'],
      sequentialDependencies: true,
      taskIndependence: 'low',
      permissionsRequired: ['workspace-write'],
      likelyTokenCost: 'low',
      expectedTestCost: 'medium',
      userRiskSetting: 'normal',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error

    expect(['single-agent', 'one-explorer']).toContain(result.value.recommendation)
    expect(result.value.recommendation).not.toBe('full-task-graph-team')
    expect(result.value.rationale.join('\n')).toContain('sequential dependencies')
  })

  test('recommends read-only exploration for ambiguous investigations', () => {
    const result = adviseTeamSize({
      taskSummary: 'Investigate why the task graph intermittently stalls.',
      files: [
        'packages/cli/src/team/task-graph.ts',
        'packages/cli/src/team/workflow-templates.ts',
        'packages/cli/src/tools/worker-runtime.ts',
        'packages/cli/src/tools/spawn-agent.ts',
      ],
      ambiguousInvestigation: true,
      taskIndependence: 'medium',
      permissionsRequired: ['read-only'],
      likelyTokenCost: 'medium',
      expectedTestCost: 'low',
      userRiskSetting: 'normal',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error

    expect(result.value.recommendation).toBe('read-only-research-team')
    expect(result.value.rationale.join('\n')).toContain('ambiguous read-only investigation')
  })

  test('includes explainable rationale and considered factors', () => {
    const result = adviseTeamSize({
      taskSummary: 'Implement independent package upgrades in isolated areas.',
      files: [
        'packages/cli/src/config.ts',
        'packages/desktop/src/main/ipc-handlers.ts',
        'packages/shared/src/index.ts',
        'docs/upgrades.md',
      ],
      taskIndependence: 'high',
      permissionsRequired: ['workspace-write', 'shell'],
      likelyTokenCost: 'medium',
      expectedTestCost: 'medium',
      userRiskSetting: 'high',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error

    expect(result.value.recommendation).toBe('full-task-graph-team')
    expect(result.value.rationale.length).toBeGreaterThanOrEqual(2)
    expect(result.value.rationale.join('\n')).toContain('file overlap risk=low')
    expect(result.value.considered).toMatchObject({
      fileOverlapRisk: 'low',
      taskIndependence: 'high',
      likelyTokenCost: 'medium',
      expectedTestCost: 'medium',
      userRiskSetting: 'high',
    })
  })
})
