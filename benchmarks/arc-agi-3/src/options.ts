/**
 * Shared options contract between the CLI entry (run.ts) and the runner
 * (src/runner.ts). Keep this file dependency-free.
 */

export interface ArcBenchOptions {
  /** Game ids to run, or 'all' to fetch the full list from the API. */
  games: string[] | 'all'
  /** LLM-step budget per game (passed as maxSteps on agent/run). */
  maxSteps: number
  /** Tags attached to the scorecard on open. */
  tags: string[]
  /** Wall-clock timeout per game, in minutes. */
  timeoutMin: number
  /**
   * Reasoning effort for the playing model (minimal|low|medium|high|max).
   * Defaults to 'high' — grid-mechanics inference benefits from thinking
   * budget more than most tasks.
   */
  reasoningEffort?: string
  /** Optional path to a config dir to use instead of generating a temp one. */
  configDir?: string
  /** Optional path to write the results JSON. */
  out?: string
}
