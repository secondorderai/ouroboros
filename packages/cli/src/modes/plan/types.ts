/**
 * Plan Mode — Data Types
 *
 * A Plan is a structured, user-approvable description of work
 * the agent intends to perform. Created during plan mode and
 * executed after approval.
 */

/** A step within a plan. */
export interface PlanStep {
  /** What this step does (imperative, e.g. "Add JWT middleware to auth router"). */
  description: string

  /** Files this step will read or modify. */
  targetFiles: string[]

  /** Tools this step anticipates using. */
  tools: string[]

  /** Indices of steps that must complete before this one. */
  dependsOn?: number[]
}

/** A structured plan awaiting user approval. */
export interface Plan {
  /** Short title (e.g. "Refactor auth to JWT"). */
  title: string

  /** One-paragraph summary of the overall approach. */
  summary: string

  /** Ordered steps to execute. */
  steps: PlanStep[]

  /** Files explored during planning (for context). */
  exploredFiles: string[]

  /** Current lifecycle status. */
  status: 'draft' | 'submitted' | 'approved' | 'rejected'

  /** User feedback when status is 'rejected'. */
  feedback?: string
}
