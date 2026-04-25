import type { OuroborosConfig } from '@src/config'
import {
  activateSkill,
  discoverConfiguredSkills,
  listSkills,
  type SkillActivationResult,
} from '@src/tools/skill-manager'

export interface ParsedSkillInvocation {
  skillName?: string
  message: string
}

export type SkillInvocationParseResult =
  | { ok: true; value: ParsedSkillInvocation }
  | { ok: false; error: Error }

export type SkillActivationForRunResult =
  | { ok: true; value: SkillActivationResult }
  | { ok: false; error: Error }

const RESERVED_SLASH_COMMANDS = new Set(['plan'])

export function parseSlashSkillInvocation(
  input: string,
  availableSkillNames: string[],
): SkillInvocationParseResult {
  const leadingWhitespace = input.match(/^\s*/)?.[0] ?? ''
  const trimmedStart = input.slice(leadingWhitespace.length)

  if (!trimmedStart.startsWith('/')) {
    return { ok: true, value: { message: input } }
  }

  const match = trimmedStart.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  if (!match) {
    return {
      ok: false,
      error: new Error('Slash skill invocation must use /skill-name followed by a message.'),
    }
  }

  const skillName = match[1]
  const message = (match[2] ?? '').trim()

  if (RESERVED_SLASH_COMMANDS.has(skillName)) {
    return { ok: true, value: { message: input } }
  }

  if (!availableSkillNames.includes(skillName)) {
    return {
      ok: false,
      error: new Error(
        `Unknown skill "${skillName}". Use an installed skill name after /, for example /${availableSkillNames[0] ?? 'skill-name'} <message>.`,
      ),
    }
  }

  if (!message) {
    return {
      ok: false,
      error: new Error(`Usage: /${skillName} <message>`),
    }
  }

  return { ok: true, value: { skillName, message } }
}

/**
 * Build the discovery arguments shared by every entry point that needs to
 * resolve a slash skill: list the catalog AND activate by name. Keeping them
 * in lockstep prevents the catalog from shrinking between picker render and
 * agent run (which would surface as "Skill not found" on submit).
 */
function discoverSkillsForRun(config: OuroborosConfig, basePath?: string): void {
  discoverConfiguredSkills(
    config.skillDirectories,
    basePath === undefined ? undefined : [basePath, process.cwd()],
  )
}

export function resolveSlashSkillInvocation(
  input: string,
  config: OuroborosConfig,
  basePath?: string,
): SkillInvocationParseResult {
  discoverSkillsForRun(config, basePath)
  return parseSlashSkillInvocation(
    input,
    listSkills().map((skill) => skill.name),
  )
}

export async function activateSkillForRun(
  skillName: string,
  config: OuroborosConfig,
  basePath?: string,
): Promise<SkillActivationForRunResult> {
  discoverSkillsForRun(config, basePath)
  // The user explicitly invoked the slash command — that IS approval. Bypass
  // the approval handler so we don't double-prompt for skills marked
  // `requiresApproval: true`.
  const activation = await activateSkill(skillName, { bypassApproval: true })
  if (!activation.ok) {
    return { ok: false, error: activation.error }
  }
  return { ok: true, value: activation.value }
}
