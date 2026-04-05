import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  discoverSkills,
  getSkillCatalog,
  activateSkill,
  deactivateSkill,
  listSkills,
  getSkillInfo,
  _resetSkills,
  execute,
  schema,
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
    // Clean up any leftover fixtures
    rmSync(FIXTURES, { recursive: true, force: true })
  })

  afterEach(() => {
    _resetSkills()
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
  test('activateSkill returns full instructions without frontmatter', () => {
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

    const result = activateSkill('instruction-skill')
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
  test('activateSkill reads REFERENCE.md when mentioned in body', () => {
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

    const result = activateSkill('ref-skill')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.references).toHaveLength(1)
      expect(result.value.references[0]).toContain('Detailed API reference.')
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
  // Feature test: List shows active/inactive status
  // -----------------------------------------------------------------------
  test('listSkills shows active/inactive status correctly', () => {
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
    activateSkill('skill-a')

    const allSkills = listSkills()
    expect(allSkills).toHaveLength(2)

    const skillAEntry = allSkills.find((s) => s.name === 'skill-a')
    const skillBEntry = allSkills.find((s) => s.name === 'skill-b')

    expect(skillAEntry?.active).toBe(true)
    expect(skillBEntry?.active).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Deactivation
  // -----------------------------------------------------------------------
  test('deactivateSkill marks skill as inactive', () => {
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
    activateSkill('deact-skill')
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

  test('activateSkill returns error for unknown skill', () => {
    const result = activateSkill('nonexistent')
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

  test('tool execute: activate action requires skill parameter', async () => {
    const result = await execute(schema.parse({ action: 'activate' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('"skill" parameter is required')
    }
  })

  test('tool execute: deactivate action requires skill parameter', async () => {
    const result = await execute(schema.parse({ action: 'deactivate' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('"skill" parameter is required')
    }
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

  test('tool execute: info action requires skill parameter', async () => {
    const result = await execute(schema.parse({ action: 'info' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('"skill" parameter is required')
    }
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
})
