/**
 * Test Utilities for Integration Tests
 *
 * Provides temp directory management, test skill fixtures,
 * and cleanup helpers.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { ok, err } from '@src/types'
import type { ToolDefinition } from '@src/tools/types'
import { ToolRegistry } from '@src/tools/registry'
import type { AgentOptions, AgentEvent } from '@src/agent'
import type { LanguageModel } from 'ai'

/**
 * Create a unique temporary directory for test isolation.
 * Returns the absolute path.
 */
export function makeTempDir(prefix = 'ouroboros-integration'): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Clean up a temporary directory and all its contents.
 */
export function cleanupTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Set up a test skill fixture in a directory.
 * Creates skills/core/<name>/SKILL.md with the given frontmatter and body.
 */
export function createTestSkill(
  basePath: string,
  name: string,
  description: string,
  body: string,
): string {
  const skillDir = join(basePath, 'skills', 'core', name)
  mkdirSync(skillDir, { recursive: true })

  const content = `---
name: ${name}
description: ${description}
---

${body}`

  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
  return skillDir
}

/**
 * Set up memory directory with MEMORY.md and topics dir.
 */
export function setupMemoryDir(basePath: string, memoryContent = ''): void {
  mkdirSync(join(basePath, 'memory', 'topics'), { recursive: true })
  writeFileSync(
    join(basePath, 'memory', 'MEMORY.md'),
    memoryContent || '# Test Memory\n\nTest memory content for integration tests.',
    'utf-8',
  )
}

/**
 * Create a simple test tool definition.
 */
export function makeTool(
  name: string,
  handler?: (args: Record<string, unknown>) => unknown,
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    schema: z.object({ input: z.string().optional() }),
    execute: async (args: Record<string, unknown>) =>
      ok(handler ? handler(args) : { output: `${name} executed` }),
  }
}

/**
 * Create a tool that returns an error Result (not a throw).
 */
export function makeErrorTool(name: string, errorMessage: string): ToolDefinition {
  return {
    name,
    description: `Error tool: ${name}`,
    schema: z.object({ input: z.string().optional() }),
    execute: async () => err(new Error(errorMessage)),
  }
}

/**
 * Collect all events from an agent run.
 */
export function collectEvents(): { events: AgentEvent[]; handler: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, handler: (e: AgentEvent) => events.push(e) }
}

/**
 * Build default agent options with overrides.
 * By default, uses a static system prompt and no memory/skills
 * to avoid filesystem access.
 */
export function makeAgentOptions(
  model: LanguageModel,
  registry: ToolRegistry,
  overrides?: Partial<AgentOptions>,
): AgentOptions {
  return {
    model,
    toolRegistry: registry,
    systemPromptBuilder: () => 'You are a test assistant.',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
    ...overrides,
  }
}
