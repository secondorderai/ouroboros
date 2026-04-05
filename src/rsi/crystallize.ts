/**
 * RSI Crystallize Module
 *
 * Transforms structured reflection records into portable, testable skills
 * conforming to the agentskills.io spec. This is the generative core of
 * the RSI engine.
 *
 * Public API:
 *   - generateSkill()       — LLM-powered skill generation from a ReflectionRecord
 *   - writeSkillToStaging()  — writes a GeneratedSkill to disk with validation
 *   - parseSkillResponse()   — extracts skill components from raw LLM output
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { LanguageModel } from 'ai'
import { type Result, ok, err } from '@src/types'
import { generateResponse } from '@src/llm/streaming'

// ── Types ─────────────────────────────────────────────────────────────

/**
 * A structured reflection produced by ReflectTool (ticket 01).
 * Defined here so this module compiles independently; ticket 01 will
 * re-export or extend this type.
 */
export interface ReflectionRecord {
  /** Brief summary of the original task */
  taskSummary: string
  /** Ordered list of key steps in the solution */
  keySteps: string[]
  /** Whether this solution is novel enough to warrant crystallization */
  shouldCrystallize: boolean
  /** Proposed kebab-case skill name */
  proposedSkillName: string
  /** Generalizability score 0-1 */
  generalizability: number
  /** Why the solution is (or isn't) worth crystallizing */
  reasoning: string
}

/**
 * Skill frontmatter conforming to agentskills.io spec.
 */
export interface SkillFrontmatter {
  name: string
  description: string
  license: string
  metadata: {
    author: string
    version: string
    generated: string
    confidence: number
    source_task: string
  }
}

/**
 * A fully generated skill ready to be written to disk.
 */
export interface GeneratedSkill {
  /** Kebab-case skill name */
  name: string
  /** YAML frontmatter object */
  frontmatter: SkillFrontmatter
  /** Markdown body (instructions) */
  body: string
  /** TypeScript test script content */
  testScript: string
}

// ── Validation helpers ────────────────────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * Validate that a skill name is lowercase kebab-case and at most 64 chars.
 */
export function validateSkillName(name: string): Result<string> {
  if (name.length === 0) {
    return err(new Error('Skill name cannot be empty'))
  }
  if (name.length > 64) {
    return err(new Error(`Skill name exceeds 64 characters: "${name}"`))
  }
  if (!KEBAB_CASE_RE.test(name)) {
    return err(new Error(`Skill name must be lowercase kebab-case: "${name}"`))
  }
  return ok(name)
}

/**
 * Check that a skill name is not already taken in any of the skill directories.
 */
export function checkNameUniqueness(name: string, basePath: string): Result<true> {
  const dirs = ['skills/core', 'skills/generated', 'skills/staging']
  for (const dir of dirs) {
    const fullPath = join(basePath, dir, name)
    if (existsSync(fullPath)) {
      return err(
        new Error(`Skill name "${name}" already exists in ${dir}/. Choose a different name.`),
      )
    }
  }
  return ok(true as const)
}

/**
 * Validate that frontmatter has all required agentskills.io fields.
 */
export function validateFrontmatter(fm: SkillFrontmatter): Result<true> {
  if (!fm.name || fm.name.trim() === '') {
    return err(new Error('Frontmatter missing required "name" field'))
  }
  if (!fm.description || fm.description.trim() === '') {
    return err(new Error('Frontmatter missing required "description" field'))
  }
  if (fm.description.length > 1024) {
    return err(
      new Error(`Frontmatter "description" exceeds 1024 characters (${fm.description.length})`),
    )
  }
  if (!fm.license) {
    return err(new Error('Frontmatter missing required "license" field'))
  }
  if (!fm.metadata?.author) {
    return err(new Error('Frontmatter missing required "metadata.author" field'))
  }
  if (!fm.metadata?.version) {
    return err(new Error('Frontmatter missing required "metadata.version" field'))
  }
  return ok(true as const)
}

/**
 * Verify that a SKILL.md string can be round-tripped (parse frontmatter + body).
 */
export function validateRoundTrip(skillMdContent: string): Result<true> {
  const trimmed = skillMdContent.trimStart()
  if (!trimmed.startsWith('---')) {
    return err(new Error('SKILL.md does not start with --- frontmatter delimiter'))
  }
  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return err(new Error('SKILL.md missing closing --- frontmatter delimiter'))
  }
  const yamlBlock = trimmed.slice(3, endIndex).trim()
  try {
    const parsed = parseYaml(yamlBlock)
    if (parsed == null || typeof parsed !== 'object') {
      return err(new Error('YAML frontmatter is not an object'))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to parse YAML frontmatter: ${message}`))
  }
  return ok(true as const)
}

// ── Prompt construction ───────────────────────────────────────────────

/**
 * Load example skills from skills/core/ for prompt exemplars.
 * Returns up to 2 examples, or empty string if none exist.
 */
function loadExampleSkills(basePath: string): string {
  const coreDir = join(basePath, 'skills', 'core')
  if (!existsSync(coreDir)) return ''

  let entries: string[]
  try {
    entries = readdirSync(coreDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return ''
  }

  const examples: string[] = []
  for (const entry of entries.slice(0, 2)) {
    const skillMdPath = join(coreDir, entry, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        examples.push(`### Example: ${entry}\n\`\`\`markdown\n${content}\n\`\`\``)
      } catch {
        // Skip unreadable files
      }
    }
  }

  return examples.length > 0 ? `\n## Example SKILL.md files\n\n${examples.join('\n\n')}\n` : ''
}

/**
 * Build the LLM prompt for skill generation.
 */
export function buildGenerationPrompt(
  record: ReflectionRecord,
  transcript: string | undefined,
  basePath: string,
): string {
  const exampleSkills = loadExampleSkills(basePath)

  return `You are a skill generator for the Ouroboros RSI engine. Your job is to transform a structured reflection record into a complete, portable skill conforming to the agentskills.io spec.

## Reflection Record

- **Task Summary:** ${record.taskSummary}
- **Key Steps:**
${record.keySteps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}
- **Proposed Skill Name:** ${record.proposedSkillName}
- **Generalizability:** ${record.generalizability}
- **Reasoning:** ${record.reasoning}
${transcript ? `\n## Task Transcript (for additional context)\n\n${transcript}\n` : ''}
${exampleSkills}
## Your Task

Generate THREE outputs, each in a fenced code block with a specific label. Follow this EXACT format:

### DESCRIPTION

Write a skill description (max 1024 chars) optimized for LLM-based routing. The description MUST answer:
1. "What does this skill do?" — be specific about the capability
2. "When should this skill be activated?" — describe trigger conditions in concrete, pattern-oriented language

Do NOT be vague (e.g., "helps with coding"). DO be specific (e.g., "Generates pagination logic for REST APIs when the user needs to implement cursor-based or offset-based pagination over database query results").

\`\`\`description
[Your description here — plain text, no markdown, max 1024 chars]
\`\`\`

### SKILL.md Body

Write the markdown body (everything AFTER the frontmatter). Include:
- Step-by-step instructions derived from the key steps
- Input/output examples where helpful
- Edge case handling
- The body must be self-contained — an agent reading only this skill should be able to apply it

\`\`\`markdown
[Your markdown body here]
\`\`\`

### Test Script

Write a Bun test file (\`scripts/test.ts\`) that validates the skill's core behavior:
- Import from \`bun:test\`: \`import { describe, it, expect } from 'bun:test'\`
- Include at least one positive test case
- Include at least one edge case test
- Tests should validate the patterns/logic described in the skill, not the SKILL.md file itself

\`\`\`typescript
[Your test script here]
\`\`\`

Generate all three outputs now.`
}

// ── LLM output parsing ───────────────────────────────────────────────

/**
 * Extract content from a labeled fenced code block.
 * Looks for ```<label>\n...\n``` pattern.
 */
function extractBlock(text: string, label: string): string | undefined {
  // Match ```label ... ``` with possible whitespace
  const pattern = new RegExp('```' + label + '\\s*\\n([\\s\\S]*?)\\n\\s*```', 'i')
  const match = text.match(pattern)
  return match ? match[1].trim() : undefined
}

/**
 * Parse raw LLM output into skill components.
 * Expects three labeled fenced code blocks: description, markdown, typescript.
 */
export function parseSkillResponse(
  llmOutput: string,
  record: ReflectionRecord,
): Result<GeneratedSkill> {
  const description = extractBlock(llmOutput, 'description')
  if (!description) {
    return err(
      new Error('LLM output missing ```description``` block. Cannot extract skill description.'),
    )
  }

  const body = extractBlock(llmOutput, 'markdown')
  if (!body) {
    return err(new Error('LLM output missing ```markdown``` block. Cannot extract skill body.'))
  }

  const testScript = extractBlock(llmOutput, 'typescript')
  if (!testScript) {
    return err(new Error('LLM output missing ```typescript``` block. Cannot extract test script.'))
  }

  // Validate description length
  if (description.length > 1024) {
    return err(
      new Error(
        `Generated description exceeds 1024 characters (${description.length}). Ask the LLM to be more concise.`,
      ),
    )
  }

  const frontmatter: SkillFrontmatter = {
    name: record.proposedSkillName,
    description,
    license: 'Apache-2.0',
    metadata: {
      author: 'ouroboros-rsi',
      version: '1.0',
      generated: 'true',
      confidence: record.generalizability,
      source_task: record.taskSummary,
    },
  }

  const fmValidation = validateFrontmatter(frontmatter)
  if (!fmValidation.ok) return fmValidation as Result<never>

  return ok({
    name: record.proposedSkillName,
    frontmatter,
    body,
    testScript,
  })
}

// ── Core API ─────────────────────────────────────────────────────────

/**
 * Generate a skill from a reflection record using an LLM.
 *
 * @param record     - The reflection record (must have shouldCrystallize: true)
 * @param transcript - Optional task transcript for richer context
 * @param llm        - The language model to use for generation
 * @param basePath   - Project root for loading example skills (defaults to cwd)
 * @returns Result containing the generated skill or an error
 */
export async function generateSkill(
  record: ReflectionRecord,
  transcript: string | undefined,
  llm: LanguageModel,
  basePath?: string,
): Promise<Result<GeneratedSkill>> {
  // 1. Validate reflection record
  if (!record.shouldCrystallize) {
    return err(
      new Error(
        'Reflection record has shouldCrystallize: false. ' +
          'Only crystallizable reflections can be turned into skills.',
      ),
    )
  }

  // 2. Validate skill name format
  const nameResult = validateSkillName(record.proposedSkillName)
  if (!nameResult.ok) return nameResult as Result<never>

  const resolvedBase = basePath ?? process.cwd()

  // 3. Build generation prompt
  const prompt = buildGenerationPrompt(record, transcript, resolvedBase)

  // 4. Call the LLM
  const llmResult = await generateResponse(llm, [{ role: 'user', content: prompt }], {
    temperature: 0.7,
    maxTokens: 4096,
  })

  if (!llmResult.ok) {
    return err(new Error(`LLM generation failed: ${llmResult.error.message}`))
  }

  const llmOutput = llmResult.value.text
  if (!llmOutput || llmOutput.trim() === '') {
    return err(new Error('LLM returned empty output'))
  }

  // 5. Parse LLM output into skill components
  return parseSkillResponse(llmOutput, record)
}

/**
 * Write a generated skill to the staging directory.
 *
 * Validates name uniqueness and frontmatter before writing.
 * Creates: skills/staging/<name>/SKILL.md and skills/staging/<name>/scripts/test.ts
 *
 * @param skill      - The generated skill to write
 * @param basePath   - Project root (skills/staging/ is resolved relative to this)
 * @returns Result containing the absolute path to the skill directory or an error
 */
export async function writeSkillToStaging(
  skill: GeneratedSkill,
  basePath: string,
): Promise<Result<string>> {
  // 1. Validate skill name
  const nameResult = validateSkillName(skill.name)
  if (!nameResult.ok) return nameResult as Result<never>

  // 2. Check uniqueness
  const uniqueResult = checkNameUniqueness(skill.name, basePath)
  if (!uniqueResult.ok) return uniqueResult as Result<never>

  // 3. Validate frontmatter
  const fmResult = validateFrontmatter(skill.frontmatter)
  if (!fmResult.ok) return fmResult as Result<never>

  // 4. Build SKILL.md content
  const yamlContent = stringifyYaml(skill.frontmatter as unknown as Record<string, unknown>)
  const skillMdContent = `---\n${yamlContent}---\n\n${skill.body}\n`

  // 5. Validate round-trip
  const rtResult = validateRoundTrip(skillMdContent)
  if (!rtResult.ok) return rtResult as Result<never>

  // 6. Write files
  const stagingDir = join(basePath, 'skills', 'staging', skill.name)
  const scriptsDir = join(stagingDir, 'scripts')

  try {
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(stagingDir, 'SKILL.md'), skillMdContent, 'utf-8')
    writeFileSync(join(scriptsDir, 'test.ts'), skill.testScript, 'utf-8')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write skill files: ${message}`))
  }

  return ok(stagingDir)
}
