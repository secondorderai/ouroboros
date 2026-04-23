import { describe, expect, test } from 'bun:test'
import { synthesizeAgentVerdict, type AgentSynthesisInput } from '@src/tools/subagent-synthesis'
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

describe('subagent synthesis', () => {
  test('multiple compatible results produce a consensus verdict', () => {
    const verdict = synthesizeAgentVerdict('Does the CLI validate structured child output?', [
      {
        agentId: 'explore',
        status: 'completed',
        result: result({
          claims: [
            {
              claim: 'The CLI has structured subagent output validation.',
              evidence: [
                {
                  type: 'file',
                  path: 'packages/cli/src/tools/subagent-result.ts',
                  line: 32,
                  excerpt: 'subAgentResultSchema',
                },
              ],
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
              claim: 'The CLI supports structured child output validation.',
              evidence: [
                {
                  type: 'file',
                  path: 'packages/cli/tests/tools/spawn-agent.test.ts',
                  line: 153,
                  excerpt: 'validateSubAgentResult',
                },
              ],
              confidence: 0.85,
            },
          ],
        }),
      },
    ])

    expect(verdict.consensus).toContain('Compatible evidence-backed claims support')
    expect(verdict.supportingClaims).toHaveLength(2)
    expect(verdict.conflictingClaims).toHaveLength(0)
    expect(verdict.unsupportedClaims).toHaveLength(0)
    expect(verdict.recommendedAction).toContain('Proceed with the consensus')
  })

  test('claims with no evidence are listed separately', () => {
    const unsupportedResult = result({
      claims: [
        {
          claim: 'The CLI has a synthesis helper.',
          confidence: 0.6,
        } as SubAgentResult['claims'][number],
      ],
    })

    const verdict = synthesizeAgentVerdict('Does the CLI have synthesis?', [unsupportedResult])

    expect(verdict.supportingClaims).toHaveLength(0)
    expect(verdict.unsupportedClaims).toHaveLength(1)
    expect(verdict.unsupportedClaims[0]).toMatchObject({
      claim: 'The CLI has a synthesis helper.',
      evidence: [],
      confidence: 0.6,
    })
    expect(verdict.recommendedAction).toContain('verify or discard unsupported claims')
  })

  test('review findings are carried into the parent synthesis verdict', () => {
    const verdict = synthesizeAgentVerdict('What did the reviewer find?', [
      {
        agentId: 'review',
        status: 'completed',
        result: result({
          reviewFindings: [
            {
              title: 'Missing empty-state guard',
              severity: 'high',
              file: 'src/example.ts',
              line: 3,
              body: 'The changed code dereferences the first item without checking empty input.',
              confidence: 0.88,
              evidence: [
                {
                  type: 'file',
                  path: 'src/example.ts',
                  line: 3,
                  excerpt: 'return items[0].name',
                },
              ],
            },
          ],
        }),
      },
    ])

    expect(verdict.reviewFindings).toEqual([
      expect.objectContaining({
        title: 'Missing empty-state guard',
        severity: 'high',
        confidence: 0.88,
      }),
    ])
  })

  test('opposing evidence-backed claims are listed as contradictions with unresolved risk', () => {
    const inputs: AgentSynthesisInput[] = [
      {
        agentId: 'explore',
        status: 'completed',
        result: result({
          claims: [
            {
              claim: 'The spawn agent tool supports structured result validation.',
              evidence: [
                {
                  type: 'output',
                  excerpt: 'structured result validation is enabled and passes',
                },
              ],
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
              claim: 'The spawn agent tool does not support structured result validation.',
              evidence: [
                {
                  type: 'output',
                  excerpt: 'structured result validation is missing and fails',
                },
              ],
              confidence: 0.8,
            },
          ],
        }),
      },
    ]

    const verdict = synthesizeAgentVerdict('Does spawn_agent validate structured output?', inputs)

    expect(verdict.supportingClaims).toHaveLength(0)
    expect(verdict.conflictingClaims).toHaveLength(1)
    expect(verdict.conflictingClaims[0].claims.map((claim) => claim.agentId)).toEqual([
      'explore',
      'review',
    ])
    expect(verdict.unresolvedRisks.join('\n')).toContain('Conflicting evidence-backed claims')
    expect(verdict.recommendedAction).toContain('Mention the contradictions before relying')
  })

  test('failed subagents appear in unresolved risks without failing synthesis', () => {
    const verdict = synthesizeAgentVerdict('Is the implementation complete?', [
      {
        agentId: 'explore',
        status: 'failed',
        stopReason: 'error',
        error: { message: 'child model failed' },
        resultValidation: {
          valid: false,
          warnings: ['Child output was empty.'],
        },
      },
      result({
        claims: [
          {
            claim: 'The implementation has evidence-backed tests.',
            evidence: [
              {
                type: 'file',
                path: 'packages/cli/tests/tools/subagent-synthesis.test.ts',
                line: 1,
              },
            ],
            confidence: 0.7,
          },
        ],
      }),
    ])

    expect(verdict.supportingClaims).toHaveLength(1)
    expect(verdict.unresolvedRisks.join('\n')).toContain(
      'Subagent explore failed: child model failed',
    )
    expect(verdict.unresolvedRisks.join('\n')).toContain('Child output was empty')
    expect(verdict.consensus).toContain('The implementation has evidence-backed tests.')
  })
})
