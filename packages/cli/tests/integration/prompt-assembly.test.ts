/**
 * Integration Test: Prompt + Tools + Skills
 *
 * Verifies that the system prompt correctly assembles all sections
 * (base, tools, skills, memory), handles empty sections cleanly,
 * and stays within reasonable size limits.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { buildSystemPrompt } from '@src/llm/prompt'
import { loadLayeredMemory } from '@src/memory/loaders'
import { ToolRegistry } from '@src/tools/registry'
import { discoverSkills, getSkillCatalog, _resetSkills } from '@src/tools/skill-manager'
import { getMemoryIndex } from '@src/memory/index'
import { writeCheckpoint } from '@src/memory/checkpoints'
import { resolveDailyMemoryPath } from '@src/memory/paths'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ok } from '@src/types'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  makeTempDir,
  cleanupTempDir,
  createTestSkill,
  setupMemoryDir,
  makeTool,
} from '../helpers/test-utils'

describe('Prompt + Tools + Skills Assembly', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-prompt-test')
    _resetSkills()
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    _resetSkills()
  })

  // -------------------------------------------------------------------
  // Test: System prompt correctly assembles all sections
  // -------------------------------------------------------------------
  test('system prompt correctly assembles all sections (base, tools, skills, memory)', () => {
    // Set up tools
    const registry = new ToolRegistry()
    registry.register(makeTool('bash'))
    registry.register(makeTool('file-read'))
    const tools = registry.getTools()

    // Set up skills
    createTestSkill(tempDir, 'web-search', 'Search the web', '## Instructions\nSearch effectively.')
    createTestSkill(tempDir, 'code-gen', 'Generate code', '## Instructions\nGenerate clean code.')
    discoverSkills([`${tempDir}/skills/core`], tempDir)
    const skills = getSkillCatalog().map((s) => ({
      name: s.name,
      description: s.description,
    }))

    // Set up memory
    setupMemoryDir(tempDir, '# Memory Index\n\n## Topics\n- architecture: System design notes')
    const memoryResult = getMemoryIndex(tempDir)
    const memory = memoryResult.ok ? memoryResult.value : ''

    // Build the prompt
    const prompt = buildSystemPrompt({ tools, skills, memory })

    // Verify all sections are present
    expect(prompt).toContain('You are Ouroboros') // Base instructions
    expect(prompt).toContain('## Available Tools') // Tools section
    expect(prompt).toContain('bash') // Tool name
    expect(prompt).toContain('file-read') // Tool name
    expect(prompt).toContain('## Skills') // Skills section
    expect(prompt).toContain('web-search') // Skill name
    expect(prompt).toContain('code-gen') // Skill name
    expect(prompt).toContain('## Memory Context') // Memory section
    expect(prompt).toContain('architecture: System design notes') // Memory content

    // Verify sections appear in correct order
    const baseIdx = prompt.indexOf('You are Ouroboros')
    const toolsIdx = prompt.indexOf('## Available Tools')
    const skillsIdx = prompt.indexOf('## Skills')
    const memoryIdx = prompt.indexOf('## Memory Context')

    expect(baseIdx).toBeLessThan(toolsIdx)
    expect(toolsIdx).toBeLessThan(skillsIdx)
    expect(skillsIdx).toBeLessThan(memoryIdx)
  })

  // -------------------------------------------------------------------
  // Test: Prompt remains valid when sections are empty
  // -------------------------------------------------------------------
  test('prompt remains valid when all optional sections are empty', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      skills: [],
      memory: '',
    })

    // Base instructions should still be there
    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).toContain('ReAct')

    // Optional sections should NOT appear
    expect(prompt).not.toContain('## Available Tools')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('prompt remains valid when sections are undefined', () => {
    const prompt = buildSystemPrompt({})

    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).not.toContain('## Available Tools')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('prompt remains valid with only tools provided', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('test-tool'))
    const tools = registry.getTools()

    const prompt = buildSystemPrompt({ tools })

    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).toContain('## Available Tools')
    expect(prompt).toContain('test-tool')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('prompt remains valid with only skills provided', () => {
    createTestSkill(tempDir, 'only-skill', 'The only skill', '## Body')
    discoverSkills([`${tempDir}/skills/core`], tempDir)
    const skills = getSkillCatalog().map((s) => ({
      name: s.name,
      description: s.description,
    }))

    const prompt = buildSystemPrompt({ skills })

    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).not.toContain('## Available Tools')
    expect(prompt).toContain('## Skills')
    expect(prompt).toContain('only-skill')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('prompt remains valid with only memory provided', () => {
    const prompt = buildSystemPrompt({ memory: '# My Memory\n\nSome context here.' })

    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).not.toContain('## Available Tools')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).toContain('## Memory Context')
    expect(prompt).toContain('Some context here.')
  })

  // -------------------------------------------------------------------
  // Test: Prompt size is reasonable (under token limit warnings)
  // -------------------------------------------------------------------
  test('prompt size is reasonable (under token limit warnings)', () => {
    // Build a fully-loaded prompt with realistic content
    const registry = new ToolRegistry()
    registry.register(makeTool('bash'))
    registry.register(makeTool('file-read'))
    registry.register(makeTool('file-write'))
    registry.register(makeTool('file-edit'))
    registry.register(makeTool('web-search'))
    registry.register(makeTool('web-fetch'))
    registry.register(makeTool('memory'))
    registry.register(makeTool('todo'))
    const tools = registry.getTools()

    const skills = [
      { name: 'code-review', description: 'Review code for quality and bugs' },
      { name: 'web-search', description: 'Search the web for information' },
      { name: 'summarizer', description: 'Summarize text content' },
      { name: 'code-gen', description: 'Generate code from specifications' },
    ]

    const memory = `# Memory Index

## Topics
- architecture: System design patterns used in the project
- user-preferences: Known user preferences and settings
- recent-sessions: Summary of recent interactions

## Recent Notes
- The project uses TypeScript with Bun runtime
- Prefers functional style over OOP`

    const prompt = buildSystemPrompt({ tools, skills, memory })

    // A rough token estimate: ~4 chars per token
    const estimatedTokens = prompt.length / 4

    // The prompt should be well under 8K tokens for a base system prompt
    // (Leaving plenty of room for conversation in a 128K context window)
    expect(estimatedTokens).toBeLessThan(8000)

    // But it should have meaningful content (at least 500 tokens)
    expect(estimatedTokens).toBeGreaterThan(500)
  })

  // -------------------------------------------------------------------
  // Test: Tool metadata omits duplicate JSON Schema parameters
  // -------------------------------------------------------------------
  test('tool metadata omits JSON Schema parameters from the prompt by default', () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'detailed-tool',
      description: 'A tool with detailed schema',
      schema: z.object({
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional(),
      }),
      execute: async () => ok('done'),
    })

    const tools = registry.getTools()
    const prompt = buildSystemPrompt({ tools })

    // Parameters are passed to the provider through native tool definitions.
    expect(prompt).not.toContain('"path"')
    expect(prompt).not.toContain('"content"')
    expect(prompt).not.toContain('Parameters')
    expect(prompt).toContain('native tool definitions')
  })

  // -------------------------------------------------------------------
  // Test: Whitespace-only memory is omitted
  // -------------------------------------------------------------------
  test('whitespace-only memory does not add a section', () => {
    const prompt = buildSystemPrompt({ memory: '   \n\n   ' })

    expect(prompt).not.toContain('## Memory Context')
  })

  test('layered memory sections appear in durable-checkpoint-working order', () => {
    setupMemoryDir(tempDir, '# Memory Index\n\n## Durable Facts\n- Stable fact')
    writeCheckpoint(
      {
        sessionId: 'prompt-session',
        updatedAt: '2026-04-15T11:00:00.000Z',
        goal: 'Verify prompt ordering',
        currentPlan: ['Load sections'],
        constraints: ['Keep AGENTS intact'],
        decisionsMade: ['Use layered memory'],
        filesInPlay: ['prompt.ts'],
        completedWork: [],
        openLoops: ['Need assertion'],
        nextBestStep: 'Check prompt order',
        durableMemoryCandidates: [],
        skillCandidates: [],
      },
      tempDir,
    )
    mkdirSync(dirname(resolveDailyMemoryPath('2026-04-15', tempDir)), { recursive: true })
    writeFileSync(
      resolveDailyMemoryPath('2026-04-15', tempDir),
      '# Daily\n\nRecent working note',
      'utf-8',
    )

    const memorySectionsResult = loadLayeredMemory({
      basePath: tempDir,
      sessionId: 'prompt-session',
      config: {
        dailyLoadDays: 1,
        durableMemoryBudgetTokens: 200,
        checkpointBudgetTokens: 200,
        workingMemoryBudgetTokens: 200,
      },
    })
    expect(memorySectionsResult.ok).toBe(true)
    if (!memorySectionsResult.ok) return

    const prompt = buildSystemPrompt({ memorySections: memorySectionsResult.value })

    const durableIdx = prompt.indexOf('### Durable Memory')
    const checkpointIdx = prompt.indexOf('### Checkpoint Memory')
    const workingIdx = prompt.indexOf('### Working Memory')

    expect(durableIdx).toBeLessThan(checkpointIdx)
    expect(checkpointIdx).toBeLessThan(workingIdx)
  })
})
