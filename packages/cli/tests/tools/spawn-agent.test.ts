import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Agent } from '@src/agent'
import { configSchema } from '@src/config'
import { TranscriptStore } from '@src/memory/transcripts'
import { createPermissionLease } from '@src/permission-lease'
import { TaskGraphStore } from '@src/team/task-graph'
import { createTestToolRegistry, ToolRegistry } from '@src/tools/registry'
import * as bashTool from '@src/tools/bash'
import * as fileEditTool from '@src/tools/file-edit'
import * as fileReadTool from '@src/tools/file-read'
import * as fileWriteTool from '@src/tools/file-write'
import * as spawnAgentTool from '@src/tools/spawn-agent'
import * as workerDiffApprovalTool from '@src/tools/worker-diff-approval'
import { collectWorkerDiff, createWorkerRuntime } from '@src/tools/worker-runtime'
import { normalizeSubAgentOutput, validateSubAgentResult } from '@src/tools/subagent-result'
import { setWorkerDiffApprovalHandler } from '@src/tools/worker-diff-approval'
import type { SpawnAgentResult } from '@src/tools/spawn-agent'
import { ok, type AgentDefinition, type PermissionConfig } from '@src/types'
import {
  createInspectingMockModel,
  createMockModel,
  finishStop,
  finishToolCalls,
  textBlock,
  toolCallBlock,
} from '../helpers/mock-llm'
import { cleanupTempDir, collectEvents, makeTempDir } from '../helpers/test-utils'
import type { ToolDefinition } from '@src/tools/types'

const READ_ONLY: PermissionConfig = {
  tier0: true,
  tier1: false,
  tier2: false,
  tier3: false,
  tier4: false,
}

const WRITE_ENABLED: PermissionConfig = {
  tier0: true,
  tier1: true,
  tier2: false,
  tier3: false,
  tier4: false,
}

function makeConfig(definitions: AgentDefinition[], allowedTestCommands: string[] = []) {
  return configSchema.parse({
    agent: {
      definitions,
      allowedTestCommands,
    },
  })
}

function primaryAgent(canInvokeAgents: string[]): AgentDefinition {
  return {
    id: 'planner',
    description: 'Planner',
    mode: 'primary',
    prompt: 'Plan and delegate bounded read-only research.',
    permissions: {
      ...READ_ONLY,
      canInvokeAgents,
    },
  }
}

function writableAgent(): AgentDefinition {
  return {
    id: 'writer',
    description: 'Writes files',
    mode: 'all',
    prompt: 'Write files.',
    permissions: WRITE_ENABLED,
  }
}

function makeNoopTool(): ToolDefinition {
  return {
    name: 'noop',
    description: 'No-op tool',
    schema: z.object({}),
    execute: async () => ok({ done: true }),
  }
}

function makeBasePathProbeTool(onBasePath: (basePath: string | undefined) => void): ToolDefinition {
  return {
    name: 'file-read',
    description: 'Probe child workspace path.',
    schema: z.object({ path: z.string() }),
    execute: async (_args, context) => {
      onBasePath(context?.basePath)
      return ok({ content: 'workspace probed', lines: 1, path: 'workspace.txt' })
    },
  }
}

function validSubagentResultText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Child summary.',
    claims: [
      {
        claim: 'The project has notes.',
        evidence: [{ type: 'file', path: 'notes.md', line: 1, excerpt: '# Notes' }],
        confidence: 0.82,
      },
    ],
    uncertainty: ['No major uncertainty.'],
    suggestedNextSteps: ['Continue with the parent task.'],
    ...overrides,
  })
}

function validReviewResultText(overrides: Record<string, unknown> = {}): string {
  return validSubagentResultText({
    summary: 'Review found one issue.',
    claims: [],
    reviewFindings: [
      {
        title: 'Missing empty-state guard',
        severity: 'high',
        file: 'src/example.ts',
        line: 3,
        body: 'The function dereferences the first item without checking whether the list is empty.',
        confidence: 0.87,
        evidence: [
          {
            type: 'file',
            path: 'src/example.ts',
            line: 3,
            excerpt: 'return items[0].name',
          },
        ],
      },
    ],
    suggestedNextSteps: ['Add a regression test for empty input.'],
    ...overrides,
  })
}

function makeExplodingFileWriteTool(onExecute: () => void): ToolDefinition {
  return {
    name: 'file-write',
    description: 'Write a file',
    schema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async () => {
      onExecute()
      throw new Error('parent mutating file-write should not execute in child')
    },
  }
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
  })
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function initGitRepo(root: string): void {
  runGit(root, ['init'])
  runGit(root, ['config', 'user.email', 'test@example.com'])
  runGit(root, ['config', 'user.name', 'Test User'])
}

function writeRepoFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

function commitAll(root: string, message: string): void {
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', message])
}

function registerWorkerTools(registry: ToolRegistry): void {
  registry.register(fileReadTool)
  registry.register(fileWriteTool)
  registry.register(fileEditTool)
  registry.register(bashTool)
}

function workerLease(overrides: Partial<Parameters<typeof createPermissionLease>[0]> = {}) {
  return createPermissionLease({
    id: `lease-${crypto.randomUUID()}`,
    agentRunId: `run-${crypto.randomUUID()}`,
    allowedTools: ['file-read', 'file-write', 'file-edit', 'bash'],
    allowedPaths: ['packages/cli/src/**'],
    allowedBash: ["printf 'verify-ok\\n'"],
    approvedAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  })
}

describe('spawn_agent tool', () => {
  let registry: ToolRegistry
  let tempDir: string

  beforeEach(() => {
    registry = new ToolRegistry()
    registry.register(spawnAgentTool)
    tempDir = makeTempDir('ouroboros-spawn-agent')
  })

  afterEach(() => {
    setWorkerDiffApprovalHandler(null)
    cleanupTempDir(tempDir)
  })

  test('appears in the built-in registry', async () => {
    const { createRegistry } = await import('@src/tools/registry')

    const builtins = await createRegistry()

    expect(builtins.getTool('spawn_agent')).toBeDefined()
    expect(builtins.getTools().map((tool) => tool.name)).toContain('spawn_agent')
  })

  test('schema rejects missing agentId and empty task', async () => {
    const missingAgentId = await registry.executeTool('spawn_agent', {
      task: 'Read package files',
      outputFormat: 'summary',
    })
    expect(missingAgentId.ok).toBe(false)

    const emptyTask = await registry.executeTool('spawn_agent', {
      agentId: 'explore',
      task: '   ',
      outputFormat: 'summary',
    })
    expect(emptyTask.ok).toBe(false)
    if (!emptyTask.ok) {
      expect(emptyTask.error.message).toContain('Task must not be empty')
    }
  })

  test('valid subagent result passes validation', () => {
    const parsed = validateSubAgentResult(JSON.parse(validSubagentResultText()))

    expect(parsed).toMatchObject({
      summary: 'Child summary.',
      claims: [
        {
          claim: 'The project has notes.',
          confidence: 0.82,
        },
      ],
      uncertainty: ['No major uncertainty.'],
      suggestedNextSteps: ['Continue with the parent task.'],
    })
  })

  test('valid review finding passes validation and is available in the structured result', () => {
    const parsed = validateSubAgentResult(JSON.parse(validReviewResultText()))

    expect(parsed.reviewFindings).toEqual([
      {
        title: 'Missing empty-state guard',
        severity: 'high',
        file: 'src/example.ts',
        line: 3,
        body: 'The function dereferences the first item without checking whether the list is empty.',
        confidence: 0.87,
        evidence: [
          {
            type: 'file',
            path: 'src/example.ts',
            line: 3,
            excerpt: 'return items[0].name',
          },
        ],
      },
    ])
  })

  test('malformed review findings normalize to degraded structured output', () => {
    const normalized = normalizeSubAgentOutput(
      validReviewResultText({
        reviewFindings: [
          {
            title: 'Missing confidence',
            severity: 'high',
            body: 'The finding is not complete.',
            evidence: [{ type: 'output', excerpt: 'No confidence field.' }],
          },
        ],
      }),
    )

    expect(normalized.valid).toBe(false)
    expect(normalized.warnings.join('\n')).toContain('reviewFindings.0.confidence')
  })

  test('malformed claims normalize to degraded structured output', () => {
    const missingSummary = normalizeSubAgentOutput(
      JSON.stringify({
        claims: [
          {
            claim: 'Summary is missing.',
            evidence: [{ type: 'output', excerpt: 'Observed output.' }],
            confidence: 0.4,
          },
        ],
        uncertainty: ['Missing summary.'],
        suggestedNextSteps: ['Fix the output.'],
      }),
    )
    const normalized = normalizeSubAgentOutput(
      validSubagentResultText({
        claims: [{ claim: 'Evidence is missing.', confidence: 0.4 }],
      }),
    )

    expect(missingSummary.valid).toBe(false)
    expect(missingSummary.warnings.join('\n')).toContain('summary')
    expect(normalized.valid).toBe(false)
    expect(normalized.result).toMatchObject({
      summary: 'Child agent returned malformed structured output.',
      claims: [],
      suggestedNextSteps: [
        'Review the child transcript or rerun the subagent with stricter output instructions.',
      ],
    })
    expect(normalized.warnings.join('\n')).toContain('evidence')
  })

  test('confidence values are bounded by the subagent result schema', () => {
    const tooHigh = normalizeSubAgentOutput(
      validSubagentResultText({
        claims: [
          {
            claim: 'Confidence is too high.',
            evidence: [{ type: 'output', excerpt: 'Observed output.' }],
            confidence: 1.5,
          },
        ],
      }),
    )

    expect(tooHigh.valid).toBe(false)
    expect(tooHigh.warnings.join('\n')).toContain('<=1')
  })

  test('runs the explorer child with independent context and provided context files', async () => {
    writeFileSync(join(tempDir, 'notes.md'), '# Notes\n\nImportant context.', 'utf-8')

    let capturedPrompt = ''
    const model = createInspectingMockModel((prompt) => {
      capturedPrompt = JSON.stringify(prompt)
      return [
        ...textBlock(validSubagentResultText({ summary: 'Exploration complete.' })),
        finishStop(),
      ]
    })
    const config = makeConfig([primaryAgent(['explore'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'explore',
        task: 'Summarize the notes.',
        contextFiles: ['notes.md'],
        maxSteps: 3,
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    if (!result.ok) {
      throw result.error
    }
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'explore',
      structuredResult: { summary: 'Exploration complete.' },
      resultValidation: { valid: true, warnings: [] },
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
      contextFiles: [{ path: 'notes.md', included: true }],
    })
    expect(capturedPrompt).toContain('Explore the codebase')
    expect(capturedPrompt).toContain('Summarize the notes.')
    expect(capturedPrompt).toContain('Important context.')
  })

  test('default config primary agent can spawn read-only explore subagent', async () => {
    const model = createMockModel([
      [
        ...textBlock(validSubagentResultText({ summary: 'Default delegation works.' })),
        finishStop(),
      ],
    ])
    const config = configSchema.parse({})

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'explore',
        task: 'Inspect default delegation wiring.',
        maxSteps: 2,
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'default',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'explore',
      structuredResult: { summary: 'Default delegation works.' },
    })
  })

  test('maps generated inspector lane ids to the read-only explore agent', async () => {
    const model = createMockModel([
      [
        ...textBlock(validSubagentResultText({ summary: 'Inspector alias delegated.' })),
        finishStop(),
      ],
    ])
    const config = configSchema.parse({})

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'inspector-1',
        task: 'Inspect the CLI package.',
        taskId: 'inspect-cli',
        maxSteps: 2,
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'default',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'explore',
      requestedAgentId: 'inspector-1',
      structuredResult: { summary: 'Inspector alias delegated.' },
    })
  })

  test('linked team graph task is assigned and completed from subagent lifecycle', async () => {
    const taskGraphStore = new TaskGraphStore()
    const graphResult = taskGraphStore.createGraph({
      name: 'Package inspection',
      tasks: [{ id: 'inspect-cli', title: 'Inspect CLI package' }],
    })
    expect(graphResult.ok).toBe(true)
    if (!graphResult.ok) return
    const emitted: unknown[] = []
    const model = createMockModel([
      [...textBlock(validSubagentResultText({ summary: 'CLI package inspected.' })), finishStop()],
    ])
    const config = configSchema.parse({})

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'inspector-1',
        task: 'Inspect the CLI package.',
        taskId: 'inspect-cli',
        maxSteps: 2,
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'default',
        taskGraphStore,
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
        emitEvent: (event: unknown) => emitted.push(event),
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const graph = taskGraphStore.getGraph(graphResult.value.id)
    expect(graph.ok).toBe(true)
    if (!graph.ok) return
    expect(graph.value.status).toBe('completed')
    expect(graph.value.tasks[0]).toMatchObject({
      id: 'inspect-cli',
      status: 'completed',
      assignedAgentId: 'inspector-1',
    })
    expect(graph.value.agents[0]).toMatchObject({
      id: 'inspector-1',
      status: 'completed',
      activeTaskIds: [],
    })
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'team-graph-open',
        graph: expect.objectContaining({
          tasks: [expect.objectContaining({ id: 'inspect-cli', status: 'running' })],
        }),
      }),
    )
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'team-graph-open',
        graph: expect.objectContaining({
          tasks: [expect.objectContaining({ id: 'inspect-cli', status: 'completed' })],
        }),
      }),
    )
  })

  test('read-only child agents inherit the parent workspace base path', async () => {
    let observedChildBasePath: string | undefined
    registry.register(
      makeBasePathProbeTool((basePath) => {
        observedChildBasePath = basePath
      }),
    )
    const model = createMockModel([
      [
        ...toolCallBlock('child_read', 'file-read', {
          path: 'workspace.txt',
        }),
        finishToolCalls(),
      ],
      [...textBlock(validSubagentResultText({ summary: 'Workspace inherited.' })), finishStop()],
    ])
    const config = configSchema.parse({})

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'explore',
        task: 'Check workspace inheritance.',
        maxSteps: 3,
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'default',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    expect(observedChildBasePath).toBe(tempDir)
  })

  test('review agent receives changed-file context when no context files are provided', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true })
    writeFileSync(
      join(tempDir, 'src/example.ts'),
      'export function first(items: Array<{ name: string }>) {\n  return items[0]?.name\n}\n',
      'utf-8',
    )
    runGit(tempDir, ['init'])
    runGit(tempDir, ['config', 'user.email', 'test@example.com'])
    runGit(tempDir, ['config', 'user.name', 'Test User'])
    runGit(tempDir, ['add', '.'])
    runGit(tempDir, ['commit', '--no-gpg-sign', '-m', 'init'])
    writeFileSync(
      join(tempDir, 'src/example.ts'),
      'export function first(items: Array<{ name: string }>) {\n  return items[0].name\n}\n',
      'utf-8',
    )

    let capturedPrompt = ''
    const model = createInspectingMockModel((prompt) => {
      capturedPrompt = JSON.stringify(prompt)
      return [...textBlock(validReviewResultText()), finishStop()]
    })
    const config = makeConfig([primaryAgent(['review'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'review',
        task: 'Review changed files for regressions.',
        maxSteps: 3,
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const spawnResult = result.value as SpawnAgentResult
    expect(spawnResult.contextFiles).toEqual([{ path: 'src/example.ts', included: true }])
    expect(spawnResult.structuredResult.reviewFindings).toHaveLength(1)
    expect(capturedPrompt).toContain('Changed File Context')
    expect(capturedPrompt).toContain('src/example.ts')
    expect(capturedPrompt).toContain('return items[0].name')
    expect(capturedPrompt).toContain('reviewFindings')
  })

  test('persists a successful child run with parent and child session traceability', async () => {
    const transcriptStore = new TranscriptStore(join(tempDir, 'transcripts.db'))
    try {
      const parentSession = transcriptStore.createSession(tempDir)
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) return

      const model = createMockModel([[...textBlock(validSubagentResultText()), finishStop()]])
      const config = makeConfig([primaryAgent(['explore'])])

      const result = await registry.executeTool(
        'spawn_agent',
        {
          agentId: 'explore',
          task: 'Summarize the project.',
          outputFormat: 'summary',
        },
        {
          model,
          toolRegistry: registry,
          config,
          transcriptStore,
          sessionId: parentSession.value,
          basePath: tempDir,
          agentId: 'planner',
          systemPromptBuilder: () => 'Base child prompt.',
          memoryProvider: () => '',
          skillCatalogProvider: () => [],
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const spawnResult = result.value as SpawnAgentResult
      expect(spawnResult.status).toBe('completed')
      expect(spawnResult.childSessionId).toBeDefined()

      const runs = transcriptStore.getSubagentRunsForParent(parentSession.value)
      expect(runs.ok).toBe(true)
      if (!runs.ok) return
      expect(runs.value).toHaveLength(1)
      expect(runs.value[0]).toMatchObject({
        parentSessionId: parentSession.value,
        childSessionId: spawnResult.childSessionId,
        agentId: 'explore',
        task: 'Summarize the project.',
        status: 'completed',
        finalResult: validSubagentResultText(),
        errorMessage: null,
      })

      const child = transcriptStore.getSession(runs.value[0].childSessionId)
      expect(child.ok).toBe(true)
      if (!child.ok) return
      expect(child.value.messages.map((message) => message.role)).toContain('user')
      expect(child.value.messages.map((message) => message.role)).toContain('assistant')

      const parent = transcriptStore.getSession(parentSession.value)
      expect(parent.ok).toBe(true)
      if (!parent.ok) return
      expect(parent.value.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'tool-call', toolName: 'spawn_agent' }),
          expect.objectContaining({ role: 'tool-result', toolName: 'spawn_agent' }),
        ]),
      )
    } finally {
      transcriptStore.close()
    }
  })

  test('persists a failed child run with an error message', async () => {
    const transcriptStore = new TranscriptStore(join(tempDir, 'failed-transcripts.db'))
    try {
      const parentSession = transcriptStore.createSession(tempDir)
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) return

      const model = createMockModel([
        [
          {
            type: 'error',
            error: new Error('child model failed'),
          },
          finishStop(),
        ],
      ])
      const config = makeConfig([primaryAgent(['explore'])])

      const result = await registry.executeTool(
        'spawn_agent',
        {
          agentId: 'explore',
          task: 'Investigate a failure.',
          outputFormat: 'summary',
        },
        {
          model,
          toolRegistry: registry,
          config,
          transcriptStore,
          sessionId: parentSession.value,
          basePath: tempDir,
          agentId: 'planner',
          systemPromptBuilder: () => 'Base child prompt.',
          memoryProvider: () => '',
          skillCatalogProvider: () => [],
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const spawnResult = result.value as SpawnAgentResult
      expect(spawnResult).toMatchObject({
        status: 'failed',
        agentId: 'explore',
        stopReason: 'error',
        error: { message: 'Child agent stopped with reason: error' },
      })

      const runs = transcriptStore.getSubagentRunsForParent(parentSession.value)
      expect(runs.ok).toBe(true)
      if (!runs.ok) return
      expect(runs.value).toHaveLength(1)
      expect(runs.value[0]).toMatchObject({
        parentSessionId: parentSession.value,
        childSessionId: spawnResult.childSessionId,
        agentId: 'explore',
        task: 'Investigate a failure.',
        status: 'failed',
        finalResult: JSON.stringify({
          summary: 'Child agent returned no output.',
          claims: [],
          uncertainty: ['Child output was empty.'],
          suggestedNextSteps: [
            'Review the child transcript or rerun the subagent with stricter output instructions.',
          ],
        }),
        errorMessage: 'Child agent stopped with reason: error',
      })
    } finally {
      transcriptStore.close()
    }
  })

  test('rejects worker without required runtime fields and non-read-only agents', async () => {
    const model = createMockModel([[...textBlock('Should not run'), finishStop()]])
    const config = makeConfig([primaryAgent(['worker', 'writer']), writableAgent()])
    const context = {
      model,
      toolRegistry: registry,
      config,
      basePath: tempDir,
      agentId: 'planner',
      systemPromptBuilder: () => 'Base child prompt.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
    }

    const worker = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'worker',
        task: 'Do worker things.',
        outputFormat: 'summary',
      },
      context,
    )
    expect(worker.ok).toBe(false)
    if (!worker.ok) {
      expect(worker.error.message).toContain('Worker agent requires')
      expect(worker.error.message).toContain('writeScope')
      expect(worker.error.message).toContain('permissionLease')
    }

    const writer = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'writer',
        task: 'Write a file.',
        outputFormat: 'summary',
      },
      context,
    )
    expect(writer.ok).toBe(false)
    if (!writer.ok) {
      expect(writer.error.message).toContain('not read-only')
    }
  })

  test('worker creates and uses an isolated git worktree with diff fields', async () => {
    registerWorkerTools(registry)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/worker-target.txt', 'old\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-runtime-${crypto.randomUUID()}`)
    const branchName = `worker/${crypto.randomUUID()}`
    const command = "printf 'verify-ok\\n'"
    const model = createMockModel([
      [
        ...toolCallBlock('worker_write', 'file-write', {
          path: 'packages/cli/src/worker-target.txt',
          content: 'new\n',
        }),
        finishToolCalls(),
      ],
      [
        ...textBlock(
          validSubagentResultText({
            summary: 'Worker changed the target file.',
            uncertainty: [],
            suggestedNextSteps: [],
          }),
        ),
        finishStop(),
      ],
    ])
    const config = makeConfig([primaryAgent(['worker'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'worker',
        taskId: 'ticket-14',
        task: 'Edit the target file.',
        branchName,
        worktreePath,
        writeScope: ['packages/cli/src/**'],
        permissionLease: workerLease({
          allowedPaths: ['packages/cli/src/**'],
          allowedBash: [command],
        }),
        verificationCommand: command,
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(join(worktreePath, '.git'))).toBe(true)
    expect(readFileSync(join(worktreePath, 'packages/cli/src/worker-target.txt'), 'utf-8')).toBe(
      'new\n',
    )
    expect(readFileSync(join(tempDir, 'packages/cli/src/worker-target.txt'), 'utf-8')).toBe('old\n')
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'worker',
      taskId: 'ticket-14',
      branchName,
      worktreePath,
      changedFiles: ['packages/cli/src/worker-target.txt'],
      testsRun: [command],
      testResult: {
        command,
        exitCode: 0,
        status: 'passed',
      },
      unresolvedRisks: [],
    })
    const spawnResult = result.value as SpawnAgentResult
    expect(spawnResult.diff).toContain('-old')
    expect(spawnResult.diff).toContain('+new')
    expect(spawnResult.workerDiff).toMatchObject({
      taskId: 'ticket-14',
      reviewStatus: 'awaiting-review',
      changedFiles: ['packages/cli/src/worker-target.txt'],
    })
  })

  test('review agent receives worker diff context and returns findings', async () => {
    registerWorkerTools(registry)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/review-target.txt', 'old\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-review-${crypto.randomUUID()}`)
    const branchName = `worker/${crypto.randomUUID()}`
    const command = "printf 'verify-ok\\n'"
    const workerModel = createMockModel([
      [
        ...toolCallBlock('worker_write', 'file-write', {
          path: 'packages/cli/src/review-target.txt',
          content: 'new\n',
        }),
        finishToolCalls(),
      ],
      [
        ...textBlock(
          validSubagentResultText({
            summary: 'Worker changed the review target.',
            uncertainty: [],
            suggestedNextSteps: [],
          }),
        ),
        finishStop(),
      ],
    ])
    const config = makeConfig([primaryAgent(['worker', 'review'])])

    const workerResult = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'worker',
        taskId: 'ticket-15-review',
        task: 'Edit the target file.',
        branchName,
        worktreePath,
        writeScope: ['packages/cli/src/**'],
        permissionLease: workerLease({
          allowedPaths: ['packages/cli/src/**'],
          allowedBash: [command],
        }),
        verificationCommand: command,
        outputFormat: 'json',
      },
      {
        model: workerModel,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )
    expect(workerResult.ok).toBe(true)
    if (!workerResult.ok) return

    let capturedPrompt = ''
    const reviewModel = createInspectingMockModel((prompt) => {
      capturedPrompt = JSON.stringify(prompt)
      return [...textBlock(validReviewResultText()), finishStop()]
    })
    const reviewResult = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'review',
        task: 'Review the worker output before it is applied.',
        outputFormat: 'json',
        workerDiff: (workerResult.value as SpawnAgentResult).workerDiff,
      },
      {
        model: reviewModel,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(reviewResult.ok).toBe(true)
    if (!reviewResult.ok) return
    const spawnResult = reviewResult.value as SpawnAgentResult
    expect(spawnResult.structuredResult.reviewFindings).toHaveLength(1)
    expect(spawnResult.contextFiles).toEqual([
      { path: 'packages/cli/src/review-target.txt', included: true },
    ])
    expect(capturedPrompt).toContain('Worker Diff Context')
    expect(capturedPrompt).toContain('Worker Changed File Context')
    expect(capturedPrompt).toContain('-old')
    expect(capturedPrompt).toContain('+new')
    expect(capturedPrompt).toContain('Treat the worker output as unapplied')
  })

  test('rejecting worker output leaves parent worktree unchanged', async () => {
    registry.register(workerDiffApprovalTool)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/reject-target.txt', 'parent\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-reject-${crypto.randomUUID()}`)
    const branchName = `worker/${crypto.randomUUID()}`
    runGit(tempDir, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])
    writeRepoFile(worktreePath, 'packages/cli/src/reject-target.txt', 'worker\n')
    const workerDiff = {
      taskId: 'ticket-15-reject',
      branchName,
      worktreePath,
      ...collectWorkerDiff(worktreePath),
      unresolvedRisks: [],
      reviewStatus: 'awaiting-review' as const,
    }
    setWorkerDiffApprovalHandler(async () => ({
      ok: false,
      error: new Error('Rejected by parent.'),
    }))

    const result = await registry.executeTool(
      'apply_worker_diff',
      { workerDiff, action: 'apply-patch' },
      {
        model: createMockModel([]),
        toolRegistry: registry,
        config: makeConfig([primaryAgent([])]),
        basePath: tempDir,
        agentId: 'planner',
      },
    )

    expect(result.ok).toBe(false)
    expect(readFileSync(join(tempDir, 'packages/cli/src/reject-target.txt'), 'utf-8')).toBe(
      'parent\n',
    )
    expect(gitOutput(tempDir, ['diff', '--name-only'])).toBe('')
  })

  test('applying worker output is blocked without explicit approval', async () => {
    registry.register(workerDiffApprovalTool)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/approval-target.txt', 'parent\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-approval-${crypto.randomUUID()}`)
    const branchName = `worker/${crypto.randomUUID()}`
    runGit(tempDir, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])
    writeRepoFile(worktreePath, 'packages/cli/src/approval-target.txt', 'worker\n')
    const workerDiff = {
      taskId: 'ticket-15-approval',
      branchName,
      worktreePath,
      ...collectWorkerDiff(worktreePath),
      unresolvedRisks: [],
      reviewStatus: 'awaiting-review' as const,
    }

    const result = await registry.executeTool(
      'apply_worker_diff',
      { workerDiff, action: 'apply-patch' },
      {
        model: createMockModel([]),
        toolRegistry: registry,
        config: makeConfig([primaryAgent([])]),
        basePath: tempDir,
        agentId: 'planner',
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('approval is required')
    }
    expect(readFileSync(join(tempDir, 'packages/cli/src/approval-target.txt'), 'utf-8')).toBe(
      'parent\n',
    )
    expect(gitOutput(tempDir, ['diff', '--name-only'])).toBe('')
  })

  test('approved worker output applies patch without merging or committing', async () => {
    registry.register(workerDiffApprovalTool)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/apply-target.txt', 'parent\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-apply-${crypto.randomUUID()}`)
    const branchName = `worker/${crypto.randomUUID()}`
    runGit(tempDir, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])
    writeRepoFile(worktreePath, 'packages/cli/src/apply-target.txt', 'worker\n')
    const workerDiff = {
      taskId: 'ticket-15-apply',
      branchName,
      worktreePath,
      ...collectWorkerDiff(worktreePath),
      unresolvedRisks: [],
      reviewStatus: 'awaiting-review' as const,
    }
    setWorkerDiffApprovalHandler(async () =>
      ok({ approved: true as const, approvedAt: '2026-04-22T00:00:00.000Z' }),
    )

    const result = await registry.executeTool(
      'apply_worker_diff',
      { workerDiff, action: 'apply-patch' },
      {
        model: createMockModel([]),
        toolRegistry: registry,
        config: makeConfig([primaryAgent([])]),
        basePath: tempDir,
        agentId: 'planner',
      },
    )

    if (!result.ok) {
      throw result.error
    }
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      status: 'applied',
      taskId: 'ticket-15-apply',
      action: 'apply-patch',
      changedFiles: ['packages/cli/src/apply-target.txt'],
      approvedAt: '2026-04-22T00:00:00.000Z',
    })
    expect(readFileSync(join(tempDir, 'packages/cli/src/apply-target.txt'), 'utf-8')).toBe(
      'worker\n',
    )
    expect(gitOutput(tempDir, ['status', '--short'])).toBe('M packages/cli/src/apply-target.txt')
  })

  test('worker rejects a missing write scope even with a lease', async () => {
    const model = createMockModel([[...textBlock('Should not run'), finishStop()]])
    const config = makeConfig([primaryAgent(['worker'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'worker',
        taskId: 'ticket-14',
        task: 'Edit the target file.',
        branchName: `worker/${crypto.randomUUID()}`,
        worktreePath: join(dirname(tempDir), `worker-missing-scope-${crypto.randomUUID()}`),
        permissionLease: workerLease(),
        verificationCommand: "printf 'verify-ok\\n'",
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('writeScope')
    }
  })

  test('failed worker edits do not mutate the parent worktree', async () => {
    registerWorkerTools(registry)
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/worker-fail.txt', 'parent\n')
    commitAll(tempDir, 'initial')

    const worktreePath = join(dirname(tempDir), `worker-fail-${crypto.randomUUID()}`)
    const command = "printf 'verify-ok\\n'"
    const model = createMockModel([
      [
        ...toolCallBlock('worker_write', 'file-write', {
          path: 'packages/cli/src/worker-fail.txt',
          content: 'worker\n',
        }),
        finishToolCalls(),
      ],
      [...textBlock('not valid worker json'), finishStop()],
    ])
    const config = makeConfig([primaryAgent(['worker'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'worker',
        taskId: 'ticket-14-fail',
        task: 'Edit the target file and fail.',
        branchName: `worker/${crypto.randomUUID()}`,
        worktreePath,
        writeScope: ['packages/cli/src/**'],
        permissionLease: workerLease({
          allowedPaths: ['packages/cli/src/**'],
          allowedBash: [command],
        }),
        verificationCommand: command,
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'failed',
      agentId: 'worker',
      changedFiles: ['packages/cli/src/worker-fail.txt'],
    })
    expect(readFileSync(join(tempDir, 'packages/cli/src/worker-fail.txt'), 'utf-8')).toBe(
      'parent\n',
    )
    expect(gitOutput(tempDir, ['diff', '--name-only'])).toBe('')
  })

  test('worker runtime blocks overlapping write scopes by default', () => {
    initGitRepo(tempDir)
    writeRepoFile(tempDir, 'packages/cli/src/worker-overlap.txt', 'base\n')
    commitAll(tempDir, 'initial')

    const first = createWorkerRuntime(
      {
        taskId: 'first',
        branchName: `worker/${crypto.randomUUID()}`,
        worktreePath: join(dirname(tempDir), `worker-overlap-a-${crypto.randomUUID()}`),
        writeScope: ['packages/cli/src/**'],
      },
      tempDir,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    try {
      const second = createWorkerRuntime(
        {
          taskId: 'second',
          branchName: `worker/${crypto.randomUUID()}`,
          worktreePath: join(dirname(tempDir), `worker-overlap-b-${crypto.randomUUID()}`),
          writeScope: ['packages/cli/src/worker-overlap.txt'],
        },
        tempDir,
      )

      expect(second.ok).toBe(false)
      if (!second.ok) {
        expect(second.error.message).toContain('overlaps active task')
      }
    } finally {
      first.value.release()
    }
  })

  test('returns structured child failure and parent loop remains active', async () => {
    registry.register(makeNoopTool())
    const model = createMockModel([
      [
        ...toolCallBlock('spawn_1', 'spawn_agent', {
          agentId: 'explore',
          task: 'Investigate failure.',
          maxSteps: 2,
          outputFormat: 'summary',
        }),
        finishToolCalls(),
      ],
      [
        {
          type: 'error',
          error: new Error('child model failed'),
        },
        finishStop(),
      ],
      [...textBlock('Parent handled the child failure.'), finishStop()],
    ])
    const config = makeConfig([primaryAgent(['explore'])])
    const { events, handler } = collectEvents()

    const parent = new Agent({
      model,
      toolRegistry: registry,
      config,
      basePath: tempDir,
      agentId: 'planner',
      systemPromptBuilder: () => 'Parent prompt.',
      memoryProvider: () => '',
      skillCatalogProvider: () => [],
      onEvent: handler,
    })

    const result = await parent.run('Delegate investigation.')

    expect(result.text).toBe('Parent handled the child failure.')
    expect(result.stopReason).toBe('completed')

    const spawnEnd = events.find(
      (event) => event.type === 'tool-call-end' && event.toolName === 'spawn_agent',
    )
    expect(spawnEnd).toBeDefined()
    if (spawnEnd?.type !== 'tool-call-end') return
    expect(spawnEnd.isError).toBe(false)
    expect(spawnEnd.result).toMatchObject({
      status: 'failed',
      agentId: 'explore',
      stopReason: 'error',
      error: { message: 'Child agent stopped with reason: error' },
    })
  })

  test('invalid child output does not crash the parent and persists degraded result', async () => {
    const transcriptStore = new TranscriptStore(join(tempDir, 'degraded-transcripts.db'))
    try {
      const parentSession = transcriptStore.createSession(tempDir)
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) return

      const model = createMockModel([
        [...textBlock('Plain text without structured claims.'), finishStop()],
      ])
      const config = makeConfig([primaryAgent(['explore'])])

      const result = await registry.executeTool(
        'spawn_agent',
        {
          agentId: 'explore',
          task: 'Return malformed output.',
          outputFormat: 'json',
        },
        {
          model,
          toolRegistry: registry,
          config,
          transcriptStore,
          sessionId: parentSession.value,
          basePath: tempDir,
          agentId: 'planner',
          systemPromptBuilder: () => 'Base child prompt.',
          memoryProvider: () => '',
          skillCatalogProvider: () => [],
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const spawnResult = result.value as SpawnAgentResult
      expect(spawnResult).toMatchObject({
        status: 'completed',
        structuredResult: {
          summary: 'Child agent returned unstructured output.',
          claims: [],
        },
        resultValidation: { valid: false },
        error: {
          message: expect.stringContaining('Child agent returned invalid structured result'),
        },
      })

      const runs = transcriptStore.getSubagentRunsForParent(parentSession.value)
      expect(runs.ok).toBe(true)
      if (!runs.ok) return
      expect(runs.value[0].finalResult).toBe(JSON.stringify(spawnResult.structuredResult))
      expect(runs.value[0].errorMessage).toContain('invalid structured result')
    } finally {
      transcriptStore.close()
    }
  })

  test('uses a read-only child registry that denies mutating tool calls', async () => {
    let parentFileWriteExecuted = false
    registry.register(
      makeExplodingFileWriteTool(() => {
        parentFileWriteExecuted = true
      }),
    )

    const model = createMockModel([
      [
        ...toolCallBlock('child_write', 'file-write', {
          path: join(tempDir, 'blocked.txt'),
          content: 'should not be written',
        }),
        finishToolCalls(),
      ],
      [
        ...textBlock(validSubagentResultText({ summary: 'Denied write was recorded.' })),
        finishStop(),
      ],
    ])
    const config = makeConfig([primaryAgent(['explore'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'explore',
        task: 'Try to write a file.',
        outputFormat: 'summary',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(parentFileWriteExecuted).toBe(false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'explore',
      structuredResult: { summary: 'Denied write was recorded.' },
      iterations: 2,
      stopReason: 'completed',
    })
  })

  test('review agent uses a read-only child registry that denies edit attempts', async () => {
    let parentFileWriteExecuted = false
    registry.register(
      makeExplodingFileWriteTool(() => {
        parentFileWriteExecuted = true
      }),
    )

    const model = createMockModel([
      [
        ...toolCallBlock('child_write', 'file-write', {
          path: join(tempDir, 'review-blocked.txt'),
          content: 'should not be written',
        }),
        finishToolCalls(),
      ],
      [...textBlock(validReviewResultText()), finishStop()],
    ])
    const config = makeConfig([primaryAgent(['review'])])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'review',
        task: 'Attempt an edit during review.',
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(parentFileWriteExecuted).toBe(false)
    expect(existsSync(join(tempDir, 'review-blocked.txt'))).toBe(false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'review',
      structuredResult: {
        reviewFindings: [
          expect.objectContaining({
            title: 'Missing empty-state guard',
            severity: 'high',
            confidence: 0.87,
          }),
        ],
      },
      iterations: 2,
      stopReason: 'completed',
    })
  })

  test('test agent runs a configured allowed command and returns pass result details', async () => {
    registry.register(bashTool)
    const command = "printf 'ok-test\\n'"
    const model = createMockModel([
      [...toolCallBlock('test_cmd', 'bash', { command, timeout: 2 }), finishToolCalls()],
      [
        ...textBlock(
          validSubagentResultText({
            summary: 'Tests passed.',
            claims: [],
            uncertainty: [],
            suggestedNextSteps: [],
          }),
        ),
        finishStop(),
      ],
    ])
    const config = makeConfig([primaryAgent(['test'])], [command])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'test',
        task: `Run ${command}`,
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'completed',
      agentId: 'test',
      testResults: [
        {
          command,
          exitCode: 0,
          status: 'passed',
        },
      ],
      structuredResult: {
        testResults: [
          {
            command,
            exitCode: 0,
            status: 'passed',
          },
        ],
      },
    })
    const spawnResult = result.value as SpawnAgentResult
    expect(spawnResult.testResults?.[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(spawnResult.testResults?.[0].outputExcerpt).toContain('ok-test')
  })

  test('test agent denies arbitrary bash before execution with a clear error', async () => {
    registry.register(bashTool)
    const deniedCommand = 'rm -rf /tmp/example'
    const model = createMockModel([
      [...toolCallBlock('test_denied', 'bash', { command: deniedCommand }), finishToolCalls()],
      [
        ...textBlock(
          validSubagentResultText({
            summary: 'Denied command was reported.',
            claims: [],
            uncertainty: [],
            suggestedNextSteps: [],
          }),
        ),
        finishStop(),
      ],
    ])
    const config = makeConfig([primaryAgent(['test'])], ["printf 'allowed\\n'"])

    const result = await registry.executeTool(
      'spawn_agent',
      {
        agentId: 'test',
        task: `Try ${deniedCommand}`,
        outputFormat: 'json',
      },
      {
        model,
        toolRegistry: registry,
        config,
        basePath: tempDir,
        agentId: 'planner',
        systemPromptBuilder: () => 'Base child prompt.',
        memoryProvider: () => '',
        skillCatalogProvider: () => [],
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      status: 'failed',
      agentId: 'test',
      testCommandDenials: [
        {
          command: deniedCommand,
          message: expect.stringContaining('not allowed for test agents'),
        },
      ],
      error: {
        message: expect.stringContaining('not allowed for test agents'),
      },
    })
    expect((result.value as SpawnAgentResult).structuredResult.uncertainty.join('\n')).toContain(
      deniedCommand,
    )
  })

  test('restricted test registry blocks denied commands without invoking parent bash', async () => {
    let executed = false
    const parent = new ToolRegistry()
    parent.register({
      ...bashTool,
      execute: async () => {
        executed = true
        return ok({ stdout: '', stderr: '', exitCode: 0 })
      },
    })

    const denials: Array<{ command: string; message: string }> = []
    const testRegistry = createTestToolRegistry(parent, {
      allowedCommands: ['echo allowed'],
      onDeniedCommand: (denial) => denials.push(denial),
    })
    const result = await testRegistry.executeTool('bash', { command: 'rm -rf /tmp/example' })

    expect(result.ok).toBe(false)
    expect(executed).toBe(false)
    expect(denials).toEqual([
      {
        command: 'rm -rf /tmp/example',
        message: expect.stringContaining('Allowed commands: echo allowed'),
      },
    ])
  })

  test('failed test command is surfaced and persisted without crashing spawn_agent', async () => {
    registry.register(bashTool)
    const transcriptStore = new TranscriptStore(join(tempDir, 'test-agent-failed.db'))
    try {
      const parentSession = transcriptStore.createSession(tempDir)
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) return

      const command = "printf 'failing-test\\n'; exit 7"
      const model = createMockModel([
        [...toolCallBlock('test_fail', 'bash', { command, timeout: 2 }), finishToolCalls()],
        [
          ...textBlock(
            validSubagentResultText({
              summary: 'Tests failed.',
              claims: [],
              uncertainty: [],
              suggestedNextSteps: ['Inspect the failing test output.'],
            }),
          ),
          finishStop(),
        ],
      ])
      const config = makeConfig([primaryAgent(['test'])], [command])

      const result = await registry.executeTool(
        'spawn_agent',
        {
          agentId: 'test',
          task: `Run ${command}`,
          outputFormat: 'json',
        },
        {
          model,
          toolRegistry: registry,
          config,
          transcriptStore,
          sessionId: parentSession.value,
          basePath: tempDir,
          agentId: 'planner',
          systemPromptBuilder: () => 'Base child prompt.',
          memoryProvider: () => '',
          skillCatalogProvider: () => [],
        },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toMatchObject({
        status: 'failed',
        agentId: 'test',
        testResults: [
          {
            command,
            exitCode: 7,
            status: 'failed',
          },
        ],
        error: {
          message: `Test command failed: ${command} exited with 7`,
        },
      })
      const spawnResult = result.value as SpawnAgentResult
      expect(spawnResult.testResults?.[0].outputExcerpt).toContain('failing-test')

      const runs = transcriptStore.getSubagentRunsForParent(parentSession.value)
      expect(runs.ok).toBe(true)
      if (!runs.ok) return
      expect(runs.value[0]).toMatchObject({
        agentId: 'test',
        status: 'failed',
        errorMessage: `Test command failed: ${command} exited with 7`,
      })
      expect(runs.value[0].finalResult).toContain('"testResults"')
      expect(runs.value[0].finalResult).toContain('"status":"failed"')
    } finally {
      transcriptStore.close()
    }
  })
})

describe('spawn-agent skill propagation helpers', () => {
  test('scopeSkillCatalogProvider passes through when no allowlist', () => {
    const fullCatalog = [
      { name: 'a', description: 'A', status: 'core' as const },
      { name: 'b', description: 'B', status: 'core' as const },
    ]
    const wrapped = spawnAgentTool.scopeSkillCatalogProvider(() => fullCatalog, undefined)
    expect(wrapped?.()).toEqual(fullCatalog)

    const wrappedEmpty = spawnAgentTool.scopeSkillCatalogProvider(() => fullCatalog, [])
    expect(wrappedEmpty?.()).toEqual(fullCatalog)
  })

  test('scopeSkillCatalogProvider filters to the allowed names', () => {
    const fullCatalog = [
      { name: 'a', description: 'A', status: 'core' as const },
      { name: 'b', description: 'B', status: 'core' as const },
      { name: 'c', description: 'C', status: 'core' as const },
    ]
    const wrapped = spawnAgentTool.scopeSkillCatalogProvider(() => fullCatalog, ['a', 'c'])
    expect(wrapped?.().map((s) => s.name)).toEqual(['a', 'c'])
  })

  test('scopeSkillCatalogProvider returns undefined when parent provider is undefined', () => {
    expect(spawnAgentTool.scopeSkillCatalogProvider(undefined, ['a'])).toBeUndefined()
  })

  test('resolveInheritedSkill returns undefined unless inheritSkill is true', () => {
    const parent = { name: 'foo', instructions: '', references: [], fileList: [] }
    expect(spawnAgentTool.resolveInheritedSkill(undefined, parent)).toBeUndefined()
    expect(spawnAgentTool.resolveInheritedSkill(false, parent)).toBeUndefined()
    expect(spawnAgentTool.resolveInheritedSkill(true, parent)).toBe(parent)
    expect(spawnAgentTool.resolveInheritedSkill(true, undefined)).toBeUndefined()
  })
})
