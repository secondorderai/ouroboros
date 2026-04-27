import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { type Result, err, ok } from '@src/types'
import type { ToolExecutionContext } from '@src/tools/types'

export const permissionLeaseSchema = z.object({
  id: z.string().min(1),
  agentRunId: z.string().min(1),
  allowedTools: z.array(z.string().min(1)),
  allowedPaths: z.array(z.string().min(1)).default([]),
  allowedBash: z.array(z.string().min(1)).default([]),
  maxToolCalls: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  approvalRequired: z.boolean().default(false),
  approvedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  toolCallCount: z.number().int().nonnegative().default(0),
  deniedCallCount: z.number().int().nonnegative().default(0),
})

export type PermissionLease = z.infer<typeof permissionLeaseSchema>

export type PermissionLeaseApprovalRisk = 'low' | 'medium' | 'high'

export interface PermissionLeaseApprovalDetails {
  leaseId: string
  agentRunId: string
  requestedTools: string[]
  requestedPaths: string[]
  requestedBashCommands: string[]
  expiresAt?: string
  riskSummary: string
  risk: PermissionLeaseApprovalRisk
  createdAt: string
}

export interface PermissionLeaseApprovalRequest {
  approvalId: string
  description: string
  details: PermissionLeaseApprovalDetails
  lease: PermissionLease
}

type PermissionLeaseApprovalHandler = (
  request: PermissionLeaseApprovalRequest,
) => Promise<Result<PermissionLease>>

let permissionLeaseApprovalHandler: PermissionLeaseApprovalHandler | null = null

export interface CreatePermissionLeaseInput {
  id?: string
  agentRunId: string
  allowedTools: string[]
  allowedPaths?: string[]
  allowedBash?: string[]
  maxToolCalls?: number
  expiresAt?: string
  approvalRequired?: boolean
  approvedAt?: string | null
  createdAt?: string
  riskSummary?: string
}

export interface PermissionLeaseCheck {
  leaseId: string
  agentRunId: string
  toolName: string
  status: 'allowed' | 'denied'
  reason?: string
  occurredAt: string
}

const FILE_PATH_ARGUMENT_TOOLS = new Set(['file-read', 'file-write', 'file-edit'])

export function createPermissionLease(input: CreatePermissionLeaseInput): PermissionLease {
  return permissionLeaseSchema.parse({
    id: input.id ?? crypto.randomUUID(),
    agentRunId: input.agentRunId,
    allowedTools: input.allowedTools,
    allowedPaths: input.allowedPaths ?? [],
    allowedBash: input.allowedBash ?? [],
    maxToolCalls: input.maxToolCalls,
    expiresAt: input.expiresAt,
    approvalRequired: input.approvalRequired ?? false,
    approvedAt: input.approvedAt ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    toolCallCount: 0,
    deniedCallCount: 0,
  })
}

export function setPermissionLeaseApprovalHandler(
  handler: PermissionLeaseApprovalHandler | null,
): void {
  permissionLeaseApprovalHandler = handler
}

export function buildPermissionLeaseApprovalDetails(
  lease: PermissionLease,
  riskSummary?: string,
): PermissionLeaseApprovalDetails {
  const risk = classifyPermissionLeaseRisk(lease)
  return {
    leaseId: lease.id,
    agentRunId: lease.agentRunId,
    requestedTools: lease.allowedTools,
    requestedPaths: lease.allowedPaths,
    requestedBashCommands: lease.allowedBash,
    ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
    riskSummary: riskSummary ?? defaultRiskSummary(lease, risk),
    risk,
    createdAt: lease.createdAt,
  }
}

export async function createPermissionLeaseWithApproval(
  input: CreatePermissionLeaseInput,
): Promise<Result<PermissionLease>> {
  const lease = createPermissionLease(input)
  if (!lease.approvalRequired) {
    return ok(lease)
  }

  if (!permissionLeaseApprovalHandler) {
    return err(
      new Error('Permission lease approval is required, but no approval handler is active.'),
    )
  }

  const details = buildPermissionLeaseApprovalDetails(lease, input.riskSummary)
  return permissionLeaseApprovalHandler({
    approvalId: `lease-approval-${lease.id}`,
    description: `Approve permission lease for subagent run ${lease.agentRunId}`,
    details,
    lease,
  })
}

export function approvePermissionLease(
  lease: PermissionLease,
  approvedAt = new Date().toISOString(),
): PermissionLease {
  return permissionLeaseSchema.parse({
    ...lease,
    approvalRequired: true,
    approvedAt,
  })
}

function classifyPermissionLeaseRisk(lease: PermissionLease): PermissionLeaseApprovalRisk {
  if (
    lease.allowedTools.includes('bash') ||
    lease.allowedTools.includes('code-exec') ||
    lease.allowedTools.some((tool) => tool.includes('write') || tool.includes('edit'))
  ) {
    return lease.allowedBash.length > 0 || lease.allowedPaths.length > 0 ? 'high' : 'medium'
  }
  if (lease.allowedTools.some((tool) => tool.startsWith('mcp__'))) return 'medium'
  if (lease.allowedPaths.length > 0) return 'medium'
  return 'low'
}

function defaultRiskSummary(lease: PermissionLease, risk: PermissionLeaseApprovalRisk): string {
  const parts = [
    `${risk} risk lease for ${lease.allowedTools.length} tool${lease.allowedTools.length === 1 ? '' : 's'}`,
  ]
  if (lease.allowedPaths.length > 0) {
    parts.push(
      `${lease.allowedPaths.length} path scope${lease.allowedPaths.length === 1 ? '' : 's'}`,
    )
  }
  if (lease.allowedBash.length > 0) {
    parts.push(
      `${lease.allowedBash.length} exact bash command${lease.allowedBash.length === 1 ? '' : 's'}`,
    )
  }
  if (lease.expiresAt) {
    parts.push(`expires ${lease.expiresAt}`)
  }
  return parts.join('; ')
}

export async function enforcePermissionLease(
  lease: PermissionLease,
  toolName: string,
  args: unknown,
  context: ToolExecutionContext,
): Promise<Result<void>> {
  const denial = getLeaseDenialReason(lease, toolName, args, context.basePath)
  if (denial) {
    lease.deniedCallCount += 1
    await context.transcriptStore?.recordPermissionLeaseDenial(lease.id)
    emitLeaseEvent(context, {
      leaseId: lease.id,
      agentRunId: lease.agentRunId,
      toolName,
      status: 'denied',
      reason: denial,
      occurredAt: new Date().toISOString(),
    })
    return err(new Error(`Permission lease "${lease.id}" denied ${toolName}: ${denial}`))
  }

  lease.toolCallCount += 1
  const auditResult = await context.transcriptStore?.recordPermissionLeaseToolCall(lease.id)
  if (auditResult && !auditResult.ok) {
    return auditResult
  }
  emitLeaseEvent(context, {
    leaseId: lease.id,
    agentRunId: lease.agentRunId,
    toolName,
    status: 'allowed',
    occurredAt: new Date().toISOString(),
  })

  return ok(undefined)
}

function getLeaseDenialReason(
  lease: PermissionLease,
  toolName: string,
  args: unknown,
  basePath: string | undefined,
): string | null {
  if (lease.approvalRequired && !lease.approvedAt) {
    return 'lease requires approval before restricted tools can run'
  }

  if (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()) {
    return `lease expired at ${lease.expiresAt}`
  }

  if (lease.maxToolCalls !== undefined && lease.toolCallCount >= lease.maxToolCalls) {
    return `lease max tool calls exceeded (${lease.maxToolCalls})`
  }

  if (!lease.allowedTools.includes(toolName)) {
    return `tool is not allowed by lease. Allowed tools: ${formatList(lease.allowedTools)}`
  }

  if (FILE_PATH_ARGUMENT_TOOLS.has(toolName)) {
    const path = getStringArg(args, 'path')
    if (!path) {
      return 'file operation requires a string path argument'
    }
    if (!isPathAllowed(path, lease.allowedPaths, basePath)) {
      return `path "${path}" is outside allowed paths: ${formatList(lease.allowedPaths)}`
    }
  }

  if (toolName === 'bash') {
    const command = getStringArg(args, 'command')?.trim()
    if (!command) {
      return 'bash operation requires a string command argument'
    }
    const allowedCommands = new Set(lease.allowedBash.map((value) => value.trim()))
    if (!allowedCommands.has(command)) {
      return `bash command "${command}" is outside allowed commands: ${formatList(lease.allowedBash)}`
    }
  }

  return null
}

function getStringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== 'object') return null
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function isPathAllowed(
  path: string,
  allowedPaths: string[],
  basePath: string | undefined,
): boolean {
  if (allowedPaths.length === 0) return false

  const workspace = basePath ?? process.cwd()
  const candidateAbsolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const candidateRelative = normalizePath(relative(workspace, candidateAbsolute))
  const candidateNormalized = normalizePath(candidateAbsolute)

  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizePath(allowedPath)
    const matchTarget = isAbsolute(allowedPath)
      ? candidateNormalized
      : candidateRelative === ''
        ? '.'
        : candidateRelative

    if (hasGlob(normalizedAllowed)) {
      return globToRegExp(normalizedAllowed).test(matchTarget)
    }

    const allowedAbsolute = isAbsolute(allowedPath)
      ? normalizePath(resolve(allowedPath))
      : normalizePath(resolve(workspace, allowedPath))
    const target = isAbsolute(allowedPath) ? candidateNormalized : normalizePath(candidateAbsolute)

    return target === allowedAbsolute || target.startsWith(`${allowedAbsolute}/`)
  })
}

function hasGlob(pattern: string): boolean {
  return pattern.includes('*')
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern)
  let regex = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    const next = normalized[i + 1]
    if (char === '*' && next === '*') {
      const after = normalized[i + 2]
      if (after === '/') {
        regex += '(?:.*/)?'
        i += 2
      } else {
        regex += '.*'
        i += 1
      }
      continue
    }
    if (char === '*') {
      regex += '[^/]*'
      continue
    }
    regex += escapeRegExp(char)
  }

  return new RegExp(`^${regex}$`)
}

function escapeRegExp(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none configured)'
}

function emitLeaseEvent(context: ToolExecutionContext, check: PermissionLeaseCheck): void {
  context.emitEvent?.({
    type: 'permission-lease-check',
    ...check,
  })
}
