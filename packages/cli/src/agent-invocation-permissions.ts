import { type AgentDefinition, type Result, err, ok } from '@src/types'

export const PHASE_GATED_AGENT_ROLES: Readonly<Record<string, string>> = {
  worker: 'worker-runtime',
}

export type AgentInvocationDenialCode =
  | 'unknown_parent_agent'
  | 'unknown_subagent'
  | 'parent_unavailable'
  | 'role_unavailable'
  | 'phase_gated_role'
  | 'missing_permission'

export type AgentInvocationDenial = {
  code: AgentInvocationDenialCode
  message: string
  parentAgentId: string
  targetAgentId: string
  phaseGate?: string
}

export type AgentInvocationGrant = {
  parentAgent: AgentDefinition
  targetAgent: AgentDefinition
}

export type AgentInvocationPermissionInput = {
  parentAgentId: string
  targetAgentId: string
  definitions: AgentDefinition[]
  enabledPhaseGates?: string[]
}

function deny(input: {
  code: AgentInvocationDenialCode
  message: string
  parentAgentId: string
  targetAgentId: string
  phaseGate?: string
}): Result<AgentInvocationGrant, AgentInvocationDenial> {
  return err(input)
}

function getPhaseGate(definition: AgentDefinition): string | undefined {
  return definition.phaseGate ?? PHASE_GATED_AGENT_ROLES[definition.id]
}

export function checkAgentInvocationPermission(
  input: AgentInvocationPermissionInput,
): Result<AgentInvocationGrant, AgentInvocationDenial> {
  const definitionsById = new Map(
    input.definitions.map((definition) => [definition.id, definition]),
  )
  const parentAgent = definitionsById.get(input.parentAgentId)
  const targetAgent = definitionsById.get(input.targetAgentId)

  if (!parentAgent) {
    return deny({
      code: 'unknown_parent_agent',
      message: `Unknown parent agent "${input.parentAgentId}".`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
    })
  }

  if (!targetAgent) {
    return deny({
      code: 'unknown_subagent',
      message: `Unknown target agent "${input.targetAgentId}".`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
    })
  }

  if (parentAgent.hidden || parentAgent.mode === 'subagent') {
    return deny({
      code: 'parent_unavailable',
      message: `Agent "${input.parentAgentId}" is not available as a primary invoking agent.`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
    })
  }

  const phaseGate = getPhaseGate(targetAgent)
  const phaseGateEnabled = Boolean(phaseGate && input.enabledPhaseGates?.includes(phaseGate))
  if (phaseGate && !phaseGateEnabled) {
    return deny({
      code: 'phase_gated_role',
      message: `Agent "${input.targetAgentId}" is gated by phase "${phaseGate}" and is not enabled yet.`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
      phaseGate,
    })
  }

  if (targetAgent.hidden && !phaseGateEnabled) {
    return deny({
      code: 'role_unavailable',
      message: `Agent "${input.targetAgentId}" is hidden or unavailable for invocation.`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
    })
  }

  const allowedAgentIds = parentAgent.permissions?.canInvokeAgents ?? []
  if (!allowedAgentIds.includes(targetAgent.id)) {
    return deny({
      code: 'missing_permission',
      message: `Agent "${input.parentAgentId}" is not permitted to invoke "${input.targetAgentId}".`,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
    })
  }

  return ok({ parentAgent, targetAgent })
}
