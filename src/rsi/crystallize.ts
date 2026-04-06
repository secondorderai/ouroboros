/**
 * Skill Crystallization Pipeline
 *
 * Orchestrates the full RSI crystallization flow:
 *   Reflect -> Generate -> Validate -> Test -> Promote
 *
 * This is the primary recursive self-improvement mechanism. When the pipeline
 * runs successfully, the agent gains a new skill it can use on future tasks.
 */
import { z } from 'zod'
import { generateText, type LanguageModel } from 'ai'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { type Result, ok, err } from '@src/types'
import { runSkillTests, type SkillTestResult } from '@src/rsi/validate'
import { spawn } from 'node:child_process'

// ── Reflection types ──────────────────────────────────────────────────

/** Zod schema for a reflection record produced by the LLM. */
export const ReflectionRecordSchema = z.object({
  taskSummary: z.string().describe('Brief summary of the completed task'),
  novelty: z.number().min(0).max(1).describe('How novel/reusable this task pattern is (0-1)'),
  skillName: z.string().describe('Proposed kebab-case name for the skill'),
  skillDescription: z.string().describe('One-line description of what the skill does'),
  keyInsights: z.array(z.string()).describe('Key insights or patterns discovered'),
  suggestedApproach: z.string().describe('How to approach similar tasks in the future'),
})

export type ReflectionRecord = z.infer<typeof ReflectionRecordSchema>

// ── Skill types ───────────────────────────────────────────────────────

/** Parsed frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, unknown>
}

/** A generated skill ready to be written to disk. */
export interface GeneratedSkill {
  frontmatter: SkillFrontmatter
  body: string
  testScript?: string
  additionalFiles?: Array<{ path: string; content: string }>
}

// ── Crystallization result ────────────────────────────────────────────

export interface CrystallizationResult {
  outcome: 'no-crystallization' | 'generated' | 'test-failed' | 'promoted'
  reflection?: ReflectionRecord
  skillName?: string
  skillPath?: string
  testResult?: SkillTestResult
  commitHash?: string
}

// ── Reflection ────────────────────────────────────────────────────────

const REFLECT_PROMPT = `You are an AI agent analyzing a completed task for reusable patterns.

Given a task summary (and optionally its transcript), produce a JSON object with exactly these fields:
- taskSummary: Brief summary of the task
- novelty: Number from 0 to 1 indicating how novel and reusable this pattern is. 0 = routine/trivial, 1 = highly novel and worth crystallizing into a reusable skill.
- skillName: A proposed kebab-case name for the skill (lowercase, hyphens only, max 64 chars)
- skillDescription: A one-line description of what the skill would do (max 1024 chars)
- keyInsights: Array of key insights or patterns discovered
- suggestedApproach: How to approach similar tasks in the future

Respond with ONLY the JSON object, no markdown fences or extra text.`

/**
 * Call the LLM to reflect on a completed task and produce a ReflectionRecord.
 */
export async function reflect(
  taskSummary: string,
  llm: LanguageModel,
  transcript?: string,
): Promise<Result<ReflectionRecord>> {
  const userContent = transcript
    ? `Task summary:\n${taskSummary}\n\nTranscript:\n${transcript}`
    : `Task summary:\n${taskSummary}`

  try {
    const result = await generateText({
      model: llm,
      system: REFLECT_PROMPT,
      prompt: userContent,
      temperature: 0.3,
    })

    const parsed = safeJsonParse(result.text)
    if (!parsed.ok) {
      return err(new Error(`Failed to parse reflection JSON: ${parsed.error.message}`))
    }

    const validated = ReflectionRecordSchema.safeParse(parsed.value)
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      return err(new Error(`Invalid reflection record: ${issues}`))
    }

    return ok(validated.data)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Reflection LLM call failed: ${message}`))
  }
}

/**
 * Determine whether a reflection warrants crystallization.
 */
export function shouldCrystallize(reflection: ReflectionRecord, threshold: number = 0.7): boolean {
  return reflection.novelty >= threshold
}

// ── Skill generation ──────────────────────────────────────────────────

/**
 * Build the prompt for skill generation.
 */
export function buildGenerationPrompt(reflection: ReflectionRecord): string {
  return `You are an AI agent generating a reusable skill in the agentskills.io format.

Based on this reflection, generate a complete skill:

Skill name: ${reflection.skillName}
Description: ${reflection.skillDescription}
Key insights:
${reflection.keyInsights.map((i) => `- ${i}`).join('\n')}
Suggested approach: ${reflection.suggestedApproach}

Respond with a JSON object containing:
- frontmatter: An object with "name" (kebab-case), "description" (1-line), and optionally "license", "compatibility", "metadata"
- body: The full markdown body of the SKILL.md (instructions, examples, etc.)
- testScript: A test script (TypeScript for bun) that validates the skill works. It should be a simple smoke test that exits 0 on success, non-zero on failure.

Respond with ONLY the JSON object, no markdown fences or extra text.`
}

/**
 * Call the LLM to generate a skill from a reflection record.
 */
export async function generateSkill(
  reflection: ReflectionRecord,
  llm: LanguageModel,
): Promise<Result<GeneratedSkill>> {
  const prompt = buildGenerationPrompt(reflection)

  try {
    const result = await generateText({
      model: llm,
      prompt,
      temperature: 0.4,
    })

    const parsed = parseSkillResponse(result.text)
    if (!parsed.ok) {
      return err(parsed.error)
    }

    return ok(parsed.value)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Skill generation LLM call failed: ${message}`))
  }
}

/**
 * Parse the LLM's skill generation response into a GeneratedSkill.
 */
export function parseSkillResponse(text: string): Result<GeneratedSkill> {
  const jsonResult = safeJsonParse(text)
  if (!jsonResult.ok) {
    return err(new Error(`Failed to parse skill JSON: ${jsonResult.error.message}`))
  }

  const data = jsonResult.value as Record<string, unknown>

  if (!data.frontmatter || typeof data.frontmatter !== 'object') {
    return err(new Error('Skill response missing "frontmatter" object'))
  }

  const fm = data.frontmatter as Record<string, unknown>

  if (typeof fm.name !== 'string' || fm.name.trim() === '') {
    return err(new Error('Skill frontmatter missing required "name" field'))
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    return err(new Error('Skill frontmatter missing required "description" field'))
  }

  if (typeof data.body !== 'string') {
    return err(new Error('Skill response missing "body" string'))
  }

  const frontmatter: SkillFrontmatter = {
    name: fm.name,
    description: fm.description,
    license: typeof fm.license === 'string' ? fm.license : undefined,
    compatibility: typeof fm.compatibility === 'string' ? fm.compatibility : undefined,
    metadata:
      typeof fm.metadata === 'object' && fm.metadata != null
        ? (fm.metadata as Record<string, unknown>)
        : undefined,
  }

  return ok({
    frontmatter,
    body: data.body as string,
    testScript: typeof data.testScript === 'string' ? data.testScript : undefined,
    additionalFiles: Array.isArray(data.additionalFiles)
      ? (data.additionalFiles as Array<{ path: string; content: string }>)
      : undefined,
  })
}

// ── Validation helpers ────────────────────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * Validate that a skill name is kebab-case and within length limits.
 */
export function validateSkillName(name: string): Result<string> {
  if (name.length === 0) {
    return err(new Error('Skill name must not be empty'))
  }
  if (name.length > 64) {
    return err(new Error(`Skill name must be <= 64 characters, got ${name.length}`))
  }
  if (!KEBAB_CASE_RE.test(name)) {
    return err(new Error(`Skill name must be kebab-case, got "${name}"`))
  }
  return ok(name)
}

/**
 * Check that no skill with the given name already exists in the generated directory.
 */
export function checkNameUniqueness(name: string, generatedDir: string): Result<string> {
  const targetDir = join(generatedDir, name)
  if (existsSync(targetDir)) {
    return err(
      new Error(`Skill "${name}" already exists in ${generatedDir}. Cannot promote a duplicate.`),
    )
  }
  return ok(name)
}

/**
 * Validate frontmatter fields against agentskills.io requirements.
 */
export function validateFrontmatter(fm: SkillFrontmatter): Result<SkillFrontmatter> {
  // Name validation
  const nameResult = validateSkillName(fm.name)
  if (!nameResult.ok) {
    return err(nameResult.error)
  }

  // Description validation
  if (!fm.description || fm.description.trim() === '') {
    return err(new Error('Skill description must not be empty'))
  }
  if (fm.description.length > 1024) {
    return err(
      new Error(`Skill description must be <= 1024 characters, got ${fm.description.length}`),
    )
  }

  return ok(fm)
}

/**
 * Validate that a SKILL.md file can be parsed cleanly (round-trip check).
 * Writes the content, reads it back, and verifies frontmatter integrity.
 */
export function validateRoundTrip(skillMdContent: string): Result<{
  frontmatter: SkillFrontmatter
  body: string
}> {
  const trimmed = skillMdContent.trimStart()
  if (!trimmed.startsWith('---')) {
    return err(new Error('SKILL.md does not start with --- frontmatter delimiter'))
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return err(new Error('SKILL.md missing closing --- frontmatter delimiter'))
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trim()

  let parsed: unknown
  try {
    parsed = parseYaml(yamlBlock)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to parse YAML frontmatter: ${message}`))
  }

  if (parsed == null || typeof parsed !== 'object') {
    return err(new Error('YAML frontmatter is not an object'))
  }

  const fm = parsed as Record<string, unknown>

  if (typeof fm.name !== 'string' || fm.name.trim() === '') {
    return err(new Error('SKILL.md frontmatter missing required "name" field'))
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    return err(new Error('SKILL.md frontmatter missing required "description" field'))
  }

  const frontmatter: SkillFrontmatter = {
    name: fm.name,
    description: fm.description,
    license: typeof fm.license === 'string' ? fm.license : undefined,
    compatibility: typeof fm.compatibility === 'string' ? fm.compatibility : undefined,
    metadata:
      typeof fm.metadata === 'object' && fm.metadata != null
        ? (fm.metadata as Record<string, unknown>)
        : undefined,
  }

  return ok({ frontmatter, body })
}

// ── Writing to staging ────────────────────────────────────────────────

/**
 * Write a generated skill to the staging directory.
 * Creates the directory structure and all files.
 * If the directory already exists (from a prior failed attempt), it is overwritten.
 */
export function writeSkillToStaging(skill: GeneratedSkill, stagingDir: string): Result<string> {
  const skillDir = join(stagingDir, skill.frontmatter.name)

  // Overwrite if exists (idempotent for retries)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
  }

  try {
    mkdirSync(skillDir, { recursive: true })

    // Build SKILL.md content
    const yamlContent = stringifyYaml({
      name: skill.frontmatter.name,
      description: skill.frontmatter.description,
      ...(skill.frontmatter.license ? { license: skill.frontmatter.license } : {}),
      ...(skill.frontmatter.compatibility
        ? { compatibility: skill.frontmatter.compatibility }
        : {}),
      ...(skill.frontmatter.metadata ? { metadata: skill.frontmatter.metadata } : {}),
    }).trim()

    const skillMdContent = `---\n${yamlContent}\n---\n\n${skill.body}`
    writeFileSync(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8')

    // Write test script if provided
    if (skill.testScript) {
      const scriptsDir = join(skillDir, 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      writeFileSync(join(scriptsDir, 'test.ts'), skill.testScript, 'utf-8')
    }

    // Write additional files if provided
    if (skill.additionalFiles) {
      for (const file of skill.additionalFiles) {
        const filePath = join(skillDir, file.path)
        const fileDir = join(filePath, '..')
        mkdirSync(fileDir, { recursive: true })
        writeFileSync(filePath, file.content, 'utf-8')
      }
    }

    return ok(skillDir)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write skill to staging: ${message}`))
  }
}

// ── Git helpers ───────────────────────────────────────────────────────

function gitExec(args: string[], cwd: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      resolve(err(new Error(`Git command failed: ${error.message}`)))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(ok(stdout.trim()))
      } else {
        resolve(err(new Error(`Git command failed (exit ${code}): ${stderr.trim()}`)))
      }
    })
  })
}

// ── Pipeline ──────────────────────────────────────────────────────────

export interface CrystallizeOptions {
  transcript?: string
  llm: LanguageModel
  skillDirs: { staging: string; generated: string; core: string }
  autoCommit?: boolean
  noveltyThreshold?: number
}

/**
 * Orchestrate the full crystallization pipeline:
 *   1. Reflect — Analyze the task for reusable patterns
 *   2. Generate — Produce a skill directory
 *   3. Validate — Check SKILL.md against requirements
 *   4. Test — Run skill tests
 *   5. Promote — Move to generated/ and git commit
 *
 * If any stage fails, the pipeline stops and reports the failure.
 */
export async function crystallize(
  taskSummary: string,
  options: CrystallizeOptions,
): Promise<Result<CrystallizationResult>> {
  const { transcript, llm, skillDirs, autoCommit = true, noveltyThreshold = 0.7 } = options

  // ── Stage 1: Reflect ────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 1/5: Reflecting on task...\n')

  const reflectResult = await reflect(taskSummary, llm, transcript)
  if (!reflectResult.ok) {
    return err(new Error(`[reflect] ${reflectResult.error.message}`))
  }

  const reflection = reflectResult.value

  if (!shouldCrystallize(reflection, noveltyThreshold)) {
    process.stderr.write(
      `[crystallize] Novelty ${reflection.novelty} below threshold ${noveltyThreshold}. No crystallization.\n`,
    )
    return ok({
      outcome: 'no-crystallization',
      reflection,
    })
  }

  process.stderr.write(
    `[crystallize] Novelty ${reflection.novelty} >= ${noveltyThreshold}. Proceeding.\n`,
  )

  // ── Stage 2: Generate ───────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 2/5: Generating skill...\n')

  // Check for name collision in generated directory before generating
  const uniqueResult = checkNameUniqueness(reflection.skillName, skillDirs.generated)
  if (!uniqueResult.ok) {
    return err(new Error(`[generate] ${uniqueResult.error.message}`))
  }

  const genResult = await generateSkill(reflection, llm)
  if (!genResult.ok) {
    return err(new Error(`[generate] ${genResult.error.message}`))
  }

  const skill = genResult.value

  // Write to staging
  const writeResult = writeSkillToStaging(skill, skillDirs.staging)
  if (!writeResult.ok) {
    return err(new Error(`[generate] ${writeResult.error.message}`))
  }

  const stagingPath = writeResult.value

  process.stderr.write(`[crystallize] Skill written to ${stagingPath}\n`)

  // ── Stage 3: Validate ───────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 3/5: Validating skill...\n')

  // Validate frontmatter
  const fmResult = validateFrontmatter(skill.frontmatter)
  if (!fmResult.ok) {
    return err(new Error(`[validate] ${fmResult.error.message}`))
  }

  // Validate SKILL.md round-trip
  const skillMdPath = join(stagingPath, 'SKILL.md')
  let skillMdContent: string
  try {
    skillMdContent = readFileSync(skillMdPath, 'utf-8')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`[validate] Could not read SKILL.md: ${message}`))
  }

  const rtResult = validateRoundTrip(skillMdContent)
  if (!rtResult.ok) {
    return err(new Error(`[validate] ${rtResult.error.message}`))
  }

  // Validate test file exists
  const scriptsDir = join(stagingPath, 'scripts')
  if (!existsSync(scriptsDir) || readdirSync(scriptsDir).length === 0) {
    return err(new Error('[validate] No test files found in scripts/ directory'))
  }

  process.stderr.write('[crystallize] Validation passed.\n')

  // ── Stage 4: Test ───────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 4/5: Running tests...\n')

  const testResult = await runSkillTests(skill.frontmatter.name, stagingPath)
  if (!testResult.ok) {
    return err(new Error(`[test] ${testResult.error.message}`))
  }

  if (!testResult.value.passed) {
    process.stderr.write(`[crystallize] Tests failed. Skill remains in staging at ${stagingPath}\n`)
    return ok({
      outcome: 'test-failed',
      reflection,
      skillName: skill.frontmatter.name,
      skillPath: stagingPath,
      testResult: testResult.value,
    })
  }

  process.stderr.write('[crystallize] Tests passed.\n')

  // ── Stage 5: Promote ────────────────────────────────────────────────
  process.stderr.write('[crystallize] Stage 5/5: Promoting skill...\n')

  const generatedPath = join(skillDirs.generated, skill.frontmatter.name)

  try {
    mkdirSync(skillDirs.generated, { recursive: true })
    cpSync(stagingPath, generatedPath, { recursive: true })
    rmSync(stagingPath, { recursive: true, force: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`[promote] Failed to move skill to generated: ${message}`))
  }

  process.stderr.write(`[crystallize] Skill promoted to ${generatedPath}\n`)

  // Git commit if autoCommit is enabled
  let commitHash: string | undefined
  if (autoCommit) {
    const cwd = join(skillDirs.generated, '..')
    const addResult = await gitExec(['add', generatedPath], cwd)
    if (addResult.ok) {
      const commitMsg = `rsi: crystallize skill '${skill.frontmatter.name}' — ${skill.frontmatter.description}`
      const commitResult = await gitExec(['commit', '-m', commitMsg], cwd)
      if (commitResult.ok) {
        const hashResult = await gitExec(['rev-parse', 'HEAD'], cwd)
        if (hashResult.ok) {
          commitHash = hashResult.value
        }
        process.stderr.write(`[crystallize] Git commit: ${commitHash ?? '(hash unavailable)'}\n`)
      } else {
        // Git commit failure does not roll back the file move
        process.stderr.write(
          `[crystallize] Warning: Git commit failed: ${commitResult.error.message}\n`,
        )
      }
    } else {
      process.stderr.write(`[crystallize] Warning: Git add failed: ${addResult.error.message}\n`)
    }
  }

  return ok({
    outcome: 'promoted',
    reflection,
    skillName: skill.frontmatter.name,
    skillPath: generatedPath,
    testResult: testResult.value,
    commitHash,
  })
}

// ── Utility helpers ───────────────────────────────────────────────────

function safeJsonParse(text: string): Result<unknown> {
  // Strip markdown code fences if present
  let cleaned = text.trim()
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7)
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3)
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3)
  }
  cleaned = cleaned.trim()

  try {
    return ok(JSON.parse(cleaned))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(message))
  }
}
