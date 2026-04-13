import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAgentsMdInstructions, resolveAgentsMdFiles } from '@src/agents-md'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-agents-md-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('agents-md discovery', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('returns no entries when AGENTS.md is absent', () => {
    expect(resolveAgentsMdFiles(tempDir)).toEqual([])
    expect(getAgentsMdInstructions(tempDir)).toBe('')
  })

  test('discovers a root AGENTS.md from a nested workspace folder', () => {
    const repoDir = join(tempDir, 'repo')
    const workspaceDir = join(repoDir, 'packages', 'cli')
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(join(repoDir, 'AGENTS.md'), '# Root instructions\n\nBe careful.')

    const entries = resolveAgentsMdFiles(workspaceDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe(join(repoDir, 'AGENTS.md'))
    expect(entries[0]?.content).toContain('Root instructions')
  })

  test('stacks ancestor and nearest AGENTS.md files in root-to-nearest order', () => {
    const repoDir = join(tempDir, 'repo')
    const packageDir = join(repoDir, 'packages', 'desktop')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(repoDir, 'AGENTS.md'), '# Root instructions\n\nRoot policy.')
    writeFileSync(join(packageDir, 'AGENTS.md'), '# Package instructions\n\nPackage policy.')

    const entries = resolveAgentsMdFiles(packageDir)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.path).toBe(join(repoDir, 'AGENTS.md'))
    expect(entries[1]?.path).toBe(join(packageDir, 'AGENTS.md'))

    const instructions = getAgentsMdInstructions(packageDir)
    expect(instructions).toContain(`### ancestor: ${join(repoDir, 'AGENTS.md')}`)
    expect(instructions).toContain('Root policy.')
    expect(instructions).toContain(`### nearest: ${join(packageDir, 'AGENTS.md')}`)
    expect(instructions).toContain('Package policy.')
    expect(instructions.indexOf('Root policy.')).toBeLessThan(
      instructions.indexOf('Package policy.'),
    )
  })
})
