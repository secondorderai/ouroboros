import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  discoverSkills,
  discoverConfiguredSkills,
  getSkillCatalog,
  activateSkill,
  deactivateSkill,
  listSkills,
  getSkillInfo,
  _resetSkills,
  _resetSkillActivatedHandler,
  _resetSkillApprovalHandler,
  execute,
  schema,
  setSkillActivatedHandler,
  setSkillApprovalHandler,
} from '@src/tools/skill-manager'

/** Base path for test fixtures. */
const FIXTURES = resolve(import.meta.dir, '../fixtures/skills-test')

/** Helper: quote a YAML value if it contains special characters. */
function yamlValue(v: unknown): string {
  const s = String(v)
  // Quote strings that start with special YAML characters or contain colons
  if (/^[>|&*!%@`{[\],#?-]/.test(s) || s.includes(': ') || s.includes('#')) {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return s
}

/** Helper: create a SKILL.md file with frontmatter and body. */
function writeSkillMd(dir: string, frontmatter: Record<string, unknown>, body: string): void {
  mkdirSync(dir, { recursive: true })
  const yamlLines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`
        const items = v.map((item) => `  - ${yamlValue(item)}`).join('\n')
        return `${k}:\n${items}`
      }
      if (typeof v === 'object' && v !== null) {
        const inner = Object.entries(v as Record<string, unknown>)
          .map(([ik, iv]) => `  ${ik}: ${yamlValue(iv)}`)
          .join('\n')
        return `${k}:\n${inner}`
      }
      return `${k}: ${yamlValue(v)}`
    })
    .join('\n')
  const content = `---\n${yamlLines}\n---\n${body}`
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

describe('SkillManager', () => {
  beforeEach(() => {
    _resetSkills()
    _resetSkillActivatedHandler()
    _resetSkillApprovalHandler()
    // Clean up any leftover fixtures
    rmSync(FIXTURES, { recursive: true, force: true })
  })

  afterEach(() => {
    _resetSkills()
    _resetSkillActivatedHandler()
    _resetSkillApprovalHandler()
    rmSync(FIXTURES, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Feature test: Discovery finds skills in all directories
  // -----------------------------------------------------------------------
  test('discovery finds skills in core and generated directories', () => {
    const coreDir = join(FIXTURES, 'core', 'test-core-skill')
    const generatedDir = join(FIXTURES, 'generated', 'test-gen-skill')

    writeSkillMd(
      coreDir,
      {
        name: 'test-core-skill',
        description: 'A core skill for testing',
      },
      '# Core skill instructions\n\nDo core things.',
    )

    writeSkillMd(
      generatedDir,
      {
        name: 'test-gen-skill',
        description: 'A generated skill for testing',
      },
      '# Generated skill instructions\n\nDo generated things.',
    )

    discoverSkills(['core', 'generated'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(2)

    const names = catalog.map((s) => s.name).sort()
    expect(names).toEqual(['test-core-skill', 'test-gen-skill'])

    const coreEntry = catalog.find((s) => s.name === 'test-core-skill')
    expect(coreEntry?.status).toBe('core')

    const genEntry = catalog.find((s) => s.name === 'test-gen-skill')
    expect(genEntry?.status).toBe('generated')
  })

  // -----------------------------------------------------------------------
  // Feature test: Frontmatter parsing extracts metadata
  // -----------------------------------------------------------------------
  test('frontmatter parsing extracts all metadata fields', () => {
    const skillDir = join(FIXTURES, 'core', 'full-metadata-skill')

    writeSkillMd(
      skillDir,
      {
        name: 'full-metadata-skill',
        description: 'A skill with full metadata',
        license: 'MIT',
        compatibility: '>=1.0.0',
        metadata: { author: 'test-author', version: '1.0.0' },
      },
      '# Full metadata skill\n\nInstructions here.',
    )

    discoverSkills(['core'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].name).toBe('full-metadata-skill')
    expect(catalog[0].description).toBe('A skill with full metadata')

    // Verify full frontmatter via getSkillInfo
    const info = getSkillInfo('full-metadata-skill')
    expect(info.ok).toBe(true)
    if (info.ok) {
      expect(info.value.frontmatter.license).toBe('MIT')
      expect(info.value.frontmatter.compatibility).toBe('>=1.0.0')
      expect(info.value.frontmatter.metadata).toEqual({
        author: 'test-author',
        version: '1.0.0',
      })
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Activate loads full instructions
  // -----------------------------------------------------------------------
  test('activateSkill returns full instructions without frontmatter', async () => {
    const skillDir = join(FIXTURES, 'core', 'instruction-skill')

    // Build 50 lines of instructions
    const instructionLines: string[] = []
    for (let i = 1; i <= 50; i++) {
      instructionLines.push(`Line ${i} of instructions.`)
    }
    const body = instructionLines.join('\n')

    writeSkillMd(
      skillDir,
      {
        name: 'instruction-skill',
        description: 'Skill with 50 lines of instructions',
      },
      body,
    )

    discoverSkills(['core'], FIXTURES)

    const result = await activateSkill('instruction-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Should contain instructions but not frontmatter
      expect(result.value.instructions).toContain('Line 1 of instructions.')
      expect(result.value.instructions).toContain('Line 50 of instructions.')
      expect(result.value.instructions).not.toContain('---')
      expect(result.value.instructions).not.toContain('name: instruction-skill')

      const returnedLines = result.value.instructions.split('\n')
      expect(returnedLines).toHaveLength(50)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Activate also reads referenced files
  // -----------------------------------------------------------------------
  test('activateSkill reads REFERENCE.md when mentioned in body (legacy heuristic)', async () => {
    const skillDir = join(FIXTURES, 'core', 'ref-skill')
    const refDir = join(skillDir, 'references')

    writeSkillMd(
      skillDir,
      {
        name: 'ref-skill',
        description: 'Skill that references REFERENCE.md',
      },
      '# Instructions\n\nSee REFERENCE.md for more details.',
    )

    mkdirSync(refDir, { recursive: true })
    writeFileSync(join(refDir, 'REFERENCE.md'), '# Reference\n\nDetailed API reference.', 'utf-8')

    discoverSkills(['core'], FIXTURES)

    const result = await activateSkill('ref-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.references).toHaveLength(1)
      expect(result.value.references[0]).toContain('Detailed API reference.')
      expect(result.value.fileList).toContain('references/REFERENCE.md')
    }
  })

  test('activateSkill loads explicit references list from frontmatter', async () => {
    const skillDir = join(FIXTURES, 'core', 'explicit-ref-skill')
    const refDir = join(skillDir, 'references')

    writeSkillMd(
      skillDir,
      {
        name: 'explicit-ref-skill',
        description: 'Skill that declares its references explicitly',
        references: ['guide.md'],
      },
      '# Instructions\n\nFollow the guide.',
    )

    mkdirSync(refDir, { recursive: true })
    writeFileSync(join(refDir, 'guide.md'), '# Guide\n\nDetailed guide content.', 'utf-8')
    writeFileSync(join(refDir, 'extra.md'), '# Extra\n\nNot loaded.', 'utf-8')

    discoverSkills(['core'], FIXTURES)

    const result = await activateSkill('explicit-ref-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Only the explicitly-listed reference is loaded as content.
      expect(result.value.references).toHaveLength(1)
      expect(result.value.references[0]).toContain('Detailed guide content.')
      // But all reference files appear in the file list for awareness.
      expect(result.value.fileList).toContain('references/guide.md')
      expect(result.value.fileList).toContain('references/extra.md')
    }
  })

  test('activateSkill fileList includes scripts/ entries up to the limit', async () => {
    const skillDir = join(FIXTURES, 'core', 'script-skill')
    const scriptsDir = join(skillDir, 'scripts')

    writeSkillMd(
      skillDir,
      { name: 'script-skill', description: 'Skill with scripts' },
      '# Instructions',
    )

    mkdirSync(scriptsDir, { recursive: true })
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(scriptsDir, `script-${String(i).padStart(2, '0')}.ts`), '// noop', 'utf-8')
    }

    discoverSkills(['core'], FIXTURES)

    const result = await activateSkill('script-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const scriptEntries = result.value.fileList.filter((p) => p.startsWith('scripts/'))
      // FILE_LIST_LIMIT is 10.
      expect(scriptEntries).toHaveLength(10)
      expect(scriptEntries[0]).toBe('scripts/script-00.ts')
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: Invalid SKILL.md is skipped
  // -----------------------------------------------------------------------
  test('invalid SKILL.md (missing name) is skipped with warning', () => {
    const validDir = join(FIXTURES, 'core', 'valid-skill')
    const invalidDir = join(FIXTURES, 'core', 'invalid-skill')

    writeSkillMd(
      validDir,
      {
        name: 'valid-skill',
        description: 'A valid skill',
      },
      '# Valid instructions',
    )

    // Write an invalid SKILL.md missing the name field
    mkdirSync(invalidDir, { recursive: true })
    writeFileSync(
      join(invalidDir, 'SKILL.md'),
      '---\ndescription: missing name field\n---\n# Instructions',
      'utf-8',
    )

    discoverSkills(['core'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].name).toBe('valid-skill')
  })

  test('directory without SKILL.md is skipped', () => {
    const emptyDir = join(FIXTURES, 'core', 'empty-dir')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, 'README.md'), '# Not a skill', 'utf-8')

    discoverSkills(['core'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(0)
  })

  test('non-existent skill directory is handled gracefully', () => {
    discoverSkills(['nonexistent'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Regression test: Skills resolve from multiple base paths so a global
  // .ouroboros config (configDir = ~) does not hide workspace-local skills.
  // -----------------------------------------------------------------------
  test('discovery scans skills from multiple base paths', () => {
    const globalBase = join(FIXTURES, 'global')
    const workspaceBase = join(FIXTURES, 'workspace')

    writeSkillMd(
      join(globalBase, 'core', 'global-only'),
      { name: 'global-only', description: 'Lives only at the global root' },
      '# Global skill',
    )

    writeSkillMd(
      join(workspaceBase, 'core', 'workspace-only'),
      { name: 'workspace-only', description: 'Lives only at the workspace root' },
      '# Workspace skill',
    )

    // Same name in both — workspace must win because it is listed last.
    writeSkillMd(
      join(globalBase, 'core', 'shared'),
      { name: 'shared', description: 'Global version' },
      '# Global shared skill',
    )
    writeSkillMd(
      join(workspaceBase, 'core', 'shared'),
      { name: 'shared', description: 'Workspace version' },
      '# Workspace shared skill',
    )

    discoverSkills(['core'], [globalBase, workspaceBase])

    const catalog = getSkillCatalog()
    const names = catalog.map((s) => s.name).sort()
    expect(names).toEqual(['global-only', 'shared', 'workspace-only'])

    const sharedInfo = getSkillInfo('shared')
    expect(sharedInfo.ok).toBe(true)
    if (sharedInfo.ok) {
      expect(sharedInfo.value.description).toBe('Workspace version')
      expect(sharedInfo.value.dirPath).toBe(join(workspaceBase, 'core', 'shared'))
    }
  })

  test('duplicate base paths are deduplicated', () => {
    writeSkillMd(
      join(FIXTURES, 'core', 'only-once'),
      { name: 'only-once', description: 'Should appear once' },
      '# Body',
    )

    discoverSkills(['core'], [FIXTURES, FIXTURES])

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].name).toBe('only-once')
  })

  // -----------------------------------------------------------------------
  // Feature tests: built-in skills shipped via extraScanRoots
  // -----------------------------------------------------------------------
  test('extraScanRoots discovers skills directly under the given absolute path', () => {
    const builtinRoot = join(FIXTURES, 'builtin')
    writeSkillMd(
      join(builtinRoot, 'meta-thinking'),
      { name: 'meta-thinking', description: 'Built-in planning skill' },
      '# Body',
    )

    discoverSkills([], undefined, [builtinRoot])

    const info = getSkillInfo('meta-thinking')
    expect(info.ok).toBe(true)
    if (info.ok) {
      expect(info.value.status).toBe('builtin')
      expect(info.value.dirPath).toBe(join(builtinRoot, 'meta-thinking'))
    }
  })

  test('base-path skills override extraScanRoot built-ins on name collision', () => {
    const builtinRoot = join(FIXTURES, 'builtin')
    writeSkillMd(
      join(builtinRoot, 'shared'),
      { name: 'shared', description: 'Built-in version' },
      '# Built-in body',
    )
    writeSkillMd(
      join(FIXTURES, 'core', 'shared'),
      { name: 'shared', description: 'Workspace version' },
      '# Workspace body',
    )

    discoverSkills(['core'], FIXTURES, [builtinRoot])

    const info = getSkillInfo('shared')
    expect(info.ok).toBe(true)
    if (info.ok) {
      // Workspace wins (scanned after extraScanRoots).
      expect(info.value.description).toBe('Workspace version')
      expect(info.value.status).toBe('core')
      expect(info.value.dirPath).toBe(join(FIXTURES, 'core', 'shared'))
    }
  })

  // -----------------------------------------------------------------------
  // discoverConfiguredSkills picks up OUROBOROS_BUILTIN_SKILLS_DIR so every
  // entry point (agent, RSI, JSON-RPC, slash commands) sees built-in skills
  // shipped with the desktop bundle without each caller having to remember
  // to read the env var.
  // -----------------------------------------------------------------------
  test('discoverConfiguredSkills picks up OUROBOROS_BUILTIN_SKILLS_DIR', () => {
    const builtinRoot = join(FIXTURES, 'builtin')
    writeSkillMd(
      join(builtinRoot, 'meta-thinking'),
      { name: 'meta-thinking', description: 'Built-in planning skill' },
      '# Body',
    )

    const previousBuiltin = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    const previousUser = process.env.OUROBOROS_USER_SKILLS_DIRS
    process.env.OUROBOROS_BUILTIN_SKILLS_DIR = builtinRoot
    // Hermetic: don't pick up dev-machine ~/.claude/skills entries.
    process.env.OUROBOROS_USER_SKILLS_DIRS = ''
    try {
      // No directories, no basePath — only the env-var source should populate.
      discoverConfiguredSkills([])

      const info = getSkillInfo('meta-thinking')
      expect(info.ok).toBe(true)
      if (info.ok) {
        expect(info.value.status).toBe('builtin')
      }
    } finally {
      if (previousBuiltin === undefined) {
        delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      } else {
        process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousBuiltin
      }
      if (previousUser === undefined) {
        delete process.env.OUROBOROS_USER_SKILLS_DIRS
      } else {
        process.env.OUROBOROS_USER_SKILLS_DIRS = previousUser
      }
    }
  })

  test('discoverConfiguredSkills is a no-op for built-ins when env var is unset', () => {
    const previousBuiltin = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    const previousUser = process.env.OUROBOROS_USER_SKILLS_DIRS
    delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    // Empty string disables user-global discovery so the test is hermetic across
    // dev machines where ~/.claude/skills/ may exist.
    process.env.OUROBOROS_USER_SKILLS_DIRS = ''
    try {
      discoverConfiguredSkills([])
      expect(getSkillCatalog()).toHaveLength(0)
    } finally {
      if (previousBuiltin !== undefined) {
        process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousBuiltin
      }
      if (previousUser === undefined) {
        delete process.env.OUROBOROS_USER_SKILLS_DIRS
      } else {
        process.env.OUROBOROS_USER_SKILLS_DIRS = previousUser
      }
    }
  })

  test('duplicate extraScanRoots are deduplicated', () => {
    const builtinRoot = join(FIXTURES, 'builtin')
    writeSkillMd(
      join(builtinRoot, 'once'),
      { name: 'once', description: 'Should appear once' },
      '# Body',
    )

    discoverSkills([], undefined, [builtinRoot, builtinRoot])

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].name).toBe('once')
    expect(catalog[0].status).toBe('builtin')
  })

  // -----------------------------------------------------------------------
  // Feature test: List shows active/inactive status
  // -----------------------------------------------------------------------
  test('listSkills shows active/inactive status correctly', async () => {
    const skillA = join(FIXTURES, 'core', 'skill-a')
    const skillB = join(FIXTURES, 'core', 'skill-b')

    writeSkillMd(
      skillA,
      {
        name: 'skill-a',
        description: 'Skill A',
      },
      '# Skill A instructions',
    )

    writeSkillMd(
      skillB,
      {
        name: 'skill-b',
        description: 'Skill B',
      },
      '# Skill B instructions',
    )

    discoverSkills(['core'], FIXTURES)

    // Activate skill-a only
    await activateSkill('skill-a')

    const allSkills = listSkills()
    expect(allSkills).toHaveLength(2)

    const skillAEntry = allSkills.find((s) => s.name === 'skill-a')
    const skillBEntry = allSkills.find((s) => s.name === 'skill-b')

    expect(skillAEntry?.active).toBe(true)
    expect(skillBEntry?.active).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Feature test: activation fires the registered handler exactly once
  // -----------------------------------------------------------------------
  test('activateSkill notifies the registered handler with the skill name', async () => {
    const skillDir = join(FIXTURES, 'core', 'notify-me')
    writeSkillMd(
      skillDir,
      { name: 'notify-me', description: 'Skill that fires the handler' },
      '# Body',
    )
    discoverSkills(['core'], FIXTURES)

    const calls: string[] = []
    setSkillActivatedHandler((name) => calls.push(name))

    const result = await activateSkill('notify-me')
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['notify-me'])

    // Re-activating an already-active skill is idempotent at the handler level.
    await activateSkill('notify-me')
    expect(calls).toEqual(['notify-me'])

    // After deactivation, re-activation fires the handler again.
    deactivateSkill('notify-me')
    await activateSkill('notify-me')
    expect(calls).toEqual(['notify-me', 'notify-me'])
  })

  test('failed activations do not fire the handler', async () => {
    const calls: string[] = []
    setSkillActivatedHandler((name) => calls.push(name))

    const result = await activateSkill('does-not-exist')
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })

  // -----------------------------------------------------------------------
  // Deactivation
  // -----------------------------------------------------------------------
  test('deactivateSkill marks skill as inactive', async () => {
    const skillDir = join(FIXTURES, 'core', 'deact-skill')

    writeSkillMd(
      skillDir,
      {
        name: 'deact-skill',
        description: 'Skill to deactivate',
      },
      '# Instructions',
    )

    discoverSkills(['core'], FIXTURES)

    // Activate then deactivate
    await activateSkill('deact-skill')
    expect(listSkills().find((s) => s.name === 'deact-skill')?.active).toBe(true)

    const result = deactivateSkill('deact-skill')
    expect(result.ok).toBe(true)
    expect(listSkills().find((s) => s.name === 'deact-skill')?.active).toBe(false)
  })

  test('deactivateSkill returns error for unknown skill', () => {
    const result = deactivateSkill('nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('not found')
    }
  })

  test('activateSkill returns error for unknown skill', async () => {
    const result = await activateSkill('nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('not found')
    }
  })

  // -----------------------------------------------------------------------
  // Tool interface (execute function)
  // -----------------------------------------------------------------------
  test('tool execute: list action returns skills', async () => {
    const skillDir = join(FIXTURES, 'core', 'tool-skill')

    writeSkillMd(
      skillDir,
      {
        name: 'tool-skill',
        description: 'A skill for tool test',
      },
      '# Instructions',
    )

    discoverSkills(['core'], FIXTURES)

    const result = await execute(schema.parse({ action: 'list' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { skills: Array<{ name: string }>; message: string }
      expect(value.skills).toHaveLength(1)
      expect(value.skills[0].name).toBe('tool-skill')
      expect(value.message).toContain('1 skill(s)')
    }
  })

  test('tool schema: activate action requires skill parameter', () => {
    const result = schema.safeParse({ action: 'activate' })
    expect(result.success).toBe(false)
  })

  test('tool schema: deactivate action requires skill parameter', () => {
    const result = schema.safeParse({ action: 'deactivate' })
    expect(result.success).toBe(false)
  })

  test('tool execute: info action returns skill metadata', async () => {
    const skillDir = join(FIXTURES, 'core', 'info-skill')

    writeSkillMd(
      skillDir,
      {
        name: 'info-skill',
        description: 'A skill for info test',
        license: 'Apache-2.0',
      },
      '# Instructions',
    )

    discoverSkills(['core'], FIXTURES)

    const result = await execute(schema.parse({ action: 'info', skill: 'info-skill' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { frontmatter: { license: string } }
      expect(value.frontmatter.license).toBe('Apache-2.0')
    }
  })

  test('tool schema: info action requires skill parameter', () => {
    const result = schema.safeParse({ action: 'info' })
    expect(result.success).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Staging directory support
  // -----------------------------------------------------------------------
  test('discovery assigns staging status to skills in staging directory', () => {
    const stagingDir = join(FIXTURES, 'staging', 'staged-skill')

    writeSkillMd(
      stagingDir,
      {
        name: 'staged-skill',
        description: 'A staging skill',
      },
      '# Staging instructions',
    )

    discoverSkills(['staging'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].status).toBe('staging')
  })

  // -----------------------------------------------------------------------
  // Catalog export format
  // -----------------------------------------------------------------------
  test('getSkillCatalog returns clean objects with only name, description, status', () => {
    const skillDir = join(FIXTURES, 'core', 'catalog-skill')

    writeSkillMd(
      skillDir,
      {
        name: 'catalog-skill',
        description: 'For catalog format test',
        license: 'MIT',
        metadata: { author: 'test' },
      },
      '# Instructions',
    )

    discoverSkills(['core'], FIXTURES)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)

    const entry = catalog[0]
    expect(Object.keys(entry).sort()).toEqual(['description', 'name', 'status'])
    expect(entry.name).toBe('catalog-skill')
    expect(entry.description).toBe('For catalog format test')
    expect(entry.status).toBe('core')
  })

  // -----------------------------------------------------------------------
  // YAML sanitization fallback — tab-indented frontmatter loads after the
  // second-pass parse. Without the fallback the skill would be silently
  // dropped from discovery, hiding it from the LLM.
  // -----------------------------------------------------------------------
  test('sanitization fallback recovers tab-indented frontmatter', () => {
    const skillDir = join(FIXTURES, 'core', 'tabbed-skill')
    mkdirSync(skillDir, { recursive: true })
    // Tabs in YAML are illegal — strict parse fails, sanitized parse succeeds.
    const content = `---\nname: tabbed-skill\ndescription: Skill with tab indentation\nmetadata:\n\tauthor: test\n---\n# Body\n`
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')

    discoverSkills(['core'], FIXTURES)

    const info = getSkillInfo('tabbed-skill')
    expect(info.ok).toBe(true)
    if (info.ok) {
      expect(info.value.frontmatter.metadata).toEqual({ author: 'test' })
    }
  })

  test('truly invalid YAML still fails after sanitization', () => {
    const skillDir = join(FIXTURES, 'core', 'broken-yaml')
    mkdirSync(skillDir, { recursive: true })
    const content = `---\nname: broken\ndescription: "unterminated\n---\n# Body\n`
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')

    discoverSkills(['core'], FIXTURES)
    expect(getSkillCatalog()).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Tier 2.5: Industry-standard global skill roots — `~/.claude/skills/`
  // and `~/.agents/skills/`. Tests use OUROBOROS_USER_SKILLS_DIRS to point
  // at temp directories instead of the real home folder.
  // -----------------------------------------------------------------------
  test('discoverConfiguredSkills picks up skills from user-global roots', () => {
    const claudeRoot = join(FIXTURES, 'claude-skills')
    const agentsRoot = join(FIXTURES, 'agents-skills')
    writeSkillMd(
      join(claudeRoot, 'claude-skill'),
      { name: 'claude-skill', description: 'From ~/.claude/skills' },
      '# Body',
    )
    writeSkillMd(
      join(agentsRoot, 'agents-skill'),
      { name: 'agents-skill', description: 'From ~/.agents/skills' },
      '# Body',
    )

    const previous = process.env.OUROBOROS_USER_SKILLS_DIRS
    process.env.OUROBOROS_USER_SKILLS_DIRS = `${agentsRoot}:${claudeRoot}`
    try {
      discoverConfiguredSkills([])

      const catalog = getSkillCatalog()
      const names = catalog.map((s) => s.name).sort()
      expect(names).toContain('claude-skill')
      expect(names).toContain('agents-skill')
    } finally {
      if (previous === undefined) {
        delete process.env.OUROBOROS_USER_SKILLS_DIRS
      } else {
        process.env.OUROBOROS_USER_SKILLS_DIRS = previous
      }
    }
  })

  test('project skills override user-global skills on name collision', () => {
    const claudeRoot = join(FIXTURES, 'claude-skills')
    writeSkillMd(
      join(claudeRoot, 'shared'),
      { name: 'shared', description: 'Global version' },
      '# Global',
    )
    writeSkillMd(
      join(FIXTURES, 'core', 'shared'),
      { name: 'shared', description: 'Project version' },
      '# Project',
    )

    const previous = process.env.OUROBOROS_USER_SKILLS_DIRS
    process.env.OUROBOROS_USER_SKILLS_DIRS = claudeRoot
    try {
      discoverConfiguredSkills(['core'], FIXTURES)
      const info = getSkillInfo('shared')
      expect(info.ok).toBe(true)
      if (info.ok) {
        expect(info.value.description).toBe('Project version')
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OUROBOROS_USER_SKILLS_DIRS
      } else {
        process.env.OUROBOROS_USER_SKILLS_DIRS = previous
      }
    }
  })

  test('OUROBOROS_USER_SKILLS_DIRS=empty disables user-global discovery', () => {
    const previousUser = process.env.OUROBOROS_USER_SKILLS_DIRS
    const previousBuiltin = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    process.env.OUROBOROS_USER_SKILLS_DIRS = ''
    delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    try {
      // No project, no builtin, no user roots — empty catalog.
      discoverConfiguredSkills([])
      expect(getSkillCatalog()).toHaveLength(0)
    } finally {
      if (previousUser === undefined) {
        delete process.env.OUROBOROS_USER_SKILLS_DIRS
      } else {
        process.env.OUROBOROS_USER_SKILLS_DIRS = previousUser
      }
      if (previousBuiltin === undefined) {
        delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      } else {
        process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousBuiltin
      }
    }
  })

  // -----------------------------------------------------------------------
  // Tier 2.7: Approval gate via `requiresApproval` frontmatter flag.
  // -----------------------------------------------------------------------
  test('activateSkill denies a requiresApproval skill when no handler is registered', async () => {
    const skillDir = join(FIXTURES, 'core', 'guarded-skill')
    writeSkillMd(
      skillDir,
      {
        name: 'guarded-skill',
        description: 'Skill that must be approved',
        requiresApproval: true,
      },
      '# Body',
    )
    discoverSkills(['core'], FIXTURES)

    const result = await activateSkill('guarded-skill')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('approval')
    }
  })

  test('activateSkill activates a requiresApproval skill when handler approves', async () => {
    const skillDir = join(FIXTURES, 'core', 'approved-skill')
    writeSkillMd(
      skillDir,
      {
        name: 'approved-skill',
        description: 'Approved by the handler',
        requiresApproval: true,
      },
      '# Approved body',
    )
    discoverSkills(['core'], FIXTURES)

    setSkillApprovalHandler(async () => ({ ok: true, value: { approved: true } }))

    const result = await activateSkill('approved-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.instructions).toContain('Approved body')
    }
  })

  test('activateSkill fails with the handler-supplied reason when denied', async () => {
    const skillDir = join(FIXTURES, 'core', 'denied-skill')
    writeSkillMd(
      skillDir,
      {
        name: 'denied-skill',
        description: 'Will be denied',
        requiresApproval: true,
      },
      '# Body',
    )
    discoverSkills(['core'], FIXTURES)

    setSkillApprovalHandler(async () => ({
      ok: true,
      value: { approved: false, reason: 'rejected by user' },
    }))

    const result = await activateSkill('denied-skill')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('rejected by user')
    }
  })

  test('activateSkill bypasses approval when bypassApproval is set', async () => {
    const skillDir = join(FIXTURES, 'core', 'bypass-skill')
    writeSkillMd(
      skillDir,
      {
        name: 'bypass-skill',
        description: 'Should activate without prompting',
        requiresApproval: true,
      },
      '# Direct body',
    )
    discoverSkills(['core'], FIXTURES)

    let handlerCalled = false
    setSkillApprovalHandler(async () => {
      handlerCalled = true
      return { ok: true, value: { approved: true } }
    })

    const result = await activateSkill('bypass-skill', { bypassApproval: true })
    expect(result.ok).toBe(true)
    expect(handlerCalled).toBe(false)
  })
})
