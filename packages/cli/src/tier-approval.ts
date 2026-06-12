import { z } from 'zod'
import { type Result, err } from '@src/types'
import type { ToolTier } from '@src/tools/types'
import type { VerifierReport } from '@src/verifier/types'

export const tierApprovalSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  toolTier: z.number().int().min(1).max(4),
  toolArgs: z.unknown(),
  createdAt: z.string().datetime(),
})

export type TierApproval = z.infer<typeof tierApprovalSchema>

export type TierApprovalRisk = 'high' | 'medium' | 'low'

export interface TierApprovalDetails {
  approvalId: string
  toolName: string
  toolTier: 1 | 2 | 3 | 4
  toolArgs: unknown
  tierLabel: string
  createdAt: string
  /**
   * Completion-gate verifier report attached when the approval was triggered
   * by (or is relevant to) a verifier outcome — e.g. the
   * `verifier-completion-override` escalation.
   */
  verifierReport?: VerifierReport
}

export interface TierApprovalRequest {
  approvalId: string
  description: string
  details: TierApprovalDetails
}

/**
 * Optional context attached to a tier-approval request beyond the tool call
 * itself. Existing callsites that pass no extras are unchanged.
 */
export interface TierApprovalExtras {
  verifierReport?: VerifierReport
}

/** Handler signature: receives tool name, tier, args, and optional extras. Returns Result<void>. */
type TierApprovalHandler = (
  toolName: string,
  toolTier: ToolTier,
  args: unknown,
  extras?: TierApprovalExtras,
) => Promise<Result<void>>

let tierApprovalHandler: TierApprovalHandler | null = null

/** Register a handler that triggers the desktop approval popup for Tier 3/4 tools. */
export function setTierApprovalHandler(handler: TierApprovalHandler | null): void {
  tierApprovalHandler = handler
}

/**
 * Whether a tier-approval handler is registered. Only the JSON-RPC server
 * registers one (desktop mode); in REPL mode this is false and escalation
 * paths (e.g. `bypassSandbox: true`) yield a clean denial, so model-facing
 * guidance can say that approval requires the desktop app.
 */
export function hasTierApprovalHandler(): boolean {
  return tierApprovalHandler !== null
}

/**
 * Request approval for a tool call whose tier is disabled in config.
 * Called by the ToolRegistry when a Tier 3/4 tool is blocked.
 * Returns `ok(undefined)` if approved, or an error if denied/no handler.
 */
export async function requestTierApproval(
  toolName: string,
  toolTier: 1 | 2 | 3 | 4,
  toolArgs: unknown,
  extras?: TierApprovalExtras,
): Promise<Result<void>> {
  if (!tierApprovalHandler) {
    return err(
      new Error(
        `Tool "${toolName}" requires tier ${toolTier} approval, but no approval handler is active. ` +
          'Human approval requires the desktop app.',
      ),
    )
  }

  return tierApprovalHandler(toolName, toolTier, toolArgs, extras)
}

export function tierApprovalRisk(toolTier: 1 | 2 | 3 | 4): TierApprovalRisk {
  if (toolTier === 4) return 'high'
  if (toolTier === 1) return 'low'
  return 'medium'
}
