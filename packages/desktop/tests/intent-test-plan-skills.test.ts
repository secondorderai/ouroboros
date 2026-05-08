import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const repoRoot = resolve(import.meta.dir, '../../..')

describe('intent test plan skills', () => {
  test('author skill documents the required charter shape and runner commands', async () => {
    const skill = await readFile(
      resolve(repoRoot, '.agents/skills/ouroboros-test-plan-author/SKILL.md'),
      'utf8',
    )

    expect(skill).toContain('name: ouroboros-test-plan-author')
    expect(skill).toContain('## Mission')
    expect(skill).toContain('## Intent Steps')
    expect(skill).toContain('## Expected Outcomes')
    expect(skill).toContain('bun run test:intent:e2e -- test-plan/<name>.md --dry-run')
  })
})
