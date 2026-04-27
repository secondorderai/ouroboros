/**
 * Integration Test: Agent + Skills
 *
 * Verifies that the skill catalog appears in the system prompt,
 * that skills can be activated to load full instructions,
 * and that the agent can use activated skill instructions.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Agent } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import {
  discoverSkills,
  getSkillCatalog,
  activateSkill,
  _resetSkills,
  setSkillActivatedHandler,
  _resetSkillActivatedHandler,
} from '@src/tools/skill-manager'
import { buildSystemPrompt } from '@src/llm/prompt'
import { createInspectingMockModel, textBlock, finishStop } from '../helpers/mock-llm'
import {
  makeTempDir,
  cleanupTempDir,
  createTestSkill,
  makeAgentOptions,
} from '../helpers/test-utils'

describe('Agent + Skills Integration', () => {
  let tempDir: string
  let registry: ToolRegistry

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-skills-test')
    registry = new ToolRegistry()
    _resetSkills()
    _resetSkillActivatedHandler()
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    _resetSkills()
    _resetSkillActivatedHandler()
  })

  // -------------------------------------------------------------------
  // Test: Skill catalog appears in system prompt
  // -------------------------------------------------------------------
  test('skill catalog appears in system prompt after discovery', () => {
    // Create test skills
    createTestSkill(
      tempDir,
      'code-review',
      'Review code for quality and bugs',
      '## Instructions\nReview all code carefully.',
    )
    createTestSkill(
      tempDir,
      'summarizer',
      'Summarize text content',
      '## Instructions\nCreate concise summaries.',
    )

    // Discover skills
    const skillDirs = [`${tempDir}/skills/core`]
    discoverSkills(skillDirs, tempDir)

    // Get catalog
    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(2)

    // Build system prompt with skills
    const prompt = buildSystemPrompt({
      skills: catalog.map((s) => ({ name: s.name, description: s.description })),
    })

    // Verify skills appear in the prompt
    expect(prompt).toContain('## Skills')
    expect(prompt).toContain('code-review')
    expect(prompt).toContain('Review code for quality and bugs')
    expect(prompt).toContain('summarizer')
    expect(prompt).toContain('Summarize text content')
  })

  // -------------------------------------------------------------------
  // Test: Agent can activate a skill (full instructions loaded)
  // -------------------------------------------------------------------
  test('agent can activate a skill and receive full instructions', async () => {
    const body = `## Code Review Instructions

1. Check for bugs and edge cases
2. Verify error handling
3. Ensure consistent style
4. Look for security issues`

    createTestSkill(tempDir, 'code-review', 'Review code for quality', body)

    discoverSkills([`${tempDir}/skills/core`], tempDir)

    // Verify catalog has the skill
    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].name).toBe('code-review')

    // Activate the skill
    const result = await activateSkill('code-review')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Verify full instructions are returned
    expect(result.value.name).toBe('code-review')
    expect(result.value.instructions).toContain('Check for bugs and edge cases')
    expect(result.value.instructions).toContain('Verify error handling')
    expect(result.value.instructions).toContain('security issues')
  })

  // -------------------------------------------------------------------
  // Test: Agent uses skill catalog in system prompt during a task
  // -------------------------------------------------------------------
  test('agent uses skill catalog in system prompt during a task', async () => {
    createTestSkill(
      tempDir,
      'web-search',
      'Search the web for information',
      '## Instructions\nUse web search API.',
    )

    discoverSkills([`${tempDir}/skills/core`], tempDir)

    let capturedSystemPrompt = ''

    const model = createInspectingMockModel((prompt, _callIndex) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((m) => m.role === 'system')
      if (systemMsg) {
        capturedSystemPrompt = String(
          Array.isArray(systemMsg.content)
            ? (systemMsg.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : systemMsg.content,
        )
      }
      return [...textBlock('I can see the available skills.'), finishStop()]
    })

    const catalog = getSkillCatalog()
    const agent = new Agent(
      makeAgentOptions(model, registry, {
        systemPromptBuilder: buildSystemPrompt,
        skillCatalogProvider: () => catalog,
      }),
    )

    await agent.run('What skills do you have?')

    // System prompt should contain the skill
    expect(capturedSystemPrompt).toContain('## Skills')
    expect(capturedSystemPrompt).toContain('web-search')
    expect(capturedSystemPrompt).toContain('Search the web for information')
  })

  // -------------------------------------------------------------------
  // Test: Skill activation returns full instructions to the agent
  // -------------------------------------------------------------------
  test('skill activation via tool returns full instructions for context injection', async () => {
    const skillBody = `## Detailed Review Steps

Step 1: Read the code thoroughly
Step 2: Check for logic errors
Step 3: Validate input handling
Step 4: Report findings`

    createTestSkill(tempDir, 'detailed-review', 'Detailed code review', skillBody)
    discoverSkills([`${tempDir}/skills/core`], tempDir)

    // Activate and verify full body is returned
    const activation = await activateSkill('detailed-review')
    expect(activation.ok).toBe(true)
    if (!activation.ok) return

    expect(activation.value.instructions).toContain('Detailed Review Steps')
    expect(activation.value.instructions).toContain('Step 1: Read the code thoroughly')
    expect(activation.value.instructions).toContain('Step 4: Report findings')
  })

  // -------------------------------------------------------------------
  // Test: Non-existent skill activation returns error
  // -------------------------------------------------------------------
  test('activating a non-existent skill returns an error', async () => {
    discoverSkills([`${tempDir}/skills/core`], tempDir)

    const result = await activateSkill('non-existent-skill')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
  })

  // -------------------------------------------------------------------
  // Regression test: built-in skills shipped via OUROBOROS_BUILTIN_SKILLS_DIR
  // must reach the LLM's system prompt during a normal agent turn — the
  // agent's per-turn discoverSkills call previously ignored the env var,
  // so meta-thinking and other bundled skills were invisible to the LLM
  // even though the desktop picker listed them.
  // -------------------------------------------------------------------
  test('built-in skills from OUROBOROS_BUILTIN_SKILLS_DIR appear in the system prompt', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const builtinRoot = join(tempDir, 'builtin')
    const builtinSkillDir = join(builtinRoot, 'meta-thinking')
    mkdirSync(builtinSkillDir, { recursive: true })
    writeFileSync(
      join(builtinSkillDir, 'SKILL.md'),
      `---
name: meta-thinking
description: Use when the user needs structured planning or complex analysis
---

# Meta Thinking
Apply the SecondOrder method.`,
      'utf-8',
    )

    let capturedSystemPrompt = ''

    const model = createInspectingMockModel((prompt) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find((m) => m.role === 'system')
      if (systemMsg) {
        capturedSystemPrompt = String(
          Array.isArray(systemMsg.content)
            ? (systemMsg.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : systemMsg.content,
        )
      }
      return [...textBlock('Acknowledged.'), finishStop()]
    })

    // Important: do NOT override skillCatalogProvider here. We want the agent
    // to use the real getSkillCatalog so the discovery path is actually
    // exercised end-to-end.
    const previous = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
    process.env.OUROBOROS_BUILTIN_SKILLS_DIR = builtinRoot
    try {
      const agent = new Agent({
        model,
        toolRegistry: registry,
        systemPromptBuilder: buildSystemPrompt,
        memoryProvider: () => '',
        basePath: tempDir,
        config: {
          model: { provider: 'anthropic', name: 'claude-opus-4-7' },
          permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
          // No core/generated skills in this temp dir — only the env-var source.
          skillDirectories: ['skills/core', 'skills/generated'],
          agent: {
            maxSteps: { interactive: 5, desktop: 5, singleShot: 5, automation: 5 },
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
        },
      })

      await agent.run('Perform complex analysis on two LLMs')
    } finally {
      if (previous === undefined) {
        delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      } else {
        process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previous
      }
    }

    expect(capturedSystemPrompt).toContain('## Skills')
    expect(capturedSystemPrompt).toContain('meta-thinking')
    expect(capturedSystemPrompt).toContain('structured planning or complex analysis')
    // And the auto-trigger directive must be present so the LLM knows to act.
    expect(capturedSystemPrompt).toContain('skill-manager')
    expect(capturedSystemPrompt).toContain('"action": "activate"')
  })

  // -------------------------------------------------------------------
  // Test: Empty skill directories produce empty catalog
  // -------------------------------------------------------------------
  test('empty skill directories produce an empty catalog', () => {
    discoverSkills([`${tempDir}/skills/core`], tempDir)

    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(0)

    // System prompt should not have Skills section when catalog is empty
    const prompt = buildSystemPrompt({
      skills: catalog.map((s) => ({ name: s.name, description: s.description })),
    })
    expect(prompt).not.toContain('## Skills')
  })

  // -------------------------------------------------------------------
  // Tier 1.3: Activation dedup at the skill-manager handler level. The
  // skill-manager tests cover the in-process notification dedup; here we
  // verify the activated-skill returns identical content (no re-read of
  // the body) so re-activation is cheap as well as idempotent.
  // -------------------------------------------------------------------
  test('repeated activation returns the same body without re-firing the handler', async () => {
    createTestSkill(
      tempDir,
      'idempotent-skill',
      'Skill body should be returned identically on re-activation',
      '## Body\n\nDeterministic content.',
    )
    discoverSkills([`${tempDir}/skills/core`], tempDir)

    const handlerCalls: string[] = []
    setSkillActivatedHandler((name) => handlerCalls.push(name))

    const first = await activateSkill('idempotent-skill')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await activateSkill('idempotent-skill')
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(second.value.instructions).toBe(first.value.instructions)
    expect(handlerCalls).toEqual(['idempotent-skill'])
  })
})
