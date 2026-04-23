import { describe, expect, test } from 'bun:test'
import {
  checkAgentInvocationPermission,
  type AgentInvocationDenialCode,
} from '@src/agent-invocation-permissions'
import { BUILT_IN_AGENT_DEFINITIONS, loadConfig } from '@src/config'
import type { AgentDefinition } from '@src/types'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const READ_ONLY = {
  tier0: true,
  tier1: false,
  tier2: false,
  tier3: false,
  tier4: false,
}

function primaryAgent(id: string, canInvokeAgents: string[] = []): AgentDefinition {
  return {
    id,
    description: `${id} primary agent`,
    mode: 'primary',
    prompt: `Act as ${id}.`,
    permissions: {
      ...READ_ONLY,
      canInvokeAgents,
    },
  }
}

function expectDenied(result: ReturnType<typeof checkAgentInvocationPermission>) {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('Expected invocation permission check to fail')
  }
  return result.error
}

describe('checkAgentInvocationPermission', () => {
  test('allows configured primary-to-agent invocation', () => {
    const definitions = [primaryAgent('planner', ['explore']), ...BUILT_IN_AGENT_DEFINITIONS]

    const result = checkAgentInvocationPermission({
      parentAgentId: 'planner',
      targetAgentId: 'explore',
      definitions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.parentAgent.id).toBe('planner')
    expect(result.value.targetAgent.id).toBe('explore')
  })

  test('allows configured primary-to-test invocation', () => {
    const definitions = [primaryAgent('planner', ['test']), ...BUILT_IN_AGENT_DEFINITIONS]

    const result = checkAgentInvocationPermission({
      parentAgentId: 'planner',
      targetAgentId: 'test',
      definitions,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.targetAgent.id).toBe('test')
  })

  test('denies invocation when the parent lacks permission', () => {
    const definitions = [primaryAgent('planner', ['explore']), ...BUILT_IN_AGENT_DEFINITIONS]

    const denial = expectDenied(
      checkAgentInvocationPermission({
        parentAgentId: 'planner',
        targetAgentId: 'review',
        definitions,
      }),
    )

    expect(denial).toMatchObject({
      code: 'missing_permission' satisfies AgentInvocationDenialCode,
      parentAgentId: 'planner',
      targetAgentId: 'review',
    })
    expect(denial.message).toContain('not permitted')
  })

  test('denies unknown subagent ids with a structured reason', () => {
    const definitions = [primaryAgent('planner', ['missing-agent']), ...BUILT_IN_AGENT_DEFINITIONS]

    const denial = expectDenied(
      checkAgentInvocationPermission({
        parentAgentId: 'planner',
        targetAgentId: 'missing-agent',
        definitions,
      }),
    )

    expect(denial).toMatchObject({
      code: 'unknown_subagent' satisfies AgentInvocationDenialCode,
      parentAgentId: 'planner',
      targetAgentId: 'missing-agent',
    })
  })

  test('denies unknown parent agent ids with a structured reason', () => {
    const denial = expectDenied(
      checkAgentInvocationPermission({
        parentAgentId: 'missing-parent',
        targetAgentId: 'explore',
        definitions: BUILT_IN_AGENT_DEFINITIONS,
      }),
    )

    expect(denial).toMatchObject({
      code: 'unknown_parent_agent' satisfies AgentInvocationDenialCode,
      parentAgentId: 'missing-parent',
      targetAgentId: 'explore',
    })
  })

  test('denies hidden roles even when referenced by permission', () => {
    const definitions: AgentDefinition[] = [
      primaryAgent('planner', ['reserved']),
      {
        id: 'reserved',
        description: 'Hidden reserved role',
        mode: 'subagent',
        prompt: 'Reserved for later.',
        permissions: READ_ONLY,
        hidden: true,
      },
    ]

    const denial = expectDenied(
      checkAgentInvocationPermission({
        parentAgentId: 'planner',
        targetAgentId: 'reserved',
        definitions,
      }),
    )

    expect(denial).toMatchObject({
      code: 'role_unavailable' satisfies AgentInvocationDenialCode,
      parentAgentId: 'planner',
      targetAgentId: 'reserved',
    })
    expect(denial.message).toContain('hidden or unavailable')
  })

  test('denies phase-gated worker before worker support exists even when referenced', () => {
    const definitions = [primaryAgent('planner', ['worker']), ...BUILT_IN_AGENT_DEFINITIONS]

    const denial = expectDenied(
      checkAgentInvocationPermission({
        parentAgentId: 'planner',
        targetAgentId: 'worker',
        definitions,
      }),
    )

    expect(denial).toMatchObject({
      code: 'phase_gated_role' satisfies AgentInvocationDenialCode,
      parentAgentId: 'planner',
      targetAgentId: 'worker',
      phaseGate: 'worker-runtime',
    })
  })
})

describe('agent invocation permission config', () => {
  test('loads configured invokable agent ids', () => {
    const tempDir = join(
      tmpdir(),
      `ouroboros-agent-invocation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })

    try {
      writeFileSync(
        join(tempDir, '.ouroboros'),
        JSON.stringify({
          agent: {
            definitions: [
              {
                id: 'planner',
                description: 'Planner',
                mode: 'primary',
                prompt: 'Plan work.',
                permissions: {
                  tier0: true,
                  tier1: false,
                  tier2: false,
                  tier3: false,
                  tier4: false,
                  canInvokeAgents: ['explore'],
                },
              },
            ],
          },
        }),
      )

      const result = loadConfig(tempDir)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(
        result.value.agent.definitions.find((definition) => definition.id === 'planner'),
      ).toMatchObject({
        permissions: {
          canInvokeAgents: ['explore'],
        },
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
