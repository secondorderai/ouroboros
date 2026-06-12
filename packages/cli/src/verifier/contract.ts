/**
 * Verifier Model — done-contract extraction.
 *
 * `extractDoneContract()` runs a fresh-context, single-message LLM pass that
 * turns the verbatim task snapshot (plus mid-run steers) into a short list of
 * concrete, independently checkable completion criteria. Standing criteria
 * from config are appended verbatim afterwards — they are never sent to the
 * model for rewriting.
 *
 * Extraction is lazy (first gate hit) and cached per run by the agent; a
 * failed extraction degrades to verifying with no explicit criteria and must
 * never brick the loop.
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { type Result, ok } from '@src/types'
import { generateStructured } from '@src/llm/structured'

/** Structured response schema for the extraction call. */
export const doneContractSchema = z.object({
  criteria: z.array(z.string()).min(1).max(12),
})

export type DoneContract = z.infer<typeof doneContractSchema>

export interface ExtractDoneContractInput {
  /** Model used for the extraction pass (the resolved verifier model). */
  model: LanguageModel
  /** Verbatim task snapshot captured at run start. */
  task: string
  /** Steer texts the user injected mid-run, in arrival order. */
  steerTexts: string[]
  /**
   * Criteria appended verbatim to every contract (from
   * `verifier.standingCriteria` config). Never sent to the model.
   */
  standingCriteria: string[]
  abortSignal?: AbortSignal
}

/** Build the single-user-message extraction prompt. Exported for tests. */
export function buildDoneContractPrompt(
  input: Pick<ExtractDoneContractInput, 'task' | 'steerTexts'>,
): string {
  const sections: string[] = []

  sections.push(
    `You extract the done contract for an AI agent's task: the concrete, independently checkable outcomes that must hold for the task to count as complete.

Rules:
- Each criterion must be a concrete outcome that can be checked independently.
- Extract only what the task states or directly implies. Do not invent requirements.
- Prefer few precise criteria over many vague ones.
- Include a criterion only when it applies to this task. If a requirement is conditional (e.g. it applies only when code behavior changes), state the condition explicitly in the criterion so a verifier can treat it as satisfied when the condition does not apply.`,
  )

  sections.push(`## Task\n\n${input.task}`)

  if (input.steerTexts.length > 0) {
    const steers = input.steerTexts.map((text, index) => `${index + 1}. ${text}`).join('\n')
    sections.push(
      `## Mid-run User Steering\n\nThe user added these instructions mid-run; they refine the task:\n\n${steers}`,
    )
  }

  sections.push(`## Output

Respond with ONLY a JSON object (no markdown fences, no extra text) matching this schema:

{
  "criteria": ["string — one concrete, checkable completion criterion", "..."]
}

List between 1 and 12 criteria.`)

  return sections.join('\n\n')
}

/** Case-insensitive, whitespace-normalized key used for deduplication. */
function dedupeKey(criterion: string): string {
  return criterion.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Extract the done contract for a task. The result is the extracted criteria
 * followed by the standing criteria (appended verbatim), deduplicated
 * case-insensitively with first occurrence winning.
 *
 * Never throws — LLM failures, unparseable output, and schema violations are
 * all returned as `err`. Callers degrade to verifying without explicit
 * criteria.
 */
export async function extractDoneContract(
  input: ExtractDoneContractInput,
): Promise<Result<string[]>> {
  const prompt = buildDoneContractPrompt(input)
  const result = await generateStructured(input.model, prompt, doneContractSchema, {
    temperature: 0.1,
    maxTokens: 1024,
    abortSignal: input.abortSignal,
  })

  if (!result.ok) {
    return result
  }

  const seen = new Set<string>()
  const criteria: string[] = []
  const extracted = result.value.criteria.map((criterion) => criterion.trim())
  for (const criterion of [...extracted, ...input.standingCriteria]) {
    if (criterion.trim().length === 0) continue
    const key = dedupeKey(criterion)
    if (seen.has(key)) continue
    seen.add(key)
    criteria.push(criterion)
  }

  return ok(criteria)
}
