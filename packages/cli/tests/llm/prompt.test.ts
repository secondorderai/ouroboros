import { describe, test, expect } from 'bun:test'
import { buildSystemPrompt } from '@src/llm/prompt'
import type { SkillEntry } from '@src/llm/prompt'
import type { ToolMetadata } from '@src/tools/types'

describe('buildSystemPrompt', () => {
  // -------------------------------------------------------------------------
  // Feature Test: Base prompt includes agent identity and ReAct instructions
  // -------------------------------------------------------------------------

  test('base prompt includes agent identity and ReAct instructions', () => {
    const prompt = buildSystemPrompt({})

    // Agent identity
    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).toContain('self-improving')

    // ReAct pattern
    expect(prompt).toContain('ReAct')
    expect(prompt).toContain('Plan')
    expect(prompt).toContain('Act')
    expect(prompt).toContain('Observe')
    expect(prompt).toContain('Iterate')
    expect(prompt).toContain(
      'mention any contradictions or unresolved risks before treating the result as reliable',
    )

    // Safety tiers
    expect(prompt).toContain('Tier 0')
    expect(prompt).toContain('Tier 1')
    expect(prompt).toContain('Tier 2')
    expect(prompt).toContain('Tier 3')
    expect(prompt).toContain('Tier 4')
    expect(prompt).toContain('human approval')
  })

  test('base prompt with no args returns a valid string', () => {
    const prompt = buildSystemPrompt()

    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Feature Test: Tool catalog is injected without duplicating native schemas
  // -------------------------------------------------------------------------

  test('tool catalog is injected without JSON schemas by default', () => {
    const mockTool1: ToolMetadata = {
      name: 'file-read',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    }

    const mockTool2: ToolMetadata = {
      name: 'file-write',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }

    const prompt = buildSystemPrompt({ tools: [mockTool1, mockTool2] })

    // Both tool names appear
    expect(prompt).toContain('file-read')
    expect(prompt).toContain('file-write')

    // Both descriptions appear
    expect(prompt).toContain('Read the contents of a file')
    expect(prompt).toContain('Write content to a file')

    // Parameter schemas are intentionally omitted from the prompt because
    // they are passed through native tool definitions.
    expect(prompt).not.toContain('"path"')
    expect(prompt).not.toContain('"content"')

    // Section header is present
    expect(prompt).toContain('## Available Tools')
    expect(prompt).toContain('native tool definitions')
  })

  test('tool schemas can be included for fallback providers', () => {
    const mockTool: ToolMetadata = {
      name: 'file-write',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }

    const prompt = buildSystemPrompt({
      tools: [mockTool],
      includeToolSchemasInPrompt: true,
    })

    expect(prompt).toContain('"path"')
    expect(prompt).toContain('"content"')
    expect(prompt).toContain('Parameters')
  })

  // -------------------------------------------------------------------------
  // Feature Test: Skill catalog is injected
  // -------------------------------------------------------------------------

  test('skill catalog is injected', () => {
    const mockSkill1: SkillEntry = {
      name: 'web-search',
      description: 'Search the web for information',
      activationHint: 'Use when user asks to look something up',
    }

    const mockSkill2: SkillEntry = {
      name: 'code-review',
      description: 'Review code for quality and bugs',
    }

    const prompt = buildSystemPrompt({ skills: [mockSkill1, mockSkill2] })

    // Section header
    expect(prompt).toContain('## Skills')

    // Both skill names and descriptions
    expect(prompt).toContain('web-search')
    expect(prompt).toContain('Search the web for information')
    expect(prompt).toContain('code-review')
    expect(prompt).toContain('Review code for quality and bugs')

    // Activation hint for the first skill
    expect(prompt).toContain('Use when user asks to look something up')
  })

  // -------------------------------------------------------------------------
  // Feature Test: Memory context is injected
  // -------------------------------------------------------------------------

  test('memory context is injected', () => {
    const mockMemory = `# MEMORY INDEX

## Topics
- project-architecture: Overall system design
- user-preferences: Known user preferences

## Recent Sessions
- 2026-04-01: Initial setup and configuration`

    const prompt = buildSystemPrompt({ memory: mockMemory })

    // Section header
    expect(prompt).toContain('## Memory Context')

    // Content is injected verbatim
    expect(prompt).toContain('# MEMORY INDEX')
    expect(prompt).toContain('project-architecture: Overall system design')
    expect(prompt).toContain('user-preferences: Known user preferences')
    expect(prompt).toContain('2026-04-01: Initial setup and configuration')
    expect(prompt).toContain('### Durable Memory')
  })

  test('layered memory sections are rendered in stable order', () => {
    const prompt = buildSystemPrompt({
      memorySections: {
        durableMemory: '## Durable Facts\n- Use Bun',
        checkpointMemory:
          '# Reflection Checkpoint\n\n## Constraints\n- Keep checkpoint state\n\n## Next Best Step\nWrite tests',
        workingMemory: '## 2026-04-15\n\n- Fresh working notes',
      },
    })

    const durableIdx = prompt.indexOf('### Durable Memory')
    const checkpointIdx = prompt.indexOf('### Checkpoint Memory')
    const workingIdx = prompt.indexOf('### Working Memory')

    expect(prompt).toContain('## Memory Context')
    expect(durableIdx).toBeGreaterThan(-1)
    expect(checkpointIdx).toBeGreaterThan(-1)
    expect(workingIdx).toBeGreaterThan(-1)
    expect(durableIdx).toBeLessThan(checkpointIdx)
    expect(checkpointIdx).toBeLessThan(workingIdx)
  })

  test('AGENTS.md instructions are injected', () => {
    const prompt = buildSystemPrompt({
      agentsInstructions:
        '### ancestor: /repo/AGENTS.md\n\nRoot policy.\n\n### nearest: /repo/pkg/AGENTS.md\n\nPackage policy.',
    })

    expect(prompt).toContain('## AGENTS.md Instructions')
    expect(prompt).toContain('Root policy.')
    expect(prompt).toContain('Package policy.')
  })

  // -------------------------------------------------------------------------
  // Feature Test: Empty sections are omitted
  // -------------------------------------------------------------------------

  test('empty sections are omitted', () => {
    const mockTool: ToolMetadata = {
      name: 'test-tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
    }

    const prompt = buildSystemPrompt({ tools: [mockTool], skills: [], memory: '' })

    // Tools section is present
    expect(prompt).toContain('## Available Tools')
    expect(prompt).toContain('test-tool')

    // Skills and Memory sections are absent
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('empty memory subsections are omitted while populated ones remain', () => {
    const prompt = buildSystemPrompt({
      memorySections: {
        durableMemory: '## Durable Facts\n- Keep this',
        checkpointMemory: '   \n',
        workingMemory: '',
      },
    })

    expect(prompt).toContain('## Memory Context')
    expect(prompt).toContain('### Durable Memory')
    expect(prompt).not.toContain('### Checkpoint Memory')
    expect(prompt).not.toContain('### Working Memory')
  })

  test('undefined skills and memory are omitted', () => {
    const prompt = buildSystemPrompt({ tools: undefined, skills: undefined, memory: undefined })

    expect(prompt).not.toContain('## Available Tools')
    expect(prompt).not.toContain('## Skills')
    expect(prompt).not.toContain('## Memory Context')
  })

  test('whitespace-only memory is omitted', () => {
    const prompt = buildSystemPrompt({ memory: '   \n  \n  ' })

    expect(prompt).not.toContain('## Memory Context')
  })

  // -------------------------------------------------------------------------
  // Additional: composability and correctness
  // -------------------------------------------------------------------------

  test('all sections can be combined', () => {
    const tools: ToolMetadata[] = [
      {
        name: 'bash',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ]

    const skills: SkillEntry[] = [{ name: 'summarize', description: 'Summarize text content' }]

    const memory = '## Known Projects\n- ouroboros: this project'

    const prompt = buildSystemPrompt({
      tools,
      skills,
      memorySections: {
        durableMemory: memory,
        checkpointMemory:
          '# Reflection Checkpoint\n\n## Constraints\n- Keep state\n\n## Next Best Step\nContinue',
        workingMemory: '## 2026-04-15\n\n- Recent notes',
      },
    })

    // All sections present
    expect(prompt).toContain('You are Ouroboros')
    expect(prompt).toContain('## Available Tools')
    expect(prompt).toContain('bash')
    expect(prompt).toContain('## Skills')
    expect(prompt).toContain('summarize')
    expect(prompt).toContain('## Memory Context')
    expect(prompt).toContain('## Known Projects')
    expect(prompt).toContain('### Checkpoint Memory')
    expect(prompt).toContain('### Working Memory')
  })

  test('prompt is a plain string with no provider-specific formatting', () => {
    const prompt = buildSystemPrompt({
      tools: [{ name: 't', description: 'd', parameters: {} }],
      skills: [{ name: 's', description: 'd' }],
      memory: 'some memory',
    })

    expect(typeof prompt).toBe('string')
    // No XML tags or JSON wrapper — just plain text/markdown
    expect(prompt).not.toMatch(/^<\?xml/)
    expect(prompt).not.toMatch(/^\{/)
  })

  test('default mode does not inject desktop readability guidance', () => {
    const prompt = buildSystemPrompt({})

    expect(prompt).not.toContain('desktop chat interface optimized for reading longer answers')
    expect(prompt).not.toContain('Start with a short framing paragraph before lists')
  })

  test('desktop-readable mode injects prose-first guidance', () => {
    const prompt = buildSystemPrompt({ responseStyle: 'desktop-readable' })

    expect(prompt).toContain('desktop chat interface optimized for reading longer answers')
    expect(prompt).toContain('including answers produced without any tool calls')
    expect(prompt).toContain('it will not rewrite a dense answer for you after generation')
    expect(prompt).toContain('Start with a short framing paragraph before lists')
    expect(prompt).toContain('Lead with a direct answer or recommendation before supporting detail')
    expect(prompt).toContain('no more than 4 bullets')
    expect(prompt).toContain('Use short, descriptive headings when they improve scanability')
    expect(prompt).toContain('Option: why it fits')
    expect(prompt).toContain('Prefer short paragraphs and clear headings')
  })
})
