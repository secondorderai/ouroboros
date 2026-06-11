/**
 * Verifier Model — shared types.
 *
 * Dependency-light by design: this module must not import from `agent.ts`,
 * `tier-approval.ts`, or any other agent-layer module (cycle risk). Zod only.
 */
import { z } from 'zod'

/** A single unmet criterion reported by the verifier. */
export const verifierFailureSchema = z.object({
  criterion: z.string().default(''),
  evidence: z.string().default(''),
  suggestion: z.string().default(''),
})

export type VerifierFailure = z.infer<typeof verifierFailureSchema>

/**
 * Structured verdict returned by the completion-gate verifier.
 *
 * All string fields are defaulted so a sparse-but-valid model response still
 * parses; only `verdict` is required.
 */
export const verifierVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unknown']),
  failures: z.array(verifierFailureSchema).default([]),
  reason: z.string().default(''),
})

export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>

/**
 * One entry in the per-run evidence ledger. The agent appends an item each
 * time a tool result is recorded; the ledger (not conversation history, which
 * can be compacted mid-run) is what the verifier judges against.
 */
export interface VerifierEvidenceItem {
  toolName: string
  isError: boolean
  /** Tool result summary, capped at 400 characters. */
  summary: string
}

/** Final verdict summary reported after the completion gate resolves. */
export interface VerifierReport {
  verdict: 'pass' | 'fail' | 'unknown'
  attempt: number
  toolCallCount: number
  /** ISO-8601 timestamp of when the verdict was produced. */
  checkedAt: string
}

/**
 * Order-independent signature of a failure set.
 *
 * Used for oscillation detection: when the verifier reports the identical set
 * of unmet criteria on consecutive attempts, retrying is pointless and the
 * gate accepts with a warning instead.
 */
export function failureSignature(failures: VerifierFailure[]): string {
  return failures
    .map((failure) => failure.criterion.trim().toLowerCase())
    .filter((criterion) => criterion.length > 0)
    .sort()
    .join('|')
}
