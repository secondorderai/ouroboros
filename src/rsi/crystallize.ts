/**
 * RSI Module — Crystallize (Reflection)
 *
 * First stage of the crystallization pipeline. Evaluates whether a completed
 * task contains a generalizable pattern worth crystallizing into a skill.
 *
 * Produces a ReflectionRecord that downstream tools (SkillGenTool, promotion
 * pipeline) consume.
 */
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { type Result, ok, err } from '@src/types'
import { generateResponse } from '@src/llm'
import type { SkillCatalogEntry } from '@src/tools/skill-manager'

// ── ReflectionRecord schema ───────────────────────────────────────────

export const ReflectionRecordSchema = z.object({
  taskSummary: z.string().describe('Brief description of what the agent just accomplished'),
  novelty: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How novel was this solution? 0 = fully handled by existing skill, 1 = completely new',
    ),
  generalizability: z
    .number()
    .min(0)
    .max(1)
    .describe('How reusable is this pattern for future tasks?'),
  proposedSkillName: z
    .string()
    .optional()
    .describe('kebab-case name if novelty + generalizability exceed threshold'),
  proposedSkillDescription: z
    .string()
    .optional()
    .describe('What the skill would do and when to trigger it'),
  keySteps: z.array(z.string()).optional().describe('Core steps of the generalizable pattern'),
  reasoning: z.string().describe("The agent's reasoning about novelty and generalizability"),
  shouldCrystallize: z
    .boolean()
    .describe('Final decision: true if both novelty and generalizability exceed threshold'),
})

export type ReflectionRecord = z.infer<typeof ReflectionRecordSchema>

// ── Reflection prompt ────────────────────────────────────────────────

function buildReflectionPrompt(taskSummary: string, existingSkills: SkillCatalogEntry[]): string {
  const skillList =
    existingSkills.length > 0
      ? existingSkills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
      : '(No existing skills)'

  return `You are a reflection engine for a self-improving AI agent. Your job is to evaluate whether a completed task contains a generalizable pattern worth crystallizing into a reusable skill.

## Existing Skills

${skillList}

## Completed Task

${taskSummary}

## Instructions

Evaluate the task along two dimensions:

1. **Novelty** (0-1): How novel was the solution approach?
   - 0.0-0.2: An existing skill already handles this exact pattern
   - 0.3-0.5: Similar to existing skills but with minor variations
   - 0.6-0.8: Meaningfully different approach not covered by existing skills
   - 0.9-1.0: Completely new technique or pattern

2. **Generalizability** (0-1): How reusable is this pattern for future, different tasks?
   - 0.0-0.2: Extremely task-specific, unlikely to recur
   - 0.3-0.5: Could apply to a narrow class of similar tasks
   - 0.6-0.8: Broadly applicable pattern across multiple task types
   - 0.9-1.0: Fundamental technique applicable to almost any task

If both novelty and generalizability are high (>= 0.7), propose a skill:
- \`proposedSkillName\`: kebab-case identifier
- \`proposedSkillDescription\`: what the skill does and when to use it
- \`keySteps\`: the core steps of the pattern

## Few-shot examples

### Example 1: Low novelty (existing skill covers it)
Task: "Read a file, extracted key information, and wrote a summary to memory."
Existing skills: ["file-summarizer: Reads files and produces summaries"]
→ novelty: 0.15, generalizability: 0.6, shouldCrystallize: false
Reasoning: "The file-summarizer skill already handles this exact pattern."

### Example 2: High novelty, low generalizability
Task: "Fixed a specific race condition in the WebSocket reconnection logic by adding a mutex around the connection state machine."
Existing skills: []
→ novelty: 0.85, generalizability: 0.25, shouldCrystallize: false
Reasoning: "Novel debugging approach but too specific to WebSocket reconnection to generalize."

### Example 3: High novelty, high generalizability
Task: "Decomposed a complex refactoring into atomic steps, ran tests after each step, and automatically rolled back on failure."
Existing skills: []
→ novelty: 0.9, generalizability: 0.9, shouldCrystallize: true
Reasoning: "Incremental-refactor-with-rollback is a broadly applicable pattern not covered by any existing skill."

## Output

Respond with ONLY a JSON object (no markdown fences, no extra text) matching this schema:

{
  "taskSummary": "string — brief description of the task",
  "novelty": number (0-1),
  "generalizability": number (0-1),
  "proposedSkillName": "string or omit — kebab-case",
  "proposedSkillDescription": "string or omit",
  "keySteps": ["string array or omit"],
  "reasoning": "string — your reasoning",
  "shouldCrystallize": boolean
}`
}

// ── Core reflection logic ────────────────────────────────────────────

/**
 * Run structured reflection on a completed task.
 *
 * Calls the LLM to evaluate novelty and generalizability of the task's
 * solution approach, compared against the existing skill catalog.
 *
 * @param taskSummary - Description of the completed task and its solution
 * @param existingSkills - Current skill catalog for novelty comparison
 * @param llm - Language model instance to use for reflection
 * @returns Result containing a validated ReflectionRecord or a descriptive error
 */
export async function reflect(
  taskSummary: string,
  existingSkills: SkillCatalogEntry[],
  llm: LanguageModel,
): Promise<Result<ReflectionRecord>> {
  const prompt = buildReflectionPrompt(taskSummary, existingSkills)

  const llmResult = await generateResponse(llm, [{ role: 'user', content: prompt }], {
    temperature: 0.2,
    maxTokens: 1024,
  })

  if (!llmResult.ok) {
    return err(new Error(`Reflection LLM call failed: ${llmResult.error.message}`))
  }

  const rawText = llmResult.value.text.trim()

  // Try to parse JSON from the response, handling possible markdown fences
  let jsonText = rawText
  const fenceMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return err(
      new Error(
        `Failed to parse reflection response as JSON: ${rawText.slice(0, 200)}${rawText.length > 200 ? '...' : ''}`,
      ),
    )
  }

  const validation = ReflectionRecordSchema.safeParse(parsed)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return err(new Error(`Reflection response failed schema validation: ${issues}`))
  }

  return ok(validation.data)
}

// ── Crystallization decision ─────────────────────────────────────────

/**
 * Determine whether a reflection record warrants crystallization into a skill.
 *
 * Returns true when both novelty and generalizability exceed the threshold.
 *
 * @param record - The reflection record to evaluate
 * @param threshold - Minimum score (0-1) for both dimensions (default: 0.7)
 */
export function shouldCrystallize(record: ReflectionRecord, threshold: number): boolean {
  return record.novelty > threshold && record.generalizability > threshold
}
