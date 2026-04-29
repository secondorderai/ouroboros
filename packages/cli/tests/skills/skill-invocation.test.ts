import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  parseSlashSkillInvocation,
  resolveSlashSkillInvocation,
  activateSkillForRun,
} from '@src/skills/skill-invocation'
import {
  _resetSkills,
  _resetSkillApprovalHandler,
  setSkillApprovalHandler,
} from '@src/tools/skill-manager'
import type { OuroborosConfig } from '@src/config'

const FIXTURES = resolve(import.meta.dir, '../fixtures/skill-invocation-test')

function makeConfig(): OuroborosConfig {
  return {
    model: { provider: 'anthropic', name: 'claude-opus-4-7' },
    permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
    skillDirectories: ['skills/core'],
    disabledSkills: [],
    agent: {
      maxSteps: { interactive: 50, desktop: 50, singleShot: 50, automation: 50 },
      allowedTestCommands: [],
      definitions: [],
    },
    memory: {
      consolidationSchedule: 'session-end',
      contextWindowTokens: 200_000,
      warnRatio: 0.7,
      flushRatio: 0.8,
      compactRatio: 0.9,
      tailMessageCount: 12,
      dailyLoadDays: 2,
      durableMemoryBudgetTokens: 1500,
      checkpointBudgetTokens: 1200,
      workingMemoryBudgetTokens: 1000,
    },
    rsi: {
      noveltyThreshold: 0.7,
      autoReflect: true,
      observeEveryTurns: 1,
      checkpointEveryTurns: 6,
      durablePromotionThreshold: 0.8,
      crystallizeFromRepeatedPatternsOnly: true,
    },
    artifacts: {
      cdnAllowlist: [
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
        'https://cdnjs.cloudflare.com',
      ],
      maxBytes: 1_048_576,
    },
    mcp: { servers: [] },
  }
}

describe('slash skill invocation parsing', () => {
  test('parses a leading slash skill and strips the token from the message', () => {
    const result = parseSlashSkillInvocation('/code-review review this file', ['code-review'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      skillName: 'code-review',
      message: 'review this file',
    })
  })

  test('leaves normal messages unchanged', () => {
    const result = parseSlashSkillInvocation('review this file', ['code-review'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ message: 'review this file' })
  })

  test('preserves reserved plan command for existing CLI handling', () => {
    const result = parseSlashSkillInvocation('/plan implement this', ['plan'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ message: '/plan implement this' })
  })

  test('does not reserve skill names that merely start with plan', () => {
    const result = parseSlashSkillInvocation('/planets analyze orbit data', ['planets'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      skillName: 'planets',
      message: 'analyze orbit data',
    })
  })

  test('rejects unknown leading slash skills', () => {
    const result = parseSlashSkillInvocation('/missing do this', ['code-review'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Unknown skill "missing"')
  })
})

describe('activateSkillForRun bypasses approval', () => {
  beforeEach(() => {
    _resetSkills()
    _resetSkillApprovalHandler()
    rmSync(FIXTURES, { recursive: true, force: true })
  })

  afterEach(() => {
    _resetSkills()
    _resetSkillApprovalHandler()
    rmSync(FIXTURES, { recursive: true, force: true })
  })

  test('user-initiated slash invocation skips the approval handler', async () => {
    const skillDir = join(FIXTURES, 'skills', 'core', 'guarded')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: guarded',
        'description: Requires approval normally',
        'requiresApproval: true',
        '---',
        '# Guarded body',
      ].join('\n'),
      'utf-8',
    )

    let handlerCalled = false
    setSkillApprovalHandler(async () => {
      handlerCalled = true
      return { ok: true, value: { approved: true } }
    })

    const result = await activateSkillForRun('guarded', makeConfig(), FIXTURES)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.instructions).toContain('Guarded body')
    }
    // The user's slash command IS the approval — handler must NOT fire.
    expect(handlerCalled).toBe(false)
  })

  test('disabled skills are unavailable to slash invocation and activation', async () => {
    const skillDir = join(FIXTURES, 'skills', 'core', 'disabled')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: disabled', 'description: Disabled skill', '---', '# Disabled body'].join('\n'),
      'utf-8',
    )

    const config = { ...makeConfig(), disabledSkills: ['disabled'] }
    const parsed = resolveSlashSkillInvocation('/disabled run this', config, FIXTURES)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.message).toContain('Unknown skill "disabled"')

    const activation = await activateSkillForRun('disabled', config, FIXTURES)
    expect(activation.ok).toBe(false)
    if (activation.ok) return
    expect(activation.error.message).toContain('Skill disabled')
  })
})
