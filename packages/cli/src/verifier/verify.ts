/**
 * Verifier Model — completion-gate verification call.
 *
 * `verify()` runs a fresh-context, single-message LLM pass that judges a
 * candidate final answer against the original task, the done criteria, and
 * the tool-call evidence ledger. The verifier is deliberately strict: the
 * agent's claims are not evidence — only tool results are — and it must
 * prefer `unknown` over guessing.
 */
import type { LanguageModel } from 'ai'
import type { Result } from '@src/types'
import { generateStructured } from '@src/llm/structured'
import { verifierVerdictSchema, type VerifierEvidenceItem, type VerifierVerdict } from './types'

export interface VerifyInput {
  /** Model used for the verification pass (actor model by default). */
  model: LanguageModel
  /** Verbatim task snapshot captured at run start. */
  task: string
  /** Steer texts the user injected mid-run, in arrival order. */
  steerTexts: string[]
  /**
   * Numbered done criteria from `extractDoneContract`. Empty when extraction
   * failed (degraded gate) — the prompt then instructs the verifier to derive
   * the criteria from the task itself.
   */
  doneCriteria: string[]
  /** Evidence ledger: the last ~60 tool results recorded during the run. */
  evidence: VerifierEvidenceItem[]
  /**
   * Total tool calls executed in the run. May exceed `evidence.length` when
   * older ledger entries were elided; the prompt notes the elision.
   */
  toolCallCount: number
  /** The candidate final answer produced by the actor. */
  candidateAnswer: string
  abortSignal?: AbortSignal
}

/** Build the single-user-message verifier prompt. Exported for tests. */
export function buildVerifierPrompt(input: VerifyInput): string {
  const sections: string[] = []

  sections.push(
    `You are a strict completion verifier for an AI agent. The agent believes it has finished the task below. Your job is to judge whether the task is actually complete.

Rules:
- The agent's claims are NOT evidence. Only tool results are evidence.
- If the evidence is insufficient to decide, prefer the verdict "unknown" over guessing.
- Do not invent requirements that the task does not state or imply.
- A criterion counts as met only when the tool-call evidence supports it.
- Some criteria are conditional (e.g. "for any behavior change", "if X"). First decide whether the condition applies to this task. A criterion whose condition does not apply is satisfied by definition — do not mark it failed or unknown for lack of evidence.
- A criterion phrased as a prohibition (e.g. "No existing test was deleted") is satisfied when the evidence shows no sign of the prohibited action; it does not require positive proof.`,
  )

  sections.push(`## Original Task\n\n${input.task}`)

  if (input.steerTexts.length > 0) {
    const steers = input.steerTexts.map((text, index) => `${index + 1}. ${text}`).join('\n')
    sections.push(
      `## Mid-run User Steering\n\nThe user added these instructions mid-run:\n\n${steers}`,
    )
  }

  if (input.doneCriteria.length > 0) {
    const criteria = input.doneCriteria
      .map((criterion, index) => `${index + 1}. ${criterion}`)
      .join('\n')
    sections.push(
      `## Done Criteria\n\nThe task is complete only when every applicable criterion holds. A conditional criterion whose condition this task does not trigger counts as satisfied:\n\n${criteria}`,
    )
  } else {
    sections.push(
      `## Done Criteria\n\nNo explicit criteria were provided. Derive the concrete completion criteria from the task itself, then judge against them.`,
    )
  }

  const elidedCount = Math.max(0, input.toolCallCount - input.evidence.length)
  const evidenceLines =
    input.evidence.length > 0
      ? input.evidence
          .map(
            (item, index) =>
              `${elidedCount + index + 1}. [${item.toolName}${item.isError ? ' — ERROR' : ''}] ${item.summary}`,
          )
          .join('\n')
      : '(no tool results recorded)'
  const elisionMarker =
    elidedCount > 0 ? `[... ${elidedCount} earlier tool call(s) elided ...]\n` : ''
  sections.push(
    `## Tool-Call Evidence\n\n${input.toolCallCount} tool call(s) were executed during this run.\n${elisionMarker}${evidenceLines}`,
  )

  sections.push(`## Candidate Answer\n\n${input.candidateAnswer}`)

  sections.push(`## Output

Respond with ONLY a JSON object (no markdown fences, no extra text) matching this schema:

{
  "verdict": "pass" | "fail" | "unknown",
  "failures": [
    {
      "criterion": "string — the unmet criterion",
      "evidence": "string — what the evidence shows (or fails to show)",
      "suggestion": "string — concrete next step to satisfy the criterion"
    }
  ],
  "reason": "string — brief justification for the verdict"
}

Use "pass" only when the evidence supports every applicable criterion. Use "fail" with one failure entry per unmet criterion. Use "unknown" when the evidence cannot establish completion either way.`)

  return sections.join('\n\n')
}

/**
 * Run the verification pass. Never throws — LLM failures, unparseable output,
 * and schema violations are all returned as `err`.
 */
export async function verify(input: VerifyInput): Promise<Result<VerifierVerdict>> {
  const prompt = buildVerifierPrompt(input)
  return generateStructured(input.model, prompt, verifierVerdictSchema, {
    temperature: 0.1,
    maxTokens: 1024,
    abortSignal: input.abortSignal,
  })
}
