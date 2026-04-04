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
  _resetSkills
} from '@src/tools/skill-manager'
import { buildSystemPrompt } from '@src/llm/prompt'
import type { LanguageModelV1StreamPart } from 'ai'
import {
  createMockModel,
  createInspectingMockModel,
  textDelta,
  toolCall,
  finishStop,
  finishToolCalls
} from '../helpers/mock-llm'
import {
  makeTempDir,
  cleanupTempDir,
  createTestSkill,
  collectEvents,
  makeAgentOptions
} from '../helpers/test-utils'

describe('Agent + Skills Integration', () => {
  let tempDir: string
  let registry: ToolRegistry

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-skills-test')
    registry = new ToolRegistry()
    _resetSkills()
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    _resetSkills()
  })

  // -------------------------------------------------------------------
  // Test: Skill catalog appears in system prompt
  // -------------------------------------------------------------------
  test('skill catalog appears in system prompt after discovery', () => {
    // Create test skills
    createTestSkill(tempDir, 'code-review', 'Review code for quality and bugs', '## Instructions\nReview all code carefully.')
    createTestSkill(tempDir, 'summarizer', 'Summarize text content', '## Instructions\nCreate concise summaries.')

    // Discover skills
    const skillDirs = [`${tempDir}/skills/core`]
    discoverSkills(skillDirs, tempDir)

    // Get catalog
    const catalog = getSkillCatalog()
    expect(catalog).toHaveLength(2)

    // Build system prompt with skills
    const prompt = buildSystemPrompt({
      skills: catalog.map(s => ({ name: s.name, description: s.description }))
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
  test('agent can activate a skill and receive full instructions', () => {
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
    const result = activateSkill('code-review')
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
    createTestSkill(tempDir, 'web-search', 'Search the web for information', '## Instructions\nUse web search API.')

    discoverSkills([`${tempDir}/skills/core`], tempDir)

    let capturedSystemPrompt = ''

    const model = createInspectingMockModel((prompt, _callIndex) => {
      const messages = prompt as Array<{ role: string; content: unknown }>
      const systemMsg = messages.find(m => m.role === 'system')
      if (systemMsg) {
        capturedSystemPrompt = String(
          Array.isArray(systemMsg.content)
            ? (systemMsg.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
            : systemMsg.content
        )
      }
      return [textDelta('I can see the available skills.'), finishStop()]
    })

    const catalog = getSkillCatalog()
    const agent = new Agent(
      makeAgentOptions(model, registry, {
        systemPromptBuilder: buildSystemPrompt,
        skillCatalogProvider: () => catalog
      })
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
    const activation = activateSkill('detailed-review')
    expect(activation.ok).toBe(true)
    if (!activation.ok) return

    expect(activation.value.instructions).toContain('Detailed Review Steps')
    expect(activation.value.instructions).toContain('Step 1: Read the code thoroughly')
    expect(activation.value.instructions).toContain('Step 4: Report findings')
  })

  // -------------------------------------------------------------------
  // Test: Non-existent skill activation returns error
  // -------------------------------------------------------------------
  test('activating a non-existent skill returns an error', () => {
    discoverSkills([`${tempDir}/skills/core`], tempDir)

    const result = activateSkill('non-existent-skill')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
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
      skills: catalog.map(s => ({ name: s.name, description: s.description }))
    })
    expect(prompt).not.toContain('## Skills')
  })
})
