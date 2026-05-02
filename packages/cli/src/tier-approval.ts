import { z } from 'zod'
import { type Result, err } from '@src/types'
import type { ToolTier } from '@src/tools/types'

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
}

export interface TierApprovalRequest {
  approvalId: string
  description: string
  details: TierApprovalDetails
}

/** Handler signature: receives tool name, tier, and args. Returns Result<void>. */
type TierApprovalHandler = (
  toolName: string,
  toolTier: ToolTier,
  args: unknown,
) => Promise<Result<void>>

let tierApprovalHandler: TierApprovalHandler | null = null

/** Register a handler that triggers the desktop approval popup for Tier 3/4 tools. */
export function setTierApprovalHandler(
  handler: ((toolName: string, toolTier: ToolTier, args: unknown) => Promise<Result<void>>) | null,
): void {
  tierApprovalHandler = handler
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
): Promise<Result<void>> {
  if (!tierApprovalHandler) {
    return err(
      new Error(
        `Tool "${toolName}" requires tier ${toolTier} approval, but no approval handler is active.`,
      ),
    )
  }

  return tierApprovalHandler(toolName, toolTier, toolArgs)
}

export function tierApprovalRisk(toolTier: 1 | 2 | 3 | 4): TierApprovalRisk {
  if (toolTier === 4) return 'high'
  if (toolTier === 1) return 'low'
  return 'medium'
}
