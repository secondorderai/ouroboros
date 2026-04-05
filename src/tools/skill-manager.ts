/**
 * Skill Manager Tool
 *
 * Discovers skills from configured directories, parses SKILL.md frontmatter,
 * builds a catalog for system prompt injection, and loads/unloads full skill
 * instructions on demand (progressive disclosure).
 *
 * Follows the agentskills.io spec: metadata is always loaded, but full
 * instructions are loaded only when the LLM activates a skill.
 */
import { z } from 'zod'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

// ── Types ─────────────────────────────────────────────────────────────

/** Status derived from which directory a skill lives in. */
export type SkillStatus = 'core' | 'staging' | 'generated'

/** Parsed frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, unknown>
}

/** A discovered skill with its metadata and runtime state. */
export interface SkillEntry {
  /** Skill name from frontmatter. */
  name: string
  /** Short description from frontmatter. */
  description: string
  /** Derived from directory path (core, staging, generated). */
  status: SkillStatus
  /** Full parsed frontmatter. */
  frontmatter: SkillFrontmatter
  /** Absolute path to the skill directory. */
  dirPath: string
  /** Whether the skill's full instructions are currently loaded. */
  active: boolean
}

/** Catalog entry returned for system prompt injection. */
export interface SkillCatalogEntry {
  name: string
  description: string
  status: SkillStatus
}

/** Result of activating a skill. */
export interface SkillActivationResult {
  name: string
  instructions: string
  references: string[]
}

// ── Internal state ────────────────────────────────────────────────────

let skills = new Map<string, SkillEntry>()

/** Reset internal state (useful for testing). */
export function _resetSkills(): void {
  skills = new Map()
}

// ── Frontmatter parsing ──────────────────────────────────────────────

/**
 * Parse YAML frontmatter delimited by `---` from a markdown string.
 * Returns the parsed frontmatter object and the body (everything after
 * the closing `---`).
 */
function parseFrontmatter(
  content: string,
): Result<{ frontmatter: SkillFrontmatter; body: string }> {
  const trimmed = content.trimStart()
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

  // Validate required fields
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

// ── Status detection ─────────────────────────────────────────────────

/** Derive skill status from the directory path. */
function deriveStatus(dirPath: string): SkillStatus {
  if (dirPath.includes('/staging/') || dirPath.includes('/staging')) {
    return 'staging'
  }
  if (dirPath.includes('/generated/') || dirPath.includes('/generated')) {
    return 'generated'
  }
  return 'core'
}

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Scan configured skill directories for subdirectories containing a SKILL.md file.
 * Invalid or malformed SKILL.md files are skipped with a warning (logged to stderr).
 *
 * @param directories - Directories to scan (relative or absolute paths)
 * @param basePath - Base path for resolving relative directory paths
 */
export function discoverSkills(directories: string[], basePath?: string): void {
  const base = basePath ?? process.cwd()
  skills = new Map()

  for (const dir of directories) {
    const absDir = resolve(base, dir)

    if (!existsSync(absDir)) {
      continue
    }

    let entries: string[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      // Directory not readable — skip silently.
      continue
    }

    for (const entry of entries) {
      const skillDir = join(absDir, entry)
      const skillMdPath = join(skillDir, 'SKILL.md')

      if (!existsSync(skillMdPath)) {
        continue
      }

      let content: string
      try {
        content = readFileSync(skillMdPath, 'utf-8')
      } catch {
        console.warn(`[skill-manager] Warning: Could not read ${skillMdPath}, skipping`)
        continue
      }

      const result = parseFrontmatter(content)
      if (!result.ok) {
        console.warn(`[skill-manager] Warning: ${skillMdPath}: ${result.error.message}, skipping`)
        continue
      }

      const { frontmatter } = result.value
      const status = deriveStatus(absDir)

      skills.set(frontmatter.name, {
        name: frontmatter.name,
        description: frontmatter.description,
        status,
        frontmatter,
        dirPath: skillDir,
        active: false,
      })
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns a clean array of `{ name, description, status }` for system
 * prompt injection. Only metadata — no full instructions.
 */
export function getSkillCatalog(): SkillCatalogEntry[] {
  return Array.from(skills.values()).map((s) => ({
    name: s.name,
    description: s.description,
    status: s.status,
  }))
}

/**
 * Load full SKILL.md body (everything after frontmatter) and return it
 * for injection into the conversation context. Also reads any
 * `references/REFERENCE.md` if the body mentions it.
 */
export function activateSkill(name: string): Result<SkillActivationResult> {
  const skill = skills.get(name)
  if (!skill) {
    return err(new Error(`Skill not found: "${name}"`))
  }

  const skillMdPath = join(skill.dirPath, 'SKILL.md')

  let content: string
  try {
    content = readFileSync(skillMdPath, 'utf-8')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read SKILL.md for "${name}": ${message}`))
  }

  const parsed = parseFrontmatter(content)
  if (!parsed.ok) {
    return err(parsed.error)
  }

  const { body } = parsed.value
  const references: string[] = []

  // Check if body references a REFERENCE.md and load it if present
  const referencePath = join(skill.dirPath, 'references', 'REFERENCE.md')
  if (body.includes('REFERENCE.md') && existsSync(referencePath)) {
    try {
      const refContent = readFileSync(referencePath, 'utf-8')
      references.push(refContent)
    } catch {
      // Reference file not readable — skip, don't crash.
      console.warn(`[skill-manager] Warning: Could not read ${referencePath}`)
    }
  }

  skill.active = true

  return ok({
    name,
    instructions: body,
    references,
  })
}

/**
 * Deactivate a skill — marks it as no longer active so its full
 * instructions can be dropped from context.
 */
export function deactivateSkill(name: string): Result<{ name: string; message: string }> {
  const skill = skills.get(name)
  if (!skill) {
    return err(new Error(`Skill not found: "${name}"`))
  }

  skill.active = false

  return ok({ name, message: `Skill "${name}" deactivated` })
}

/**
 * List all discovered skills with their metadata and active/inactive status.
 */
export function listSkills(): SkillEntry[] {
  return Array.from(skills.values())
}

/**
 * Get full frontmatter metadata for a specific skill.
 */
export function getSkillInfo(name: string): Result<SkillEntry> {
  const skill = skills.get(name)
  if (!skill) {
    return err(new Error(`Skill not found: "${name}"`))
  }
  return ok(skill)
}

// ── Tool interface ────────────────────────────────────────────────────

export const name = 'skill-manager'

export const description =
  'Manage the skill catalog: list available skills, activate a skill to load its full instructions, ' +
  'deactivate a skill to free context, or get detailed info about a specific skill.'

export const schema = z.object({
  action: z.enum(['list', 'activate', 'deactivate', 'info']).describe('The action to perform'),
  skill: z.string().optional().describe('Skill name (required for activate, deactivate, and info)'),
})

export const execute: TypedToolExecute<typeof schema, unknown> = async (
  args,
): Promise<Result<unknown>> => {
  const { action, skill: skillName } = args

  switch (action) {
    case 'list': {
      const allSkills = listSkills()
      if (allSkills.length === 0) {
        return ok({ skills: [], message: 'No skills discovered' })
      }
      const summary = allSkills.map((s) => ({
        name: s.name,
        description: s.description,
        status: s.status,
        active: s.active,
      }))
      return ok({ skills: summary, message: `${allSkills.length} skill(s) available` })
    }

    case 'activate': {
      if (!skillName) {
        return err(new Error('"skill" parameter is required for the "activate" action'))
      }
      return activateSkill(skillName)
    }

    case 'deactivate': {
      if (!skillName) {
        return err(new Error('"skill" parameter is required for the "deactivate" action'))
      }
      return deactivateSkill(skillName)
    }

    case 'info': {
      if (!skillName) {
        return err(new Error('"skill" parameter is required for the "info" action'))
      }
      return getSkillInfo(skillName)
    }

    default:
      return err(new Error(`Unknown skill-manager action: "${String(action)}"`))
  }
}
