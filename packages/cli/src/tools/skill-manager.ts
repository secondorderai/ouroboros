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
import { homedir } from 'node:os'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

// ── Types ─────────────────────────────────────────────────────────────

/** Status derived from which directory a skill lives in. */
export type SkillStatus = 'core' | 'staging' | 'generated' | 'builtin'

/**
 * Zod schema for SKILL.md frontmatter. Source of truth for what a SKILL.md
 * may declare; consumed by `parseFrontmatter` here and by RSI generation
 * pipelines that need to validate generated frontmatter before writing.
 *
 * Permissive on optional fields so user-authored skills (and skills authored
 * for Claude Code / agents.io ecosystem) load without modification.
 */
export const skillFrontmatterSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().min(1, 'description is required'),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Explicit list of file names under the skill's `references/` directory to load on activation. */
  references: z.array(z.string().min(1)).optional(),
  /** When true, activation requires user approval through the registered skill-approval handler. */
  requiresApproval: z.boolean().optional(),
})

/** Parsed frontmatter from a SKILL.md file. */
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

/** A discovered skill with its metadata and runtime state. */
export interface SkillEntry {
  /** Skill name from frontmatter. */
  name: string
  /** Short description from frontmatter. */
  description: string
  /** Derived from directory path (core, staging, generated, builtin). */
  status: SkillStatus
  /** Full parsed frontmatter. */
  frontmatter: SkillFrontmatter
  /** Absolute path to the skill directory. */
  dirPath: string
  /** Whether the skill's full instructions are currently loaded. */
  active: boolean
  /** Whether the skill is available for prompt lookup and activation. */
  enabled: boolean
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
  /** Contents of explicitly listed reference files. */
  references: string[]
  /** Names of files in the skill's `references/` and `scripts/` directories (up to 10 each). */
  fileList: string[]
}

/** Request payload sent to the skill-approval handler. */
export interface SkillApprovalRequest {
  approvalId: string
  skillName: string
  description: string
}

/** Response from the skill-approval handler. */
export type SkillApprovalHandler = (
  request: SkillApprovalRequest,
) => Promise<Result<{ approved: boolean; reason?: string }>>

// ── Internal state ────────────────────────────────────────────────────

let skills = new Map<string, SkillEntry>()

/** Reset internal state (useful for testing). */
export function _resetSkills(): void {
  skills = new Map()
}

// ── YAML sanitization (defense against quirky frontmatter) ───────────

/**
 * Best-effort fixups for quirky-but-recoverable YAML:
 *   - strip a leading UTF-8 BOM
 *   - convert leading tab indentation to two-space indentation
 *
 * Used as a fallback re-parse when strict parsing fails. Intentionally
 * minimal: aggressive sanitization would mask real structural errors.
 */
function sanitizeYamlBlock(raw: string): string {
  const withoutBom = raw.replace(/^﻿/, '')
  return withoutBom.replace(/^(\t+)/gm, (match) => '  '.repeat(match.length))
}

// ── Frontmatter parsing ──────────────────────────────────────────────

function parseYamlWithFallback(yamlBlock: string): Result<unknown> {
  try {
    return ok(parseYaml(yamlBlock))
  } catch {
    // First parse failed — try once more with sanitization.
  }

  try {
    return ok(parseYaml(sanitizeYamlBlock(yamlBlock)))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to parse YAML frontmatter: ${message}`))
  }
}

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

  const parseResult = parseYamlWithFallback(yamlBlock)
  if (!parseResult.ok) {
    return err(parseResult.error)
  }

  if (parseResult.value == null || typeof parseResult.value !== 'object') {
    return err(new Error('YAML frontmatter is not an object'))
  }

  const validation = skillFrontmatterSchema.safeParse(parseResult.value)
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'frontmatter'
        return `${path}: ${issue.message}`
      })
      .join('; ')
    return err(new Error(`SKILL.md frontmatter invalid: ${issues}`))
  }

  return ok({ frontmatter: validation.data, body })
}

// ── Status detection ─────────────────────────────────────────────────

/** Derive skill status from the directory path. */
function deriveStatus(dirPath: string): SkillStatus {
  const segments = dirPath.split('/')
  if (segments.includes('staging')) return 'staging'
  if (segments.includes('generated')) return 'generated'
  if (segments.includes('builtin')) return 'builtin'
  return 'core'
}

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Scan a single absolute directory for child folders containing SKILL.md.
 * Each valid skill is registered into the module-level `skills` map; later
 * calls overwrite earlier entries on name collision, so callers control
 * precedence by ordering their invocations.
 */
function scanSkillRoot(absDir: string, disabledSkillNames: Set<string>): void {
  if (!existsSync(absDir)) return

  let entries: string[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    // Directory not readable — skip silently.
    return
  }

  for (const entry of entries) {
    const skillDir = join(absDir, entry)
    const skillMdPath = join(skillDir, 'SKILL.md')

    if (!existsSync(skillMdPath)) continue

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
    skills.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      status: deriveStatus(skillDir),
      frontmatter,
      dirPath: skillDir,
      active: false,
      enabled: !disabledSkillNames.has(frontmatter.name),
    })
  }
}

/**
 * Scan configured skill directories for subdirectories containing a SKILL.md file.
 * Invalid or malformed SKILL.md files are skipped with a warning (logged to stderr).
 *
 * Discovery order (later passes overwrite earlier ones on name collision):
 *   1. `extraScanRoots` — absolute paths whose direct children are skill folders
 *      (no join with `directories`). Used for built-in and user-global skill
 *      sources. Listed first so workspace skills take precedence.
 *   2. `basePath × directories` — each base path joined with each relative
 *      directory in `directories`. Bases are scanned in the order given.
 *
 * @param directories - Directories to scan (relative or absolute paths)
 * @param basePath - One or more base paths for resolving relative directories
 * @param extraScanRoots - Absolute directories whose direct children are skill
 *   folders. Lower precedence than base-path matches. Order matters: later
 *   roots in this list override earlier ones on name collision.
 */
export function discoverSkills(
  directories: string[],
  basePath?: string | string[],
  extraScanRoots?: string[],
  disabledSkills: string[] = [],
): void {
  const rawBases =
    basePath === undefined ? [process.cwd()] : Array.isArray(basePath) ? basePath : [basePath]
  const bases: string[] = []
  for (const base of rawBases) {
    const absolute = resolve(base)
    if (!bases.includes(absolute)) bases.push(absolute)
  }

  skills = new Map()
  const disabledSkillNames = new Set(disabledSkills)

  if (extraScanRoots) {
    const seenExtras = new Set<string>()
    for (const root of extraScanRoots) {
      const absolute = resolve(root)
      if (seenExtras.has(absolute)) continue
      seenExtras.add(absolute)
      scanSkillRoot(absolute, disabledSkillNames)
    }
  }

  for (const base of bases) {
    for (const dir of directories) {
      scanSkillRoot(resolve(base, dir), disabledSkillNames)
    }
  }
}

/**
 * Resolve the user-global skill roots scanned in addition to project and
 * built-in directories. Honors industry conventions so skills authored for
 * Claude Code (`~/.claude/skills/`) and the agents.io ecosystem
 * (`~/.agents/skills/`) work in Ouroboros without modification.
 *
 * `OUROBOROS_USER_SKILLS_DIRS` (colon-separated absolute paths) replaces the
 * default list when set — explicit configuration beats convention.
 */
function resolveUserSkillRoots(): string[] {
  const override = process.env.OUROBOROS_USER_SKILLS_DIRS
  if (override !== undefined) {
    return override
      .split(':')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  const home = homedir()
  if (!home) return []
  // `.agents/skills/` first so `.claude/skills/` wins on collision (last-wins).
  return [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')]
}

/**
 * Discover skills using the runtime layout shared by every entry point:
 * configured directories joined against the given base path(s), plus
 * lower-precedence absolute roots:
 *
 *   - The directory supplied via `OUROBOROS_BUILTIN_SKILLS_DIR` (skills shipped
 *     with the desktop bundle).
 *   - The user-global roots `~/.claude/skills/` and `~/.agents/skills/` (or
 *     overrides via `OUROBOROS_USER_SKILLS_DIRS`).
 *
 * Centralizing this prevents drift between the agent's per-turn catalog
 * rebuild, the JSON-RPC `skills.list` handler, and the slash-skill resolver —
 * any caller that forgets to apply these sources would silently hide
 * built-in or user-installed skills from the LLM.
 *
 * Precedence (highest wins, since later passes override earlier ones):
 *   project base paths > `~/.claude/skills` > `~/.agents/skills` > builtin
 */
export function discoverConfiguredSkills(
  directories: string[],
  basePath?: string | string[],
  disabledSkills: string[] = [],
): void {
  const builtinDir = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
  const userRoots = resolveUserSkillRoots()
  const extraScanRoots: string[] = []
  if (builtinDir) extraScanRoots.push(builtinDir)
  // userRoots is already ordered so the most authoritative root is last.
  extraScanRoots.push(...userRoots)
  discoverSkills(
    directories,
    basePath,
    extraScanRoots.length > 0 ? extraScanRoots : undefined,
    disabledSkills,
  )
}

// ── Activation listener ──────────────────────────────────────────────
//
// The JSON-RPC server registers a handler so the desktop renderer can show
// a per-turn skill indicator. Set to a no-op by default so unit tests and
// the standalone CLI aren't forced to wire it.

type SkillActivatedHandler = (name: string) => void
let skillActivatedHandler: SkillActivatedHandler = () => {}

export function setSkillActivatedHandler(handler: SkillActivatedHandler): void {
  skillActivatedHandler = handler
}

export function _resetSkillActivatedHandler(): void {
  skillActivatedHandler = () => {}
}

// ── Skill approval handler ───────────────────────────────────────────
//
// Skills marked `requiresApproval: true` route through this handler before
// their full instructions are returned. The CLI/desktop layers register a
// handler that surfaces the request to the user; tests and headless runs
// leave it null, which causes activation to fail closed.

let skillApprovalHandler: SkillApprovalHandler | null = null

export function setSkillApprovalHandler(handler: SkillApprovalHandler | null): void {
  skillApprovalHandler = handler
}

export function _resetSkillApprovalHandler(): void {
  skillApprovalHandler = null
}

async function requestSkillApproval(
  skillName: string,
  description: string,
): Promise<Result<{ approved: boolean; reason?: string }>> {
  if (!skillApprovalHandler) {
    return err(
      new Error(
        `Skill "${skillName}" requires approval, but no approval handler is registered. ` +
          'Ask the user to confirm activation, or run in an environment that wires the skill-approval handler.',
      ),
    )
  }
  return skillApprovalHandler({
    approvalId: `skill-approval-${skillName}-${crypto.randomUUID()}`,
    skillName,
    description,
  })
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns a clean array of `{ name, description, status }` for system
 * prompt injection. Only metadata — no full instructions.
 */
export function getSkillCatalog(): SkillCatalogEntry[] {
  return Array.from(skills.values())
    .filter((s) => s.enabled)
    .map((s) => ({
      name: s.name,
      description: s.description,
      status: s.status,
    }))
}

const REFERENCES_DIR = 'references'
const SCRIPTS_DIR = 'scripts'
const FILE_LIST_LIMIT = 10

/**
 * List up to `FILE_LIST_LIMIT` file names from a skill subdirectory.
 * Returns paths relative to the skill directory (e.g. `references/guide.md`).
 */
function listSkillFiles(skillDir: string, subdir: string): string[] {
  const fullPath = join(skillDir, subdir)
  if (!existsSync(fullPath)) return []
  let entries: string[]
  try {
    entries = readdirSync(fullPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  return entries.slice(0, FILE_LIST_LIMIT).map((name) => `${subdir}/${name}`)
}

function loadExplicitReferences(skillDir: string, names: string[]): string[] {
  const loaded: string[] = []
  for (const name of names) {
    const refPath = join(skillDir, REFERENCES_DIR, name)
    if (!existsSync(refPath)) {
      console.warn(`[skill-manager] Warning: declared reference not found: ${refPath}`)
      continue
    }
    try {
      const stats = statSync(refPath)
      if (!stats.isFile()) continue
      loaded.push(readFileSync(refPath, 'utf-8'))
    } catch {
      console.warn(`[skill-manager] Warning: could not read reference: ${refPath}`)
    }
  }
  return loaded
}

/** Legacy heuristic kept for one release — body mentions REFERENCE.md by name. */
function loadLegacyReferenceMd(skillDir: string, body: string): string[] {
  const referencePath = join(skillDir, REFERENCES_DIR, 'REFERENCE.md')
  if (!body.includes('REFERENCE.md') || !existsSync(referencePath)) return []
  try {
    console.warn(
      '[skill-manager] Warning: REFERENCE.md heuristic is deprecated — declare ' +
        '`references: ["REFERENCE.md"]` in SKILL.md frontmatter instead.',
    )
    return [readFileSync(referencePath, 'utf-8')]
  } catch {
    console.warn(`[skill-manager] Warning: Could not read ${referencePath}`)
    return []
  }
}

/**
 * Load full SKILL.md body (everything after frontmatter) and return it
 * for injection into the conversation context. Loads any explicit
 * `references` declared in the frontmatter and also lists files in the
 * skill's `references/` and `scripts/` directories so the LLM is aware
 * of bundled assets without their full contents.
 *
 * Idempotent: re-activating an already-active skill returns the same
 * result without re-firing the activation handler.
 *
 * Skills with `requiresApproval: true` route through the registered
 * skill-approval handler; if the handler denies or none is registered,
 * activation fails with a clear error. Pass `bypassApproval: true` when
 * activation comes from a direct user action (e.g. a slash invocation)
 * — that IS the user's approval and shouldn't trigger a second prompt.
 */
export async function activateSkill(
  name: string,
  options: { bypassApproval?: boolean } = {},
): Promise<Result<SkillActivationResult>> {
  const skill = skills.get(name)
  if (!skill) {
    return err(new Error(`Skill not found: "${name}"`))
  }
  if (!skill.enabled) {
    return err(new Error(`Skill disabled: "${name}"`))
  }

  if (skill.frontmatter.requiresApproval && !skill.active && !options.bypassApproval) {
    const approval = await requestSkillApproval(name, skill.description)
    if (!approval.ok) {
      return err(approval.error)
    }
    if (!approval.value.approved) {
      const reason = approval.value.reason?.trim() || 'denied by user'
      return err(new Error(`Activation of skill "${name}" was ${reason}`))
    }
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

  const { body, frontmatter } = parsed.value

  const explicitReferences = frontmatter.references ?? []
  const references =
    explicitReferences.length > 0
      ? loadExplicitReferences(skill.dirPath, explicitReferences)
      : loadLegacyReferenceMd(skill.dirPath, body)

  const fileList = [
    ...listSkillFiles(skill.dirPath, REFERENCES_DIR),
    ...listSkillFiles(skill.dirPath, SCRIPTS_DIR),
  ]

  const wasActive = skill.active
  skill.active = true
  if (!wasActive) {
    skillActivatedHandler(name)
  }

  return ok({
    name,
    instructions: body,
    references,
    fileList,
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
export function listSkills(options: { includeDisabled?: boolean } = {}): SkillEntry[] {
  const includeDisabled = options.includeDisabled ?? true
  return Array.from(skills.values())
    .filter((s) => includeDisabled || s.enabled)
    .map((s) => ({ ...s }))
}

/**
 * Get full frontmatter metadata for a specific skill.
 */
export function getSkillInfo(name: string): Result<SkillEntry> {
  const skill = skills.get(name)
  if (!skill) {
    return err(new Error(`Skill not found: "${name}"`))
  }
  return ok({ ...skill })
}

// ── Tool interface ────────────────────────────────────────────────────

export const name = 'skill-manager'

export const description =
  'Manage the skill catalog: list available skills, activate a skill to load its full instructions, ' +
  'deactivate a skill to free context, or get detailed info about a specific skill.'

export const schema = z
  .object({
    action: z
      .enum(['list', 'activate', 'deactivate', 'info'])
      .describe('The skill management operation to perform'),
    skill: z
      .string()
      .optional()
      .describe('Skill name (required for activate, deactivate, and info actions)'),
  })
  .refine((data) => data.action === 'list' || (data.skill !== undefined && data.skill.length > 0), {
    message: 'skill name is required for activate, deactivate, and info actions',
    path: ['skill'],
  })

export const execute: TypedToolExecute<typeof schema, unknown> = async (
  args,
): Promise<Result<unknown>> => {
  switch (args.action) {
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
        enabled: s.enabled,
      }))
      return ok({ skills: summary, message: `${allSkills.length} skill(s) available` })
    }

    case 'activate': {
      // Refine guarantees skill is present for non-list actions
      return activateSkill(args.skill!)
    }

    case 'deactivate': {
      return deactivateSkill(args.skill!)
    }

    case 'info': {
      return getSkillInfo(args.skill!)
    }

    default:
      return err(
        new Error(`Unknown skill-manager action: "${String((args as { action: string }).action)}"`),
      )
  }
}
export const tier = 3
