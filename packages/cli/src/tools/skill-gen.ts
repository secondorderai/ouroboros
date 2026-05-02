/**
 * Skill Generation Tool
 *
 * Generates a complete skill directory from a ReflectionRecord.
 * This is the agent-facing tool that wraps the RSI crystallize module.
 *
 * Follows the tool registry interface: name, description, schema (Zod), execute.
 * Uses dependency injection for the LLM and base path.
 */
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { type Result, ok, err } from '@src/types'
import { type ReflectionRecord, generateSkill, writeSkillToStaging } from '@src/rsi/crystallize'

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'skill-gen'

export const description =
  'Generate a new skill from a reflection record. Takes a structured reflection ' +
  '(from the reflect tool) and produces a complete skill directory in skills/staging/ ' +
  'with SKILL.md and test script. Only operates on reflections marked shouldCrystallize: true.'

export const schema = z.object({
  reflectionRecord: z
    .object({
      taskSummary: z.string().describe('Brief summary of the original task'),
      novelty: z.number().min(0).max(1).describe('Novelty score 0-1'),
      generalizability: z.number().min(0).max(1).describe('Generalizability score 0-1'),
      proposedSkillName: z.string().optional().describe('Proposed kebab-case skill name'),
      proposedSkillDescription: z.string().optional().describe('What the skill would do'),
      keySteps: z.array(z.string()).optional().describe('Ordered list of key solution steps'),
      reasoning: z.string().describe('Why the solution is worth crystallizing'),
      shouldCrystallize: z.boolean().describe('Whether this solution warrants crystallization'),
    })
    .describe('The reflection record from ReflectTool'),
  taskTranscript: z
    .string()
    .optional()
    .describe('Optional conversation transcript for richer context'),
})

export type SkillGenInput = z.infer<typeof schema>
export type SkillGenResult = { path: string; skillName: string }

/** Dependencies injected at tool registration time */
export interface SkillGenToolDeps {
  llm: LanguageModel
  basePath?: string
}

/**
 * Create the execute function with injected dependencies.
 * The LLM is required; basePath defaults to process.cwd().
 */
export function createExecute(deps: SkillGenToolDeps) {
  return async (input: SkillGenInput): Promise<Result<SkillGenResult>> => {
    const record: ReflectionRecord = input.reflectionRecord
    const transcript = input.taskTranscript
    const basePath = deps.basePath ?? process.cwd()

    // 1. Generate skill via LLM
    const genResult = await generateSkill(record, transcript, deps.llm, basePath)
    if (!genResult.ok) return genResult as Result<never>

    // 2. Write to staging
    const writeResult = await writeSkillToStaging(genResult.value, basePath)
    if (!writeResult.ok) return writeResult as Result<never>

    return ok({
      path: writeResult.value,
      skillName: genResult.value.name,
    })
  }
}

/**
 * Default execute function — returns an error because the LLM dependency
 * must be injected at registration time via createExecute().
 *
 * This placeholder satisfies the ToolDefinition interface so the module
 * can be imported by the registry's static BUILTIN_TOOLS list. In
 * production, the agent startup code replaces this with a properly
 * configured version via createExecute().
 */
export const execute = async (): Promise<Result<SkillGenResult>> => {
  return err(
    new Error(
      'skill-gen tool requires LLM dependency injection. ' +
        'Use createExecute({ llm }) to create a configured instance.',
    ),
  )
}
export const tier = 2
