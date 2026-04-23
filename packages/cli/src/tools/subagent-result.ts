import { z } from 'zod'

export const subAgentEvidenceSchema = z.union([
  z
    .object({
      type: z.literal('file'),
      path: z.string().trim().min(1),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      excerpt: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      command: z.string().trim().min(1),
      excerpt: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      excerpt: z.string().trim().min(1),
      command: z.string().trim().min(1).optional(),
    })
    .strict(),
])

export const subAgentClaimSchema = z
  .object({
    claim: z.string().trim().min(1),
    evidence: z.array(subAgentEvidenceSchema).min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export const reviewFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])

export const reviewFindingSchema = z
  .object({
    title: z.string().trim().min(1),
    severity: reviewFindingSeveritySchema,
    file: z.string().trim().min(1).optional(),
    line: z.number().int().positive().optional(),
    body: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    evidence: z.array(subAgentEvidenceSchema),
  })
  .strict()

export const testCommandResultSchema = z
  .object({
    command: z.string().trim().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    outputExcerpt: z.string(),
    status: z.enum(['passed', 'failed']),
  })
  .strict()

export const subAgentResultSchema = z
  .object({
    summary: z.string().trim().min(1),
    claims: z.array(subAgentClaimSchema),
    reviewFindings: z.array(reviewFindingSchema).optional(),
    testResults: z.array(testCommandResultSchema).optional(),
    uncertainty: z.array(z.string().trim().min(1)),
    suggestedNextSteps: z.array(z.string().trim().min(1)),
  })
  .strict()

export type SubAgentResult = z.infer<typeof subAgentResultSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type TestCommandResult = z.infer<typeof testCommandResultSchema>

export interface NormalizedSubAgentResult {
  result: SubAgentResult
  valid: boolean
  warnings: string[]
}

function failureResult(summary: string, warnings: string[]): NormalizedSubAgentResult {
  return {
    valid: false,
    warnings,
    result: {
      summary,
      claims: [],
      uncertainty: warnings,
      suggestedNextSteps: [
        'Review the child transcript or rerun the subagent with stricter output instructions.',
      ],
    },
  }
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (!fenced) throw new Error('Child output was not valid JSON.')
    return JSON.parse(fenced[1])
  }
}

export function validateSubAgentResult(value: unknown): SubAgentResult {
  return subAgentResultSchema.parse(value)
}

export function normalizeSubAgentOutput(text: string): NormalizedSubAgentResult {
  if (text.trim().length === 0) {
    return failureResult('Child agent returned no output.', ['Child output was empty.'])
  }

  let parsed: unknown
  try {
    parsed = parseJsonObject(text)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return failureResult('Child agent returned unstructured output.', [message])
  }

  const result = subAgentResultSchema.safeParse(parsed)
  if (result.success) {
    return {
      valid: true,
      warnings: [],
      result: result.data,
    }
  }

  return failureResult(
    'Child agent returned malformed structured output.',
    result.error.issues.map((issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`),
  )
}
