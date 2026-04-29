import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Agent, type AgentOptions } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { z } from 'zod'
import { ok } from '@src/types'
import type { ToolDefinition } from '@src/tools/types'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { TranscriptStore } from '@src/memory/transcripts'
import { writeCheckpoint } from '@src/memory/checkpoints'
import { configSchema, type OuroborosConfig } from '@src/config'
import { OpenAIChatGPTAuthManager } from '@src/auth/openai-chatgpt'
import {
  isJsonRpcRequest,
  makeResponse,
  makeErrorResponse,
  makeNotification,
  JSON_RPC_ERRORS,
} from '@src/json-rpc/types'
import {
  createHandlers,
  bridgeAgentEvent,
  HandlerError,
  type HandlerContext,
} from '@src/json-rpc/handlers'
import { writeMessage } from '@src/json-rpc/transport'
import { ModeManager } from '@src/modes/manager'
import { TaskGraphStore, type TaskGraph } from '@src/team/task-graph'
import { execute as executeAskUser, setAskUserPromptHandler } from '@src/tools/ask-user'
import * as spawnAgentTool from '@src/tools/spawn-agent'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ReflectionCheckpoint } from '@src/rsi/types'
import type { AgentDefinition, PermissionConfig } from '@src/types'
import { _resetSkills } from '@src/tools/skill-manager'

// ── Test Helpers ────────────────────────────────────────────────────

function createMockModel(turns: LanguageModelV3StreamPart[][]): LanguageModel {
  let turnIndex = 0

  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error('doGenerate not used by agent — use doStream')
    },

    doStream: async () => {
      const parts = turns[turnIndex] ?? []
      turnIndex++

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  } as LanguageModel
}

function makeTool(
  name: string,
  handler?: (args: Record<string, unknown>) => unknown,
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    schema: z.object({ input: z.string().optional() }),
    execute: async (args) =>
      ok(handler ? handler(args as Record<string, unknown>) : { output: `${name} executed` }),
  }
}

function makeAgentOptions(
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

/** Create a minimal mock config. */
function makeTestConfig(): OuroborosConfig {
  return configSchema.parse({})
}

const READ_ONLY_PERMISSIONS: PermissionConfig = {
  tier0: true,
  tier1: false,
  tier2: false,
  tier3: false,
  tier4: false,
}

function makePlannerAgent(canInvokeAgents: string[]): AgentDefinition {
  return {
    id: 'planner',
    description: 'Planner',
    mode: 'primary',
    prompt: 'Plan and delegate bounded read-only work.',
    permissions: {
      ...READ_ONLY_PERMISSIONS,
      canInvokeAgents,
    },
  }
}

function validSubagentResultText(): string {
  return JSON.stringify({
    summary: 'Child summary.',
    claims: [
      {
        claim: 'The child checked the task.',
        evidence: [{ type: 'output', excerpt: 'Checked.' }],
        confidence: 0.8,
      },
    ],
    uncertainty: [],
    suggestedNextSteps: ['Continue.'],
  })
}

/** Create a handler context for testing with a mock agent. */
function createTestContext(overrides?: {
  model?: LanguageModel
  registry?: ToolRegistry
  config?: OuroborosConfig
  configDir?: string
  transcriptStore?: TranscriptStore
  agentOptions?: Partial<AgentOptions>
  authManager?: OpenAIChatGPTAuthManager
  modeManager?: ModeManager
  taskGraphStore?: TaskGraphStore
}): HandlerContext {
  const registry = overrides?.registry ?? new ToolRegistry()
  const model =
    overrides?.model ??
    createMockModel([
      [
        { type: 'text-start', id: 'tx1' },
        { type: 'text-delta', id: 'tx1', delta: 'Hello from agent' },
        { type: 'text-end', id: 'tx1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 10,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
          },
        },
      ],
    ])

  const config = overrides?.config ?? makeTestConfig()
  const configDir = overrides?.configDir ?? tmpdir()

  // Create a real TranscriptStore in a temp location
  const dbPath = join(configDir, `.ouroboros-test-${crypto.randomUUID()}.db`)
  const transcriptStore = overrides?.transcriptStore ?? new TranscriptStore(dbPath)

  let currentRunAbort: AbortController | null = null
  let currentSessionId: string | null = null
  let currentConfigDir = configDir

  const agent = new Agent(
    makeAgentOptions(model, registry, {
      onEvent: bridgeAgentEvent,
      config,
      basePath: configDir,
      ...overrides?.agentOptions,
    }),
  )

  const ctx: HandlerContext = {
    getAgent: () => agent,
    config,
    configDir: currentConfigDir,
    initialCwd: process.cwd(),
    initialConfigDir: configDir,
    transcriptStore,
    authManager: overrides?.authManager ?? new OpenAIChatGPTAuthManager(),
    currentRunAbort,
    setCurrentRunAbort: (abort) => {
      currentRunAbort = abort
      ctx.currentRunAbort = abort
    },
    currentSessionId,
    setCurrentSessionId: (sessionId) => {
      currentSessionId = sessionId
      ctx.currentSessionId = sessionId
    },
    setConfig: (newConfig) => {
      ctx.config = newConfig
    },
    setConfigDir: (newConfigDir) => {
      currentConfigDir = newConfigDir
      ctx.configDir = newConfigDir
    },
    modeManager: overrides?.modeManager ?? new ModeManager(),
    taskGraphStore: overrides?.taskGraphStore,
  }

  return ctx
}

/** Capture stdout writes during a function's execution. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === 'string') {
      captured += chunk
    } else {
      captured += Buffer.from(chunk).toString('utf-8')
    }
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}

/** Parse NDJSON output lines into an array of objects. */
function parseNdjson(output: string): unknown[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

// ── Feature Tests ───────────────────────────────────────────────────

describe('JSON-RPC', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (savedEnv.OPENAI_API_KEY === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY
    }

    if (savedEnv.ANTHROPIC_API_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY
    }
  })

  // -------------------------------------------------------------------
  // Test: Type helpers
  // -------------------------------------------------------------------
  describe('type helpers', () => {
    test('isJsonRpcRequest validates correctly', () => {
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'test', params: {} })).toBe(true)
      expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'test' })).toBe(true)
      expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'test' })).toBe(false)
      expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false) // missing id
      expect(isJsonRpcRequest(null)).toBe(false)
      expect(isJsonRpcRequest('string')).toBe(false)
    })

    test('makeResponse creates correct response', () => {
      const resp = makeResponse(1, { data: 'test' })
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBe(1)
      expect(resp.result).toEqual({ data: 'test' })
      expect(resp.error).toBeUndefined()
    })

    test('makeErrorResponse creates correct error response', () => {
      const resp = makeErrorResponse(1, -32601, 'Method not found')
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBe(1)
      expect(resp.error).toEqual({ code: -32601, message: 'Method not found' })
      expect(resp.result).toBeUndefined()
    })

    test('makeNotification creates correct notification', () => {
      const notif = makeNotification('agent/text', { text: 'hello' })
      expect(notif.jsonrpc).toBe('2.0')
      expect(notif.method).toBe('agent/text')
      expect(notif.params).toEqual({ text: 'hello' })
      expect((notif as unknown as Record<string, unknown>).id).toBeUndefined()
    })
  })

  describe('event bridge', () => {
    test('bridges context usage events into JSON-RPC notifications', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'context-usage',
          estimatedTotalTokens: 12_345,
          contextWindowTokens: 200_000,
          usageRatio: 0.061725,
          threshold: 'within-budget',
          breakdown: {
            systemPromptTokens: 8000,
            toolPromptTokens: 1000,
            agentsInstructionsTokens: 2000,
            memoryTokens: 300,
            conversationTokens: 45,
            toolResultTokens: 0,
          },
          contextWindowSource: 'model-registry',
        })
      })

      expect(parseNdjson(output)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'agent/contextUsage',
          params: {
            sessionId: null,
            estimatedTotalTokens: 12_345,
            contextWindowTokens: 200_000,
            usageRatio: 0.061725,
            threshold: 'within-budget',
            breakdown: {
              systemPromptTokens: 8000,
              toolPromptTokens: 1000,
              agentsInstructionsTokens: 2000,
              memoryTokens: 300,
              conversationTokens: 45,
              toolResultTokens: 0,
            },
            contextWindowSource: 'model-registry',
          },
        },
      ])
    })

    test('bridges events with the supplied sessionId so notifications can be routed per-session', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({ type: 'text', text: 'hi' }, 'session-abc')
      })

      expect(parseNdjson(output)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'agent/text',
          params: { sessionId: 'session-abc', text: 'hi' },
        },
      ])
    })
  })

  // -------------------------------------------------------------------
  // Test: Basic request/response round-trip
  // -------------------------------------------------------------------
  describe('basic request/response round-trip', () => {
    test('session/new returns a session ID and updates the current view', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('session/new')!
      expect(handler).toBeDefined()

      const result = (await handler({})) as { sessionId: string }
      expect(result.sessionId).toBeDefined()
      expect(typeof result.sessionId).toBe('string')
      expect(result.sessionId.length).toBeGreaterThan(0)
      // session/new updates the "currently viewed session" but is now decoupled
      // from any running agent so a mid-stream call cannot corrupt another
      // session's in-memory state. The new session's agent is materialized
      // lazily on the first agent/run.
      expect(ctx.currentSessionId).toBe(result.sessionId)

      ctx.transcriptStore.close()
    })

    test('session/new simple mode creates a retained session folder', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'ouroboros-simple-session-'))
      const ctx = createTestContext({ configDir })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('session/new')!({ workspaceMode: 'simple' })) as {
        sessionId: string
        workspacePath: string
        workspaceMode: 'simple'
      }

      expect(result.workspaceMode).toBe('simple')
      expect(result.workspacePath).toBe(
        join(configDir, '.ouroboros-simple-sessions', result.sessionId),
      )
      expect(existsSync(result.workspacePath)).toBe(true)

      const loaded = ctx.transcriptStore.getSession(result.sessionId)
      expect(loaded.ok).toBe(true)
      if (loaded.ok) {
        expect(loaded.value.workspaceMode).toBe('simple')
        expect(loaded.value.workspacePath).toBe(result.workspacePath)
      }

      ctx.transcriptStore.close()
      rmSync(configDir, { recursive: true, force: true })
    })

    test('session/new workspace mode requires an existing workspace folder', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      await expect(handlers.get('session/new')!({ workspaceMode: 'workspace' })).rejects.toThrow(
        'params.workspacePath is required',
      )
      await expect(
        handlers.get('session/new')!({
          workspaceMode: 'workspace',
          workspacePath: join(tmpdir(), `missing-${crypto.randomUUID()}`),
        }),
      ).rejects.toThrow('params.workspacePath must be an existing directory')

      ctx.transcriptStore.close()
    })

    test('existing sessions without workspace_mode load as workspace mode', async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'ouroboros-legacy-session-'))
      const dbPath = join(configDir, 'legacy.db')
      const legacy = new Database(dbPath)
      legacy.run(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT,
          title TEXT,
          title_source TEXT,
          workspace_path TEXT
        )
      `)
      legacy.run(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_name TEXT,
          tool_args TEXT,
          created_at TEXT NOT NULL
        )
      `)
      legacy
        .prepare('INSERT INTO sessions (id, started_at, workspace_path) VALUES (?, ?, ?)')
        .run('legacy-session', new Date().toISOString(), configDir)
      legacy.close()

      const store = new TranscriptStore(dbPath)
      const loaded = store.getSession('legacy-session')
      expect(loaded.ok).toBe(true)
      if (loaded.ok) {
        expect(loaded.value.workspaceMode).toBe('workspace')
      }

      store.close()
      rmSync(configDir, { recursive: true, force: true })
    })
  })

  describe('team task graph handlers', () => {
    test('team/create creates a graph and team/get retrieves it', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)

      const created = (await handlers.get('team/create')!({
        name: 'Wave 10',
        tasks: [
          {
            id: 'task-a',
            title: 'Implement runtime',
            requiredArtifacts: ['test report'],
            qualityGates: [{ id: 'gate-a', description: 'Tests pass' }],
          },
        ],
      })) as { graph: TaskGraph }

      const retrieved = (await handlers.get('team/get')!({
        graphId: created.graph.id,
      })) as { graph: TaskGraph }

      expect(retrieved.graph.id).toBe(created.graph.id)
      expect(retrieved.graph.name).toBe('Wave 10')
      expect(retrieved.graph.tasks[0]).toEqual(
        expect.objectContaining({
          id: 'task-a',
          title: 'Implement runtime',
          status: 'pending',
          requiredArtifacts: ['test report'],
        }),
      )
      expect(retrieved.graph.tasks[0]?.qualityGates[0]).toEqual(
        expect.objectContaining({
          id: 'gate-a',
          description: 'Tests pass',
          required: true,
          status: 'pending',
        }),
      )

      ctx.transcriptStore.close()
    })

    test('team/createWorkflow creates a deterministic built-in workflow graph', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)

      const created = (await handlers.get('team/createWorkflow')!({
        template: 'parallel-investigation',
        taskContext: 'Investigate task graph orchestration.',
      })) as { graph: TaskGraph }

      expect(created.graph.name).toBe('Parallel Investigation')
      expect(created.graph.tasks.map((task) => task.id)).toEqual([
        'explorer-primary',
        'explorer-alternative',
        'explorer-risk',
        'synthesis',
      ])
      expect(created.graph.tasks.find((task) => task.id === 'synthesis')?.dependencies).toEqual([
        'explorer-primary',
        'explorer-alternative',
        'explorer-risk',
      ])

      ctx.transcriptStore.close()
    })

    test('blocked tasks become pending after dependencies complete', async () => {
      const store = new TaskGraphStore()
      const graphResult = store.createGraph({
        tasks: [
          { id: 'task-a', title: 'Task A' },
          { id: 'task-b', title: 'Task B', dependencies: ['task-a'] },
        ],
      })
      expect(graphResult.ok).toBe(true)
      if (!graphResult.ok) throw graphResult.error
      expect(graphResult.value.tasks.find((task) => task.id === 'task-b')?.status).toBe('blocked')

      const completed = store.completeTask(graphResult.value.id, 'task-a')
      expect(completed.ok).toBe(true)
      if (!completed.ok) throw completed.error

      expect(completed.value.tasks.find((task) => task.id === 'task-b')?.status).toBe('pending')
    })

    test('concurrent claim attempts cannot assign one task twice', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)
      const created = (await handlers.get('team/create')!({
        tasks: [{ id: 'task-a', title: 'Task A' }],
      })) as { graph: TaskGraph }

      const claims = await Promise.allSettled([
        handlers.get('team/assignTask')!({
          graphId: created.graph.id,
          taskId: 'task-a',
          agentId: 'sam',
        }),
        handlers.get('team/assignTask')!({
          graphId: created.graph.id,
          taskId: 'task-a',
          agentId: 'tim',
        }),
      ])

      const fulfilled = claims.filter((claim) => claim.status === 'fulfilled')
      const rejected = claims.filter((claim) => claim.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const graph = store.getGraph(created.graph.id)
      expect(graph.ok).toBe(true)
      if (!graph.ok) throw graph.error
      const task = graph.value.tasks.find((candidate) => candidate.id === 'task-a')
      expect(task).toBeDefined()
      expect(task?.status).toBe('running')
      expect(task?.assignedAgentId).toBeDefined()
      expect(['sam', 'tim']).toContain(task!.assignedAgentId as string)
      expect(
        graph.value.agents.filter((agent) => agent.activeTaskIds.includes('task-a')),
      ).toHaveLength(1)

      ctx.transcriptStore.close()
    })

    test('team/cancel updates active tasks and agents', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)
      const created = (await handlers.get('team/create')!({
        tasks: [{ id: 'task-a', title: 'Task A' }],
      })) as { graph: TaskGraph }
      await handlers.get('team/assignTask')!({
        graphId: created.graph.id,
        taskId: 'task-a',
        agentId: 'sam',
      })

      const cancelled = (await handlers.get('team/cancel')!({
        graphId: created.graph.id,
        reason: 'Stopped by user',
      })) as { graph: TaskGraph }

      expect(cancelled.graph.status).toBe('cancelled')
      expect(cancelled.graph.tasks[0]?.status).toBe('cancelled')
      expect(cancelled.graph.tasks[0]?.cancellationReason).toBe('Stopped by user')
      expect(cancelled.graph.agents[0]).toEqual(
        expect.objectContaining({
          id: 'sam',
          status: 'cancelled',
          activeTaskIds: [],
        }),
      )

      ctx.transcriptStore.close()
    })

    test('team/cleanup refuses while agents are active', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)
      const created = (await handlers.get('team/create')!({
        tasks: [{ id: 'task-a', title: 'Task A' }],
      })) as { graph: TaskGraph }
      await handlers.get('team/assignTask')!({
        graphId: created.graph.id,
        taskId: 'task-a',
        agentId: 'sam',
      })

      await expect(handlers.get('team/cleanup')!({ graphId: created.graph.id })).rejects.toThrow(
        'Cannot cleanup team while agents are active: sam',
      )

      expect(store.getGraph(created.graph.id).ok).toBe(true)

      ctx.transcriptStore.close()
    })

    test('team/addTask and team/sendMessage update the graph', async () => {
      const store = new TaskGraphStore()
      const ctx = createTestContext({ taskGraphStore: store })
      const handlers = createHandlers(ctx)
      const created = (await handlers.get('team/create')!({ name: 'Messages' })) as {
        graph: TaskGraph
      }

      const added = (await handlers.get('team/addTask')!({
        graphId: created.graph.id,
        task: { id: 'task-a', title: 'Task A' },
      })) as { graph: TaskGraph }
      const sent = (await handlers.get('team/sendMessage')!({
        graphId: created.graph.id,
        taskId: 'task-a',
        agentId: 'sam',
        message: 'Please work this task.',
      })) as { graph: TaskGraph }

      expect(added.graph.tasks).toHaveLength(1)
      expect(sent.graph.messages[0]).toEqual(
        expect.objectContaining({
          taskId: 'task-a',
          agentId: 'sam',
          message: 'Please work this task.',
        }),
      )

      ctx.transcriptStore.close()
    })
  })

  describe('RSI history handlers', () => {
    test('rsi/history returns checkpoint summaries newest first', async () => {
      const configDir = join(tmpdir(), `ouroboros-jsonrpc-rsi-${crypto.randomUUID()}`)
      mkdirSync(configDir, { recursive: true })
      const ctx = createTestContext({ configDir })
      const handlers = createHandlers(ctx)

      const older: ReflectionCheckpoint = {
        sessionId: 'session-older',
        updatedAt: '2026-04-17T09:00:00.000Z',
        goal: 'Review architecture',
        currentPlan: ['Inspect CLI'],
        constraints: [],
        decisionsMade: [],
        filesInPlay: [],
        completedWork: ['Read handlers'],
        openLoops: ['Summarize findings'],
        nextBestStep: 'Write summary',
        durableMemoryCandidates: [],
        skillCandidates: [],
      }

      const newer: ReflectionCheckpoint = {
        sessionId: 'session-newer',
        updatedAt: '2026-04-18T09:00:00.000Z',
        goal: 'Improve RSI drawer',
        currentPlan: ['Design history browser'],
        constraints: ['Stay in drawer'],
        decisionsMade: [],
        filesInPlay: ['packages/desktop/src/renderer/components/RSIDrawer.tsx'],
        completedWork: [],
        openLoops: ['Add history view', 'Add detail pane'],
        nextBestStep: 'Wire checkpoint RPC',
        durableMemoryCandidates: [
          {
            title: 'UI preference',
            summary: 'Use drawer',
            content: 'Use drawer',
            kind: 'preference',
            confidence: 0.8,
            observedAt: '2026-04-18T08:00:00.000Z',
            tags: [],
            evidence: ['user asked for drawer browser'],
          },
        ],
        skillCandidates: [
          {
            name: 'rsi-browser',
            summary: 'Build history browser UIs',
            trigger: 'Adding RSI history',
            workflow: ['Define protocol', 'Render timeline'],
            confidence: 0.7,
            sourceObservationIds: ['obs-1'],
            sourceSessionIds: ['session-newer'],
          },
        ],
      }

      expect(writeCheckpoint(older, configDir).ok).toBe(true)
      expect(writeCheckpoint(newer, configDir).ok).toBe(true)

      const result = (await handlers.get('rsi/history')!({ limit: 10 })) as {
        entries: Array<{ sessionId: string; updatedAt: string; openLoopCount: number }>
      }

      expect(result.entries).toHaveLength(2)
      expect(result.entries[0]).toEqual(
        expect.objectContaining({
          sessionId: 'session-newer',
          updatedAt: '2026-04-18T09:00:00.000Z',
          openLoopCount: 2,
        }),
      )
      expect(result.entries[1]).toEqual(
        expect.objectContaining({
          sessionId: 'session-older',
          updatedAt: '2026-04-17T09:00:00.000Z',
          openLoopCount: 1,
        }),
      )

      ctx.transcriptStore.close()
      rmSync(configDir, { recursive: true, force: true })
    })

    test('rsi/checkpoint returns the stored checkpoint detail', async () => {
      const configDir = join(tmpdir(), `ouroboros-jsonrpc-rsi-detail-${crypto.randomUUID()}`)
      mkdirSync(configDir, { recursive: true })
      const ctx = createTestContext({ configDir })
      const handlers = createHandlers(ctx)

      const checkpoint: ReflectionCheckpoint = {
        sessionId: 'session-detail',
        updatedAt: '2026-04-18T11:00:00.000Z',
        goal: 'Ship reflection browser',
        currentPlan: ['Add protocol', 'Add hook'],
        constraints: ['Keep design system'],
        decisionsMade: ['Use drawer tabs'],
        filesInPlay: ['packages/desktop/src/shared/protocol.ts'],
        completedWork: ['Added RSI history RPC'],
        openLoops: ['Add tests'],
        nextBestStep: 'Render detail pane',
        durableMemoryCandidates: [],
        skillCandidates: [],
      }

      expect(writeCheckpoint(checkpoint, configDir).ok).toBe(true)

      const result = (await handlers.get('rsi/checkpoint')!({
        sessionId: 'session-detail',
      })) as { checkpoint: ReflectionCheckpoint | null }

      expect(result.checkpoint).toEqual(checkpoint)

      ctx.transcriptStore.close()
      rmSync(configDir, { recursive: true, force: true })
    })
  })

  // -------------------------------------------------------------------
  // Test: Agent run streams notifications
  // -------------------------------------------------------------------
  describe('agent run streams notifications', () => {
    test('agent/run emits text and turnComplete notifications', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('agent/run')!
      expect(handler).toBeDefined()

      const output = await captureStdout(async () => {
        await handler({ message: 'Say hello' })
      })

      const messages = parseNdjson(output)

      // Should have at least one agent/text notification
      const textNotifs = messages.filter(
        (m) => (m as Record<string, unknown>).method === 'agent/text',
      )
      expect(textNotifs.length).toBeGreaterThanOrEqual(1)

      // Should have an agent/turnComplete notification
      const turnComplete = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/turnComplete',
      )
      expect(turnComplete).toBeDefined()

      ctx.transcriptStore.close()
    })

    test('workspace/set changes AGENTS.md prompt context for subsequent runs', async () => {
      const baseDir = join(tmpdir(), `ouroboros-jsonrpc-agents-${crypto.randomUUID()}`)
      const rootDir = join(baseDir, 'root')
      const nestedDir = join(rootDir, 'packages', 'app')
      mkdirSync(nestedDir, { recursive: true })
      writeFileSync(join(rootDir, 'AGENTS.md'), '# Root\n\nRoot rules.')
      writeFileSync(join(nestedDir, 'AGENTS.md'), '# Nested\n\nNested rules.')

      const promptCalls: Array<Record<string, unknown>> = []
      const ctx = createTestContext({
        configDir: baseDir,
        agentOptions: {
          systemPromptBuilder: (options) => {
            promptCalls.push(options as Record<string, unknown>)
            return 'You are a test assistant.'
          },
        },
      })
      const handlers = createHandlers(ctx)

      const workspaceHandler = handlers.get('workspace/set')!
      const runHandler = handlers.get('agent/run')!

      const originalCwd = process.cwd()
      try {
        await workspaceHandler({ directory: rootDir })
        await runHandler({ message: 'First run' })
        await workspaceHandler({ directory: nestedDir })
        await runHandler({ message: 'Second run' })
      } finally {
        process.chdir(originalCwd)
        rmSync(baseDir, { recursive: true, force: true })
        ctx.transcriptStore.close()
      }

      expect(promptCalls).toHaveLength(2)
      expect(String(promptCalls[0]?.agentsInstructions ?? '')).toContain('Root rules.')
      expect(String(promptCalls[0]?.agentsInstructions ?? '')).not.toContain('Nested rules.')
      expect(String(promptCalls[1]?.agentsInstructions ?? '')).toContain('Root rules.')
      expect(String(promptCalls[1]?.agentsInstructions ?? '')).toContain('Nested rules.')
    })

    test('workspace/clear reverts cwd to the initial launch directory', async () => {
      const baseDir = realpathSync(
        mkdtempSync(join(tmpdir(), `ouroboros-jsonrpc-clear-${crypto.randomUUID()}-`)),
      )
      const initialDir = join(baseDir, 'initial')
      const otherDir = join(baseDir, 'other')
      mkdirSync(initialDir, { recursive: true })
      mkdirSync(otherDir, { recursive: true })

      const originalCwd = process.cwd()
      process.chdir(initialDir)

      const ctx = createTestContext({ configDir: initialDir })
      // Override to reflect post-chdir initial cwd, mirroring what
      // startJsonRpcServer captures at startup.
      ctx.initialCwd = initialDir
      ctx.initialConfigDir = initialDir

      const handlers = createHandlers(ctx)
      const setHandler = handlers.get('workspace/set')!
      const clearHandler = handlers.get('workspace/clear')!

      try {
        // Create a session so the handler exercises the session-update branch.
        const sessionResult = ctx.transcriptStore.createSession(initialDir)
        if (!sessionResult.ok) throw sessionResult.error
        ctx.setCurrentSessionId(sessionResult.value)

        await setHandler({ directory: otherDir })
        expect(process.cwd()).toBe(realpathSync(otherDir))

        const clearResult = (await clearHandler({})) as { directory: string }
        expect(clearResult.directory).toBe(realpathSync(initialDir))
        expect(process.cwd()).toBe(realpathSync(initialDir))

        const sessionAfter = ctx.transcriptStore.getSession(sessionResult.value)
        if (!sessionAfter.ok) throw sessionAfter.error
        expect(sessionAfter.value.workspacePath).toBe(realpathSync(initialDir))
      } finally {
        process.chdir(originalCwd)
        rmSync(baseDir, { recursive: true, force: true })
        ctx.transcriptStore.close()
      }
    })

    test('agent/run accepts desktop response-style hints', async () => {
      const promptCalls: Array<Record<string, unknown>> = []
      const ctx = createTestContext({
        agentOptions: {
          systemPromptBuilder: (options) => {
            promptCalls.push(options as Record<string, unknown>)
            return 'You are a test assistant.'
          },
        },
      })
      const handlers = createHandlers(ctx)

      await handlers.get('agent/run')!({
        message: 'Say hello',
        client: 'desktop',
        responseStyle: 'desktop-readable',
      })

      expect(promptCalls).toContainEqual(
        expect.objectContaining({
          responseStyle: 'desktop-readable',
        }),
      )

      ctx.transcriptStore.close()
    })

    test('agent/run activates selected skill instructions', async () => {
      const baseDir = join(tmpdir(), `ouroboros-skill-run-${crypto.randomUUID()}`)
      const skillDir = join(baseDir, 'skills', 'core', 'code-review')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: code-review',
          'description: Review code carefully',
          '---',
          '',
          '## Review Instructions',
          '',
          'Look for correctness regressions.',
        ].join('\n'),
      )

      const promptCalls: Array<Record<string, unknown>> = []
      const ctx = createTestContext({
        configDir: baseDir,
        agentOptions: {
          systemPromptBuilder: (options) => {
            promptCalls.push(options as Record<string, unknown>)
            return 'You are a test assistant.'
          },
        },
      })
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('agent/run')!({
          message: 'Review this patch',
          skillName: 'code-review',
        })
      } finally {
        ctx.transcriptStore.close()
        rmSync(baseDir, { recursive: true, force: true })
        _resetSkills()
      }

      expect(promptCalls).toContainEqual(
        expect.objectContaining({
          activatedSkill: expect.objectContaining({
            name: 'code-review',
            instructions: expect.stringContaining('Look for correctness regressions.'),
          }),
        }),
      )
    })

    test('agent/run activates a built-in skill provided only via OUROBOROS_BUILTIN_SKILLS_DIR', async () => {
      // Regression: previously activateSkillForRun re-ran discovery without
      // the built-in roots, so a skill picked from a built-in source produced
      // "Skill not found" on submit.
      const baseDir = join(tmpdir(), `ouroboros-builtin-run-${crypto.randomUUID()}`)
      mkdirSync(baseDir, { recursive: true })
      const builtinRoot = join(tmpdir(), `ouroboros-builtin-root-${crypto.randomUUID()}`)
      const skillDir = join(builtinRoot, 'meta-thinking')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: meta-thinking',
          'description: Bundled meta-thinking',
          '---',
          '',
          'Apply the meta-thinking loop.',
        ].join('\n'),
      )

      const previousEnv = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      process.env.OUROBOROS_BUILTIN_SKILLS_DIR = builtinRoot

      const promptCalls: Array<Record<string, unknown>> = []
      const ctx = createTestContext({
        configDir: baseDir,
        agentOptions: {
          systemPromptBuilder: (options) => {
            promptCalls.push(options as Record<string, unknown>)
            return 'You are a test assistant.'
          },
        },
      })
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('agent/run')!({
          message: 'Plan this',
          skillName: 'meta-thinking',
        })
      } finally {
        if (previousEnv === undefined) {
          delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
        } else {
          process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousEnv
        }
        ctx.transcriptStore.close()
        rmSync(baseDir, { recursive: true, force: true })
        rmSync(builtinRoot, { recursive: true, force: true })
        _resetSkills()
      }

      expect(promptCalls).toContainEqual(
        expect.objectContaining({
          activatedSkill: expect.objectContaining({
            name: 'meta-thinking',
            instructions: expect.stringContaining('Apply the meta-thinking loop.'),
          }),
        }),
      )
    })

    test('agent/run rejects unknown selected skills', async () => {
      const baseDir = join(tmpdir(), `ouroboros-missing-skill-${crypto.randomUUID()}`)
      mkdirSync(baseDir, { recursive: true })
      const ctx = createTestContext({ configDir: baseDir })
      const handlers = createHandlers(ctx)

      try {
        await expect(
          handlers.get('agent/run')!({
            message: 'Review this patch',
            skillName: 'missing-skill',
          }),
        ).rejects.toThrow('Skill not found: "missing-skill"')
      } finally {
        ctx.transcriptStore.close()
        rmSync(baseDir, { recursive: true, force: true })
        _resetSkills()
      }
    })

    test('agent/steer rejects with no-active-run when no run is in flight', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('agent/steer')!({
        message: 'pivot',
        requestId: 'req-1',
      })) as { accepted: boolean; reason?: string }

      expect(result.accepted).toBe(false)
      expect(result.reason).toBe('no-active-run')

      ctx.transcriptStore.close()
    })

    test('agent/steer injects user message into in-flight run and emits agent/steerInjected', async () => {
      const registry = new ToolRegistry()
      let steerHandler: (params: Record<string, unknown>) => Promise<unknown>
      let agentRef: Agent | null = null

      // Tool fires once during turn 1 and uses the agent/steer JSON-RPC handler
      // to inject a steer; turn 2 (the post-tool LLM call) must see it.
      registry.register({
        name: 'noop',
        description: 'no-op',
        schema: z.object({}),
        execute: async () => {
          // Capture the agent right before calling the steer handler so the
          // handler resolves the same agent instance via getAgent().
          if (steerHandler) {
            const result = await steerHandler({
              message: 'pivot to plan B',
              requestId: 'req-mid',
            })
            expect(result).toMatchObject({ accepted: true })
          }
          return ok({ ok: true })
        },
      })

      const model = createMockModel([
        // Turn 1: tool call
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'noop' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'noop',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: undefined, reasoning: undefined },
            },
          },
        ],
        // Turn 2: final text after seeing the steer
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'okay, pivoted' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 5,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const ctx = createTestContext({ model, registry })
      const handlers = createHandlers(ctx)
      steerHandler = handlers.get('agent/steer')!
      agentRef = ctx.getAgent()

      // Pin a session so currentSessionId is set; the steer handler falls back to it.
      const sessionResult = ctx.transcriptStore.createSession(null)
      if (!sessionResult.ok) throw sessionResult.error
      ctx.setCurrentSessionId(sessionResult.value)

      const output = await captureStdout(async () => {
        await handlers.get('agent/run')!({ message: 'go' })
      })

      const messages = parseNdjson(output)
      const injected = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/steerInjected',
      ) as Record<string, unknown> | undefined
      expect(injected).toBeDefined()
      expect((injected!.params as Record<string, unknown>).steerId).toBe('req-mid')

      const userTurns = agentRef.getConversationHistory().filter((m) => m.role === 'user')
      expect(userTurns).toHaveLength(2)
      const steerContent = userTurns[1]!.content
      const text =
        typeof steerContent === 'string'
          ? steerContent
          : steerContent
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('')
      expect(text).toBe('pivot to plan B')

      ctx.transcriptStore.close()
    })

    test('agent/steer rejects malformed params', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      await expect(handlers.get('agent/steer')!({ requestId: 'r' })).rejects.toBeInstanceOf(
        HandlerError,
      )
      await expect(handlers.get('agent/steer')!({ message: 'hi' })).rejects.toBeInstanceOf(
        HandlerError,
      )

      ctx.transcriptStore.close()
    })

    test('agent/run remains backward compatible when response-style hints are omitted', async () => {
      const promptCalls: Array<Record<string, unknown>> = []
      const ctx = createTestContext({
        agentOptions: {
          systemPromptBuilder: (options) => {
            promptCalls.push(options as Record<string, unknown>)
            return 'You are a test assistant.'
          },
        },
      })
      const handlers = createHandlers(ctx)

      await handlers.get('agent/run')!({ message: 'Say hello' })

      expect(promptCalls).toContainEqual(
        expect.objectContaining({
          responseStyle: undefined,
        }),
      )

      ctx.transcriptStore.close()
    })

    test('agent/run uses desktop maxSteps profile for desktop clients', async () => {
      const registry = new ToolRegistry()
      registry.register(makeTool('bash', () => ({ output: 'looping' })))
      const config = configSchema.parse({
        agent: {
          maxSteps: {
            interactive: 10,
            desktop: 1,
            singleShot: 10,
            automation: 4,
          },
        },
      })
      const model = createMockModel([
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"loop"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'summary' },
          { type: 'text-delta', id: 'summary', delta: 'Desktop limit summary.' },
          { type: 'text-end', id: 'summary' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({ model, registry, config })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('agent/run')!({
        message: 'Loop',
        client: 'desktop',
      })) as Record<string, unknown>

      expect(result).toMatchObject({
        iterations: 1,
        stopReason: 'max_steps',
        maxIterationsReached: true,
      })

      ctx.transcriptStore.close()
    })

    test('agent/run maxSteps param overrides configured profile limit', async () => {
      const registry = new ToolRegistry()
      registry.register(makeTool('bash', () => ({ output: 'looping' })))
      const config = configSchema.parse({
        agent: {
          maxSteps: {
            interactive: 10,
            desktop: 1,
            singleShot: 10,
            automation: 10,
          },
        },
      })
      const model = createMockModel([
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"loop"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'tool-input-start', id: 'call_2', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_2' },
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'bash',
            input: '{"input":"loop"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'summary' },
          { type: 'text-delta', id: 'summary', delta: 'Override limit summary.' },
          { type: 'text-end', id: 'summary' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({ model, registry, config })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('agent/run')!({
        message: 'Loop',
        client: 'desktop',
        maxSteps: 2,
      })) as Record<string, unknown>

      expect(result).toMatchObject({
        iterations: 2,
        stopReason: 'max_steps',
        maxIterationsReached: true,
      })

      ctx.transcriptStore.close()
    })

    test('agent/run rejects invalid maxSteps param', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      await expect(handlers.get('agent/run')!({ message: 'Loop', maxSteps: 0 })).rejects.toThrow(
        'params.maxSteps must be a positive integer',
      )

      ctx.transcriptStore.close()
    })

    test('agent/run emits successful subagent lifecycle notifications', async () => {
      const registry = new ToolRegistry()
      registry.register(spawnAgentTool)
      const config = configSchema.parse({
        agent: {
          definitions: [makePlannerAgent(['explore'])],
        },
      })
      const sessionResult = new TranscriptStore(
        join(tmpdir(), `.ouroboros-subagent-success-${crypto.randomUUID()}.db`),
      )
      const parentSession = sessionResult.createSession(tmpdir())
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) {
        sessionResult.close()
        return
      }

      const model = createMockModel([
        [
          { type: 'tool-input-start', id: 'spawn_1', toolName: 'spawn_agent' },
          { type: 'tool-input-end', id: 'spawn_1' },
          {
            type: 'tool-call',
            toolCallId: 'spawn_1',
            toolName: 'spawn_agent',
            input: JSON.stringify({
              agentId: 'explore',
              task: 'Inspect the repo.',
              outputFormat: 'summary',
            }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'child' },
          { type: 'text-delta', id: 'child', delta: validSubagentResultText() },
          { type: 'text-end', id: 'child' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'parent' },
          { type: 'text-delta', id: 'parent', delta: 'Parent received child result.' },
          { type: 'text-end', id: 'parent' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({
        model,
        registry,
        config,
        transcriptStore: sessionResult,
        agentOptions: {
          agentId: 'planner',
          transcriptStore: sessionResult,
          sessionId: parentSession.value,
        },
      })
      const handlers = createHandlers(ctx)

      const output = await captureStdout(async () => {
        await handlers.get('agent/run')!({ message: 'Delegate.' })
      })
      const messages = parseNdjson(output) as Array<{
        method?: string
        params?: Record<string, unknown>
      }>
      const started = messages.find((m) => m.method === 'agent/subagentStarted')
      const completed = messages.find((m) => m.method === 'agent/subagentCompleted')

      expect(started).toBeDefined()
      expect(completed).toBeDefined()
      expect(started?.params).toMatchObject({
        parentSessionId: parentSession.value,
        agentId: 'explore',
        task: 'Inspect the repo.',
        status: 'running',
      })
      expect(completed?.params).toMatchObject({
        parentSessionId: parentSession.value,
        agentId: 'explore',
        task: 'Inspect the repo.',
        status: 'completed',
      })
      expect(completed?.params?.runId).toBe(started?.params?.runId)
      expect(typeof completed?.params?.childSessionId).toBe('string')

      ctx.transcriptStore.close()
    })

    test('agent/run emits failed subagent lifecycle notification', async () => {
      const registry = new ToolRegistry()
      registry.register(spawnAgentTool)
      const config = configSchema.parse({
        agent: {
          definitions: [makePlannerAgent(['explore'])],
        },
      })
      const transcriptStore = new TranscriptStore(
        join(tmpdir(), `.ouroboros-subagent-failure-${crypto.randomUUID()}.db`),
      )
      const parentSession = transcriptStore.createSession(tmpdir())
      expect(parentSession.ok).toBe(true)
      if (!parentSession.ok) {
        transcriptStore.close()
        return
      }

      const model = createMockModel([
        [
          { type: 'tool-input-start', id: 'spawn_1', toolName: 'spawn_agent' },
          { type: 'tool-input-end', id: 'spawn_1' },
          {
            type: 'tool-call',
            toolCallId: 'spawn_1',
            toolName: 'spawn_agent',
            input: JSON.stringify({
              agentId: 'explore',
              task: 'Fail during child run.',
              outputFormat: 'summary',
            }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          {
            type: 'error',
            error: new Error('Authentication failed for child model'),
          },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'parent' },
          { type: 'text-delta', id: 'parent', delta: 'Parent handled failure.' },
          { type: 'text-end', id: 'parent' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({
        model,
        registry,
        config,
        transcriptStore,
        agentOptions: {
          agentId: 'planner',
          transcriptStore,
          sessionId: parentSession.value,
        },
      })
      const handlers = createHandlers(ctx)

      const output = await captureStdout(async () => {
        await handlers.get('agent/run')!({ message: 'Delegate failing child.' })
      })
      const messages = parseNdjson(output) as Array<{
        method?: string
        params?: Record<string, unknown>
      }>
      const started = messages.find((m) => m.method === 'agent/subagentStarted')
      const failed = messages.find((m) => m.method === 'agent/subagentFailed')

      expect(started).toBeDefined()
      expect(failed).toBeDefined()
      expect(failed?.params).toMatchObject({
        parentSessionId: parentSession.value,
        agentId: 'explore',
        task: 'Fail during child run.',
        status: 'failed',
        error: {
          message: 'Child agent stopped with reason: error',
        },
      })
      expect(failed?.params?.runId).toBe(started?.params?.runId)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Tool call events are bridged
  // -------------------------------------------------------------------
  describe('tool call events are bridged', () => {
    test('tool call start and end are emitted as notifications', async () => {
      const registry = new ToolRegistry()
      registry.register(
        makeTool('bash', () => ({
          output: 'hello\n',
          exitCode: 0,
        })),
      )

      const model = createMockModel([
        // Turn 1: LLM calls bash tool
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"echo hello"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 15, text: undefined, reasoning: undefined },
            },
          },
        ],
        // Turn 2: LLM produces final text
        [
          { type: 'text-start', id: 'tx3' },
          { type: 'text-delta', id: 'tx3', delta: 'The output is hello' },
          { type: 'text-end', id: 'tx3' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 30,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 10, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])

      const ctx = createTestContext({ model, registry })
      const handlers = createHandlers(ctx)
      const handler = handlers.get('agent/run')!

      const output = await captureStdout(async () => {
        await handler({ message: 'Run echo hello' })
      })

      const messages = parseNdjson(output)

      // Should have agent/toolCallStart
      const toolStart = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/toolCallStart',
      ) as { params: { toolCallId: string; toolName: string } } | undefined
      expect(toolStart).toBeDefined()
      expect(toolStart!.params.toolCallId).toBe('call_1')
      expect(toolStart!.params.toolName).toBe('bash')

      // Should have agent/toolCallEnd
      const toolEnd = messages.find(
        (m) => (m as Record<string, unknown>).method === 'agent/toolCallEnd',
      ) as { params: { toolCallId: string; toolName: string } } | undefined
      expect(toolEnd).toBeDefined()
      expect(toolEnd!.params.toolCallId).toBe('call_1')
      expect(toolEnd!.params.toolName).toBe('bash')

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Unknown method returns error
  // -------------------------------------------------------------------
  describe('unknown method returns error', () => {
    test('unregistered method returns -32601', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('nonexistent/method')
      expect(handler).toBeUndefined()

      // The server would produce a METHOD_NOT_FOUND error for this case.
      // We verify the error code constant is correct.
      expect(JSON_RPC_ERRORS.METHOD_NOT_FOUND.code).toBe(-32601)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Invalid JSON returns parse error
  // -------------------------------------------------------------------
  describe('invalid JSON handling', () => {
    test('parse error code is -32700', () => {
      expect(JSON_RPC_ERRORS.PARSE_ERROR.code).toBe(-32700)
    })

    test('makeErrorResponse with parse error produces correct shape', () => {
      const resp = makeErrorResponse(
        null,
        JSON_RPC_ERRORS.PARSE_ERROR.code,
        JSON_RPC_ERRORS.PARSE_ERROR.message,
      )
      expect(resp.jsonrpc).toBe('2.0')
      expect(resp.id).toBeNull()
      expect(resp.error!.code).toBe(-32700)
      expect(resp.error!.message).toBe('Parse error')
    })
  })

  // -------------------------------------------------------------------
  // Test: Config get/set round-trip
  // -------------------------------------------------------------------
  describe('config get/set round-trip', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = join(tmpdir(), `ouroboros-test-${crypto.randomUUID()}`)
      mkdirSync(tempDir, { recursive: true })
    })

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    })

    test('config/get returns current config', async () => {
      const config = makeTestConfig()
      const ctx = createTestContext({ config, configDir: tempDir })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('config/get')!({})) as OuroborosConfig
      expect(result.model.provider).toBe('anthropic')
      expect(result.model.name).toBe('claude-sonnet-4-20250514')

      ctx.transcriptStore.close()
    })

    test('config/set updates and persists config', async () => {
      // Write an initial config file
      const config = makeTestConfig()
      writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(config, null, 2), 'utf-8')

      const ctx = createTestContext({ config, configDir: tempDir })
      const handlers = createHandlers(ctx)

      // Set a new model name
      const setResult = (await handlers.get('config/set')!({
        path: 'model.name',
        value: 'test-model',
      })) as OuroborosConfig
      expect(setResult.model.name).toBe('test-model')

      // Get should reflect the change
      const getResult = (await handlers.get('config/get')!({})) as OuroborosConfig
      expect(getResult.model.name).toBe('test-model')

      ctx.transcriptStore.close()
    })

    test('config/setApiKey persists model.apiKey into .ouroboros', async () => {
      const config = makeTestConfig()
      writeFileSync(join(tempDir, '.ouroboros'), JSON.stringify(config, null, 2), 'utf-8')

      const ctx = createTestContext({ config, configDir: tempDir })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('config/setApiKey')!({
        provider: 'openai',
        apiKey: 'cfg-openai-key',
      })) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(ctx.config.model.provider).toBe('openai')
      expect(ctx.config.model.apiKey).toBe('cfg-openai-key')

      const persisted = JSON.parse(readFileSync(join(tempDir, '.ouroboros'), 'utf-8')) as {
        model: { provider: string; apiKey: string }
      }
      expect(persisted.model.provider).toBe('openai')
      expect(persisted.model.apiKey).toBe('cfg-openai-key')

      ctx.transcriptStore.close()
    })

    test('config/testConnection uses auth manager for openai-chatgpt', async () => {
      const authManager = {
        testConnection: async () => ({
          ok: true as const,
          value: { models: ['gpt-5.4', 'gpt-5.4-mini'], accountId: 'acct_test' },
        }),
      } as unknown as OpenAIChatGPTAuthManager
      const ctx = createTestContext({ authManager })
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('config/testConnection')!({
        provider: 'openai-chatgpt',
      })) as { success: boolean; models?: string[]; error?: string }

      expect(result).toEqual({
        success: true,
        models: ['gpt-5.4', 'gpt-5.4-mini'],
      })

      ctx.transcriptStore.close()
    })

    test('config/testConnection uses supplied baseUrl for openai-compatible', async () => {
      const config = makeTestConfig()
      config.model.provider = 'openai-compatible'
      config.model.name = 'llama3.2'

      const ctx = createTestContext({ config })
      const handlers = createHandlers(ctx)

      const withoutBaseUrl = (await handlers.get('config/testConnection')!({
        provider: 'openai-compatible',
        apiKey: 'compatible-key',
      })) as { success: boolean; error?: string }
      expect(withoutBaseUrl.success).toBe(false)
      expect(withoutBaseUrl.error).toContain('baseUrl')

      const withBaseUrl = (await handlers.get('config/testConnection')!({
        provider: 'openai-compatible',
        apiKey: 'compatible-key',
        baseUrl: 'http://localhost:11434/v1',
      })) as { success: boolean; error?: string }
      expect(withBaseUrl.success).toBe(true)

      ctx.transcriptStore.close()
    })
  })

  describe('auth operations', () => {
    test('auth RPC handlers proxy to auth manager', async () => {
      const authManager = {
        getStatus: async () => ({
          provider: 'openai-chatgpt',
          connected: false,
          authType: null,
          pending: false,
          availableMethods: ['browser', 'headless'],
          models: ['gpt-5.4'],
        }),
        startLogin: async () => ({
          ok: true as const,
          value: {
            flowId: 'flow-1',
            provider: 'openai-chatgpt',
            method: 'browser',
            url: 'https://chatgpt.com/login',
            instructions: 'Open the browser',
            pending: true as const,
          },
        }),
        pollLogin: async () => ({
          ok: true as const,
          value: {
            provider: 'openai-chatgpt',
            connected: true,
            authType: 'oauth' as const,
            pending: false,
            availableMethods: ['browser', 'headless'] as const,
            models: ['gpt-5.4'],
            flowId: 'flow-1',
            method: 'browser' as const,
            success: true,
            accountId: 'acct_test',
          },
        }),
        cancelLogin: async () => ({ ok: true as const, value: { cancelled: true } }),
        logout: async () => ({ ok: true as const, value: undefined }),
      } as unknown as OpenAIChatGPTAuthManager

      const ctx = createTestContext({ authManager })
      const handlers = createHandlers(ctx)

      const status = (await handlers.get('auth/getStatus')!({
        provider: 'openai-chatgpt',
      })) as {
        connected: boolean
        pending: boolean
        models: string[]
      }
      expect(status.connected).toBe(false)
      expect(status.pending).toBe(false)

      const start = (await handlers.get('auth/startLogin')!({
        provider: 'openai-chatgpt',
        method: 'browser',
      })) as { flowId: string; pending: boolean; url: string }
      expect(start).toEqual(
        expect.objectContaining({
          flowId: 'flow-1',
          pending: true,
          url: 'https://chatgpt.com/login',
        }),
      )

      const poll = (await handlers.get('auth/pollLogin')!({
        provider: 'openai-chatgpt',
        flowId: 'flow-1',
      })) as { success: boolean; connected: boolean; accountId?: string }
      expect(poll.success).toBe(true)
      expect(poll.connected).toBe(true)
      expect(poll.accountId).toBe('acct_test')

      const cancel = (await handlers.get('auth/cancelLogin')!({
        provider: 'openai-chatgpt',
        flowId: 'flow-1',
      })) as { cancelled: boolean }
      expect(cancel.cancelled).toBe(true)

      const logout = (await handlers.get('auth/logout')!({
        provider: 'openai-chatgpt',
      })) as { ok: boolean }
      expect(logout.ok).toBe(true)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Session CRUD operations
  // -------------------------------------------------------------------
  describe('session operations', () => {
    test('session/list returns sessions', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session first
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      expect(newResult.sessionId).toBeDefined()

      await handlers.get('agent/run')!({ message: 'Restore my previous tab' })

      // List should include it
      const listResult = (await handlers.get('session/list')!({})) as {
        sessions: Array<{
          id: string
          createdAt: string
          lastActive: string
          messageCount: number
          title?: string
        }>
      }
      expect(listResult.sessions.length).toBeGreaterThanOrEqual(1)
      expect(listResult.sessions).toContainEqual(
        expect.objectContaining({
          id: newResult.sessionId,
          messageCount: 2,
          title: 'Restore my previous tab',
        }),
      )

      ctx.transcriptStore.close()
    })

    test('session/list supports pages and hasMore', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)
      const sessionIds: string[] = []

      for (let index = 0; index < 55; index += 1) {
        const result = ctx.transcriptStore.createSession()
        expect(result.ok).toBe(true)
        if (!result.ok) return
        sessionIds.push(result.value)
      }

      const firstPage = (await handlers.get('session/list')!({ limit: 50, offset: 0 })) as {
        sessions: Array<{ id: string }>
        hasMore: boolean
      }
      expect(firstPage.sessions).toHaveLength(50)
      expect(firstPage.sessions[0].id).toBe(sessionIds[54])
      expect(firstPage.sessions[49].id).toBe(sessionIds[5])
      expect(firstPage.hasMore).toBe(true)

      const secondPage = (await handlers.get('session/list')!({ limit: 50, offset: 50 })) as {
        sessions: Array<{ id: string }>
        hasMore: boolean
      }
      expect(secondPage.sessions.map((session) => session.id)).toEqual(
        sessionIds.slice(0, 5).reverse(),
      )
      expect(secondPage.hasMore).toBe(false)

      ctx.transcriptStore.close()
    })

    test('agent/run stores an automatic title after the first assistant turn', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          {
            type: 'text-delta',
            id: 'tx1',
            delta: 'Implemented the desktop session title rename flow.',
          },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({ model })
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({
        message: 'Implement the recommended direction - option 1 and 2',
      })

      const session = ctx.transcriptStore.getSession(newResult.sessionId)
      expect(session.ok).toBe(true)
      if (!session.ok) return
      expect(session.value.title).toBe('Desktop session title rename')
      expect(session.value.titleSource).toBe('auto')

      const listResult = (await handlers.get('session/list')!({})) as {
        sessions: Array<{ id: string; title?: string; titleSource?: string }>
      }
      expect(listResult.sessions).toContainEqual(
        expect.objectContaining({
          id: newResult.sessionId,
          title: 'Desktop session title rename',
          titleSource: 'auto',
        }),
      )

      ctx.transcriptStore.close()
    })

    test('session/rename stores a manual title that auto-title does not overwrite', async () => {
      const model = createMockModel([
        [
          { type: 'text-start', id: 'tx1' },
          { type: 'text-delta', id: 'tx1', delta: 'Implemented automatic title refresh.' },
          { type: 'text-end', id: 'tx1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'tx2' },
          { type: 'text-delta', id: 'tx2', delta: 'Updated the sidebar search experience.' },
          { type: 'text-end', id: 'tx2' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({ model })
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'Implement the recommended title changes' })

      const renameResult = (await handlers.get('session/rename')!({
        id: newResult.sessionId,
        title: 'Pinned Sidebar Title',
      })) as { id: string; title: string; titleSource: string }
      expect(renameResult).toEqual({
        id: newResult.sessionId,
        title: 'Pinned Sidebar Title',
        titleSource: 'manual',
      })

      await handlers.get('agent/run')!({ message: 'Continue improving this' })

      const session = ctx.transcriptStore.getSession(newResult.sessionId)
      expect(session.ok).toBe(true)
      if (!session.ok) return
      expect(session.value.title).toBe('Pinned Sidebar Title')
      expect(session.value.titleSource).toBe('manual')

      ctx.transcriptStore.close()
    })

    test('agent/run with skillName persists activatedSkills and surfaces them via session/load', async () => {
      // Set up a built-in skill via OUROBOROS_BUILTIN_SKILLS_DIR — same path the
      // desktop wires up — so the picker selection round-trips through the
      // server's skill discovery, persistence layer, and load handler.
      const builtinRoot = join(tmpdir(), `ouroboros-skill-row-${crypto.randomUUID()}`)
      const skillDir = join(builtinRoot, 'meta-thinking')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: meta-thinking\ndescription: Bundled\n---\n\nbody\n',
      )
      const previousEnv = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      process.env.OUROBOROS_BUILTIN_SKILLS_DIR = builtinRoot

      const ctx = createTestContext()

      // Match the wiring server.ts does so activations populate the per-run
      // accumulator. createTestContext leaves takeSkillActivations as a stub
      // returning [], so we override it together with the activation handler.
      const collected: string[] = []
      ctx.takeSkillActivations = () => collected.splice(0, collected.length)
      const { setSkillActivatedHandler, _resetSkillActivatedHandler } =
        await import('@src/tools/skill-manager')
      setSkillActivatedHandler((name) => {
        if (!collected.includes(name)) collected.push(name)
      })

      const handlers = createHandlers(ctx)
      try {
        const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
        await handlers.get('agent/run')!({
          message: 'Plan it',
          skillName: 'meta-thinking',
        })

        const loadResult = (await handlers.get('session/load')!({
          id: newResult.sessionId,
        })) as {
          messages: Array<{ role: string; content: string; activatedSkills?: string[] }>
        }
        const assistant = loadResult.messages.find((m) => m.role === 'assistant')
        expect(assistant?.activatedSkills).toEqual(['meta-thinking'])

        const userMsg = loadResult.messages.find((m) => m.role === 'user')
        expect(userMsg?.activatedSkills).toBeUndefined()
      } finally {
        if (previousEnv === undefined) {
          delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
        } else {
          process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousEnv
        }
        _resetSkillActivatedHandler()
        ctx.transcriptStore.close()
        rmSync(builtinRoot, { recursive: true, force: true })
        _resetSkills()
      }
    })

    test('session/load returns a session by ID', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'Load this chat again' })

      // Load it
      const loadResult = (await handlers.get('session/load')!({
        id: newResult.sessionId,
      })) as {
        id: string
        createdAt: string
        workspacePath: string | null
        messages: Array<{ role: string; content: string; timestamp: string }>
      }
      expect(loadResult.id).toBe(newResult.sessionId)
      expect(typeof loadResult.createdAt).toBe('string')
      expect(loadResult.workspacePath).toBe(process.cwd())
      expect(loadResult.messages).toBeInstanceOf(Array)
      expect(loadResult.messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: 'Load this chat again',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'Hello from agent',
        }),
      ])
      // session/load updates the desktop's "currently viewed session" but is
      // now decoupled from agent state — a mid-stream switch can't corrupt
      // another session's run. The agent for the loaded session is hydrated
      // lazily by getAgent(sessionId) on the next agent/run.
      expect(ctx.currentSessionId).toBe(newResult.sessionId)

      ctx.transcriptStore.close()
    })

    test('agent/run persists transcript messages to the active session', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'Persist this exchange' })

      const sessionResult = ctx.transcriptStore.getSession(newResult.sessionId)
      expect(sessionResult.ok).toBe(true)
      if (!sessionResult.ok) return

      expect(sessionResult.value.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ])
      expect(sessionResult.value.messages.map((message) => message.content)).toEqual([
        'Persist this exchange',
        'Hello from agent',
      ])

      ctx.transcriptStore.close()
    })

    test('session/load reconstructs tool calls attached to assistant messages', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }

      // Seed the transcript store directly with a persisted agent turn that
      // includes both tool-call and tool-result rows — mimicking what
      // `agent/run` writes during a live run.
      const store = ctx.transcriptStore
      store.addMessage(newResult.sessionId, { role: 'user', content: 'Read foo.ts' })
      store.addMessage(newResult.sessionId, {
        role: 'assistant',
        content: 'Reading the file now',
      })
      store.addMessage(newResult.sessionId, {
        role: 'tool-call',
        content: 'file-read: {"path":"foo.ts"}',
        toolName: 'file-read',
        toolArgs: { path: 'foo.ts' },
      })
      store.addMessage(newResult.sessionId, {
        role: 'tool-result',
        content: JSON.stringify({ text: 'console.log(1)' }),
        toolName: 'file-read',
      })
      store.addMessage(newResult.sessionId, {
        role: 'assistant',
        content: 'Here is the content.',
      })

      const loadResult = (await handlers.get('session/load')!({
        id: newResult.sessionId,
      })) as {
        messages: Array<{
          role: string
          content: string
          toolCalls?: Array<{ toolName: string; input?: unknown; output?: unknown }>
        }>
      }

      expect(loadResult.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
      const firstAssistant = loadResult.messages[1]
      expect(firstAssistant.content).toBe('Reading the file now')
      expect(firstAssistant.toolCalls).toBeDefined()
      expect(firstAssistant.toolCalls).toHaveLength(1)
      expect(firstAssistant.toolCalls![0]).toMatchObject({
        toolName: 'file-read',
        input: { path: 'foo.ts' },
        output: { text: 'console.log(1)' },
      })

      const secondAssistant = loadResult.messages[2]
      expect(secondAssistant.content).toBe('Here is the content.')
      expect(secondAssistant.toolCalls).toBeUndefined()

      ctx.transcriptStore.close()
    })

    test('session/load attaches tool calls to synthetic assistant when no preceding text', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      const store = ctx.transcriptStore
      store.addMessage(newResult.sessionId, { role: 'user', content: 'Run a command' })
      // Assistant with only tool calls (no preceding text row).
      store.addMessage(newResult.sessionId, {
        role: 'tool-call',
        content: 'bash: {"command":"ls"}',
        toolName: 'bash',
        toolArgs: { command: 'ls' },
      })
      store.addMessage(newResult.sessionId, {
        role: 'tool-result',
        content: JSON.stringify({ stdout: 'foo.ts\n' }),
        toolName: 'bash',
      })
      store.addMessage(newResult.sessionId, {
        role: 'assistant',
        content: 'Done',
      })

      const loadResult = (await handlers.get('session/load')!({
        id: newResult.sessionId,
      })) as {
        messages: Array<{
          role: string
          content: string
          toolCalls?: Array<{ toolName: string; input?: unknown; output?: unknown }>
        }>
      }

      expect(loadResult.messages).toHaveLength(3)
      expect(loadResult.messages[1]).toMatchObject({
        role: 'assistant',
        content: '',
      })
      expect(loadResult.messages[1].toolCalls).toHaveLength(1)
      expect(loadResult.messages[1].toolCalls![0]).toMatchObject({
        toolName: 'bash',
        input: { command: 'ls' },
        output: { stdout: 'foo.ts\n' },
      })
      expect(loadResult.messages[2]).toMatchObject({
        role: 'assistant',
        content: 'Done',
      })

      ctx.transcriptStore.close()
    })

    test('agent/run validates images and persists image metadata only', async () => {
      const tempDir = join(tmpdir(), `ouroboros-jsonrpc-images-${crypto.randomUUID()}`)
      mkdirSync(tempDir, { recursive: true })
      const imagePath = join(tempDir, 'screen.png')
      writeFileSync(imagePath, new Uint8Array([137, 80, 78, 71]))

      const ctx = createTestContext({ configDir: tempDir })
      const handlers = createHandlers(ctx)

      try {
        const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
        await handlers.get('agent/run')!({
          message: 'What changed here?',
          images: [
            {
              path: imagePath,
              name: 'screen.png',
              mediaType: 'image/png',
              sizeBytes: 4,
            },
          ],
        })

        const sessionResult = ctx.transcriptStore.getSession(newResult.sessionId)
        expect(sessionResult.ok).toBe(true)
        if (!sessionResult.ok) return

        const userMessage = sessionResult.value.messages[0]
        expect(userMessage.content).toBe('What changed here?')
        expect(typeof userMessage.toolArgs).toBe('string')
        expect(userMessage.toolArgs).toContain('screen.png')
        expect(userMessage.toolArgs).not.toContain('previewDataUrl')
        expect(userMessage.toolArgs).not.toContain('137,80,78,71')

        const loaded = (await handlers.get('session/load')!({ id: newResult.sessionId })) as {
          messages: Array<{ imageAttachments?: unknown }>
        }
        expect(loaded.messages[0].imageAttachments).toEqual([
          {
            path: imagePath,
            name: 'screen.png',
            mediaType: 'image/png',
            sizeBytes: 4,
          },
        ])
      } finally {
        ctx.transcriptStore.close()
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('agent/run rejects invalid image attachments', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      await expect(
        handlers.get('agent/run')!({
          message: 'Use this image',
          images: [
            {
              path: '/tmp/not-supported.gif',
              name: 'not-supported.gif',
              mediaType: 'image/gif',
              sizeBytes: 10,
            },
          ],
        }),
      ).rejects.toThrow('mediaType must be image/jpeg, image/png, or image/webp')

      ctx.transcriptStore.close()
    })

    test('step-limit summary persists without internal limit instruction', async () => {
      const registry = new ToolRegistry()
      registry.register(makeTool('bash', () => ({ output: 'looping' })))
      const model = createMockModel([
        [
          { type: 'tool-input-start', id: 'call_1', toolName: 'bash' },
          { type: 'tool-input-end', id: 'call_1' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"input":"loop"}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
        [
          { type: 'text-start', id: 'summary' },
          { type: 'text-delta', id: 'summary', delta: 'Handoff summary.' },
          { type: 'text-end', id: 'summary' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          },
        ],
      ])
      const ctx = createTestContext({
        model,
        registry,
        agentOptions: { maxSteps: 1 },
      })
      const handlers = createHandlers(ctx)

      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }
      await handlers.get('agent/run')!({ message: 'Persist this limited exchange' })

      const sessionResult = ctx.transcriptStore.getSession(newResult.sessionId)
      expect(sessionResult.ok).toBe(true)
      if (!sessionResult.ok) return

      expect(sessionResult.value.messages.map((message) => message.role)).toEqual([
        'user',
        'tool-call',
        'tool-result',
        'assistant',
      ])
      expect(
        sessionResult.value.messages.some((message) =>
          message.content.includes('autonomous step limit'),
        ),
      ).toBe(false)
      expect(sessionResult.value.messages.at(-1)?.content).toBe('Handoff summary.')

      ctx.transcriptStore.close()
    })

    test('session/delete removes a session', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      // Create a session
      const newResult = (await handlers.get('session/new')!({})) as { sessionId: string }

      // Delete it
      const deleteResult = (await handlers.get('session/delete')!({
        id: newResult.sessionId,
      })) as { deleted: boolean }
      expect(deleteResult.deleted).toBe(true)

      // Load should fail
      try {
        await handlers.get('session/load')!({ id: newResult.sessionId })
        expect(true).toBe(false) // Should not reach here
      } catch (e) {
        expect((e as Error).message).toContain('not found')
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Skills operations
  // -------------------------------------------------------------------
  describe('skills operations', () => {
    test('skills/list returns skill array', async () => {
      const ctx = createTestContext()
      const skillDir = join(ctx.configDir, 'skills', 'generated', 'test-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A generated test skill
---

# Test Skill
`,
      )
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('skills/list')!({})) as {
        skills: Array<{ name: string; version: string; enabled: boolean }>
      }
      expect(result.skills).toBeInstanceOf(Array)
      expect(result.skills).toContainEqual(
        expect.objectContaining({ name: 'test-skill', version: '1.0', enabled: false }),
      )

      ctx.transcriptStore.close()
    })

    test('skills/list discovers built-in skills via OUROBOROS_BUILTIN_SKILLS_DIR', async () => {
      const builtinRoot = join(tmpdir(), `ouroboros-builtin-${crypto.randomUUID()}`)
      const skillDir = join(builtinRoot, 'meta-thinking')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: meta-thinking
description: Bundled meta-thinking skill
---

# Meta thinking body
`,
      )

      const previousEnv = process.env.OUROBOROS_BUILTIN_SKILLS_DIR
      process.env.OUROBOROS_BUILTIN_SKILLS_DIR = builtinRoot

      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        const result = (await handlers.get('skills/list')!({})) as {
          skills: Array<{ name: string; version: string; enabled: boolean }>
        }
        expect(result.skills).toContainEqual(
          expect.objectContaining({
            name: 'meta-thinking',
            version: '1.0',
            enabled: true,
          }),
        )
      } finally {
        if (previousEnv === undefined) {
          delete process.env.OUROBOROS_BUILTIN_SKILLS_DIR
        } else {
          process.env.OUROBOROS_BUILTIN_SKILLS_DIR = previousEnv
        }
        ctx.transcriptStore.close()
        rmSync(builtinRoot, { recursive: true, force: true })
        _resetSkills()
      }
    })
  })

  // -------------------------------------------------------------------
  // Test: Evolution operations (stubs)
  // -------------------------------------------------------------------
  describe('evolution operations', () => {
    test('evolution/list returns persisted entries', async () => {
      const ctx = createTestContext()
      writeFileSync(
        join(ctx.configDir, 'evolution.log.json'),
        JSON.stringify(
          [
            {
              id: 'entry-1',
              timestamp: '2025-04-17T00:00:00.000Z',
              type: 'context-flushed',
              summary: 'Flushed context',
              details: { sessionId: 'session-1' },
              motivation: 'Preserve state',
            },
          ],
          null,
          2,
        ),
        'utf-8',
      )
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('evolution/list')!({})) as {
        entries: Array<{ id: string; timestamp: string; type: string; description: string }>
      }
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]).toMatchObject({
        type: 'context-flushed',
        description: 'Flushed context',
      })

      ctx.transcriptStore.close()
    })

    test('evolution/stats returns computed metrics', async () => {
      const ctx = createTestContext()
      writeFileSync(
        join(ctx.configDir, 'evolution.log.json'),
        JSON.stringify(
          [
            {
              id: 'entry-2',
              timestamp: '2025-04-17T00:00:00.000Z',
              type: 'history-compacted',
              summary: 'Compacted session',
              details: { sessionId: 'session-1', droppedMessageCount: 6, retainedMessageCount: 2 },
              motivation: 'Keep prompt bounded',
            },
            {
              id: 'entry-1',
              timestamp: '2025-04-16T00:00:00.000Z',
              type: 'length-recovery-succeeded',
              summary: 'Recovered',
              details: { sessionId: 'session-1', repeatedWorkDetected: false },
              motivation: 'Resume after compacting',
            },
          ],
          null,
          2,
        ),
        'utf-8',
      )
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('evolution/stats')!({})) as {
        stats: Record<string, unknown>
      }
      expect(result.stats.totalEntries).toBe(2)
      expect(result.stats.successfulResumesAfterCompaction).toBe(1)
      expect(result.stats.compactionsPerSession).toEqual({ 'session-1': 1 })
      expect(result.stats.sessionsAnalyzed).toBe(1)
      expect(result.stats.successRate).toBe(1)

      ctx.transcriptStore.close()
    })

    test('evolution/stats falls back to reflection activity when session ids are absent', async () => {
      const ctx = createTestContext()
      writeFileSync(
        join(ctx.configDir, 'evolution.log.json'),
        JSON.stringify(
          [
            {
              id: 'entry-2',
              timestamp: '2025-04-17T00:00:00.000Z',
              type: 'skill-promoted',
              summary: 'Promoted generated skill',
              details: { skillName: 'test-skill' },
              motivation: 'Promoted after passing tests',
            },
            {
              id: 'entry-1',
              timestamp: '2025-04-16T00:00:00.000Z',
              type: 'memory-updated',
              summary: 'Reflected on task',
              details: {},
              motivation: 'Novel pattern identified',
            },
          ],
          null,
          2,
        ),
        'utf-8',
      )
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('evolution/stats')!({})) as {
        stats: Record<string, unknown>
      }
      expect(result.stats.sessionsAnalyzed).toBe(2)
      expect(result.stats.successRate).toBe(1)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Approval operations (stubs)
  // -------------------------------------------------------------------
  describe('approval operations', () => {
    test('approval/list returns empty array', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('approval/list')!({})) as {
        approvals: unknown[]
      }
      expect(result.approvals).toEqual([])

      ctx.transcriptStore.close()
    })

    test('approval/list returns pending permission lease details', async () => {
      const ctx = createTestContext()
      ctx.listApprovals = () => [
        {
          id: 'lease-approval-1',
          type: 'permission-lease',
          description: 'Approve permission lease for subagent run run-1',
          createdAt: '2026-04-22T00:00:00.000Z',
          risk: 'high',
          lease: {
            leaseId: 'lease-1',
            agentRunId: 'run-1',
            requestedTools: ['file-edit', 'bash'],
            requestedPaths: ['packages/cli/**'],
            requestedBashCommands: ['bun test packages/cli/tests/permission-lease.test.ts'],
            expiresAt: '2026-04-22T01:00:00.000Z',
            riskSummary: 'Needs write and exact test command access.',
            risk: 'high',
            createdAt: '2026-04-22T00:00:00.000Z',
          },
        },
      ]
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('approval/list')!({})) as {
        approvals: Array<{ lease?: { requestedTools: string[]; riskSummary: string } }>
      }

      expect(result.approvals[0]?.lease?.requestedTools).toEqual(['file-edit', 'bash'])
      expect(result.approvals[0]?.lease?.riskSummary).toBe(
        'Needs write and exact test command access.',
      )

      ctx.transcriptStore.close()
    })

    test('approval/respond delegates approved and denied lease decisions', async () => {
      const ctx = createTestContext()
      const decisions: Array<{ id: string; approved: boolean; reason?: string }> = []
      ctx.respondToApproval = (id, approved, reason) => {
        decisions.push({ id, approved, reason })
        return {
          status: approved ? 'approved' : 'denied',
          message: reason,
          lease: {
            leaseId: 'lease-1',
            agentRunId: 'run-1',
            requestedTools: ['file-edit'],
            requestedPaths: ['packages/cli/**'],
            requestedBashCommands: [],
            riskSummary: 'Write one scoped file.',
            risk: 'medium',
            createdAt: '2026-04-22T00:00:00.000Z',
            status: approved ? 'active' : 'denied',
            ...(approved ? { approvedAt: '2026-04-22T00:01:00.000Z' } : { denialReason: reason }),
          },
        }
      }
      const handlers = createHandlers(ctx)

      const approved = await handlers.get('approval/respond')!({
        id: 'lease-approval-1',
        approved: true,
      })
      const denied = await handlers.get('approval/respond')!({
        id: 'lease-approval-2',
        approved: false,
        reason: 'Too broad.',
      })

      expect(approved).toMatchObject({ status: 'approved', lease: { status: 'active' } })
      expect(denied).toMatchObject({
        status: 'denied',
        lease: { status: 'denied', denialReason: 'Too broad.' },
      })
      expect(decisions).toEqual([
        { id: 'lease-approval-1', approved: true, reason: undefined },
        { id: 'lease-approval-2', approved: false, reason: 'Too broad.' },
      ])

      ctx.transcriptStore.close()
    })
  })

  describe('ask-user operations', () => {
    afterEach(() => {
      setAskUserPromptHandler(null)
    })

    test('ask-user JSON-RPC prompt handler emits request and waits for response', async () => {
      let resolveResponse: ((response: string) => void) | null = null

      setAskUserPromptHandler(async (args) => {
        writeMessage(
          makeNotification('askUser/request', {
            id: 'ask-user-test-1',
            question: args.question,
            options: args.options ?? [],
            createdAt: '2026-04-19T00:00:00.000Z',
          }),
        )

        return new Promise((resolve) => {
          resolveResponse = (response) => resolve(ok({ response }))
        })
      })

      const output = await captureStdout(async () => {
        const pending = executeAskUser({
          question: 'Choose a direction',
          options: ['North', 'South'],
        })
        await Promise.resolve()
        resolveResponse?.('2')
        const result = await pending
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.value.response).toBe('South')
        }
      })

      expect(parseNdjson(output)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'askUser/request',
          params: {
            id: 'ask-user-test-1',
            question: 'Choose a direction',
            options: ['North', 'South'],
            createdAt: '2026-04-19T00:00:00.000Z',
          },
        },
      ])
    })

    test('ask-user custom text response is preserved when options are provided', async () => {
      setAskUserPromptHandler(async () => ok({ response: 'Something else' }))

      const result = await executeAskUser({
        question: 'Choose a direction',
        options: ['North', 'South'],
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.response).toBe('Something else')
      }
    })

    test('askUser/respond resolves pending prompt responses', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)
      const responses: Array<{ id: string; response: string }> = []
      ctx.respondToAskUser = (id, value) => {
        responses.push({ id, response: value })
      }

      const result = (await handlers.get('askUser/respond')!({
        id: 'ask-user-1',
        response: 'Use the custom answer',
      })) as { ok: boolean }

      expect(result).toEqual({ ok: true })
      expect(responses[0]).toEqual({ id: 'ask-user-1', response: 'Use the custom answer' })

      ctx.transcriptStore.close()
    })

    test('askUser/respond rejects missing and unknown prompts', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      await expect(handlers.get('askUser/respond')!({ response: 'Answer' })).rejects.toThrow(
        'params.id is required',
      )
      await expect(handlers.get('askUser/respond')!({ id: 'ask-user-1' })).rejects.toThrow(
        'params.response is required',
      )

      ctx.respondToAskUser = (id) => {
        throw new HandlerError(
          JSON_RPC_ERRORS.INVALID_PARAMS.code,
          `Unknown ask-user prompt: ${id}`,
        )
      }

      await expect(
        handlers.get('askUser/respond')!({ id: 'missing-prompt', response: 'Answer' }),
      ).rejects.toThrow('Unknown ask-user prompt: missing-prompt')

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Event bridge
  // -------------------------------------------------------------------
  describe('event-to-notification bridge', () => {
    test('text event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({ type: 'text', text: 'Hello world' })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as { method: string; params: { text: string } }
      expect(notif.method).toBe('agent/text')
      expect(notif.params.text).toBe('Hello world')
    })

    test('runtime RSI event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'rsi-context-flushed',
          sessionId: 'session-1',
          reason: 'flush',
          unseenMessageCount: 3,
          metrics: {
            usageRatio: 0.82,
            estimatedTotalTokens: 820,
            contextWindowTokens: 1000,
            threshold: 'flush',
          },
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { eventType: string; payload: { sessionId: string } }
      }
      expect(notif.method).toBe('rsi/runtime')
      expect(notif.params.eventType).toBe('rsi-context-flushed')
      expect(notif.params.payload.sessionId).toBe('session-1')
    })

    test('tool-call-start event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'tool-call-start',
          toolCallId: 'tc1',
          toolName: 'bash',
          input: { command: 'ls' },
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { toolCallId: string; toolName: string; input: unknown }
      }
      expect(notif.method).toBe('agent/toolCallStart')
      expect(notif.params.toolCallId).toBe('tc1')
      expect(notif.params.toolName).toBe('bash')
    })

    test('tool-call-end event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'tool-call-end',
          toolCallId: 'tc1',
          toolName: 'bash',
          result: 'success',
          isError: false,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { toolCallId: string; isError: boolean }
      }
      expect(notif.method).toBe('agent/toolCallEnd')
      expect(notif.params.toolCallId).toBe('tc1')
      expect(notif.params.isError).toBe(false)
    })

    test('turn-complete event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'turn-complete',
          text: 'Done!',
          iterations: 2,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { text: string; iterations: number }
      }
      expect(notif.method).toBe('agent/turnComplete')
      expect(notif.params.text).toBe('Done!')
      expect(notif.params.iterations).toBe(2)
    })

    test('error event is bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'error',
          error: new Error('Something broke'),
          recoverable: true,
        })
      })

      const messages = parseNdjson(output)
      expect(messages).toHaveLength(1)

      const notif = messages[0] as {
        method: string
        params: { message: string; recoverable: boolean }
      }
      expect(notif.method).toBe('agent/error')
      expect(notif.params.message).toBe('Something broke')
      expect(notif.params.recoverable).toBe(true)
    })

    test('subagent lifecycle events are bridged correctly', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent({
          type: 'subagent-started',
          runId: 'run-1',
          parentSessionId: 'parent-1',
          childSessionId: 'child-1',
          agentId: 'explore',
          task: 'Inspect files.',
          status: 'running',
          startedAt: '2026-04-22T00:00:00.000Z',
        })
        bridgeAgentEvent({
          type: 'subagent-completed',
          runId: 'run-1',
          parentSessionId: 'parent-1',
          childSessionId: 'child-1',
          agentId: 'explore',
          task: 'Inspect files.',
          status: 'completed',
          startedAt: '2026-04-22T00:00:00.000Z',
          completedAt: '2026-04-22T00:00:01.000Z',
          result: { summary: 'Done.' },
        })
        bridgeAgentEvent({
          type: 'subagent-failed',
          runId: 'run-2',
          parentSessionId: 'parent-1',
          agentId: 'explore',
          task: 'Inspect failure.',
          status: 'failed',
          startedAt: '2026-04-22T00:00:00.000Z',
          completedAt: '2026-04-22T00:00:01.000Z',
          error: { message: 'Child failed.' },
        })
      })

      const messages = parseNdjson(output) as Array<{
        method: string
        params: Record<string, unknown>
      }>

      expect(messages.map((message) => message.method)).toEqual([
        'agent/subagentStarted',
        'agent/subagentCompleted',
        'agent/subagentFailed',
      ])
      expect(messages[0]?.params).toMatchObject({
        runId: 'run-1',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        agentId: 'explore',
        task: 'Inspect files.',
        status: 'running',
      })
      expect(messages[1]?.params).toMatchObject({
        runId: 'run-1',
        status: 'completed',
        result: { summary: 'Done.' },
      })
      expect(messages[2]?.params).toMatchObject({
        runId: 'run-2',
        status: 'failed',
        error: { message: 'Child failed.' },
      })
    })
  })

  // -------------------------------------------------------------------
  // Test: Transport writeMessage
  // -------------------------------------------------------------------
  describe('transport', () => {
    test('writeMessage writes NDJSON to stdout', async () => {
      const output = await captureStdout(async () => {
        writeMessage(makeResponse(42, { result: 'ok' }))
      })

      expect(output.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(output.trim())
      expect(parsed.jsonrpc).toBe('2.0')
      expect(parsed.id).toBe(42)
      expect(parsed.result).toEqual({ result: 'ok' })
    })
  })

  // -------------------------------------------------------------------
  // Test: Handler registration coverage
  // -------------------------------------------------------------------
  describe('handler registration', () => {
    test('all required methods are registered', () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const expectedMethods = [
        'agent/run',
        'agent/cancel',
        'session/list',
        'session/load',
        'session/new',
        'session/delete',
        'config/get',
        'config/set',
        'config/setApiKey',
        'config/testConnection',
        'auth/getStatus',
        'auth/startLogin',
        'auth/pollLogin',
        'auth/cancelLogin',
        'auth/logout',
        'skills/list',
        'skills/get',
        'rsi/dream',
        'rsi/status',
        'evolution/list',
        'evolution/stats',
        'approval/list',
        'approval/respond',
        'workspace/set',
        'workspace/clear',
      ]

      for (const method of expectedMethods) {
        expect(handlers.has(method)).toBe(true)
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: agent/cancel with no active run
  // -------------------------------------------------------------------
  describe('agent/cancel', () => {
    test('returns not-in-progress when no run is active', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const result = (await handlers.get('agent/cancel')!({})) as {
        cancelled: boolean
        message?: string
      }
      expect(result.cancelled).toBe(false)

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: Invalid params handling
  // -------------------------------------------------------------------
  describe('invalid params handling', () => {
    test('agent/run rejects missing message', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('agent/run')!({})
        expect(true).toBe(false) // Should not reach here
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })

    test('session/load rejects missing id', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('session/load')!({})
        expect(true).toBe(false)
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })

    test('session/delete rejects missing id', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      try {
        await handlers.get('session/delete')!({})
        expect(true).toBe(false)
      } catch (e) {
        expect((e as { code: number }).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }

      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // Test: artifacts/* handlers and artifact-created event bridge
  // -------------------------------------------------------------------
  describe('artifacts handlers', () => {
    test('bridges artifact-created events into agent/artifactCreated notifications', async () => {
      const output = await captureStdout(async () => {
        bridgeAgentEvent(
          {
            type: 'artifact-created',
            artifactId: 'abc',
            version: 1,
            sessionId: 'session-art',
            title: 'Sine',
            description: 'wave',
            path: '/tmp/sample.html',
            bytes: 42,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          'session-art',
        )
      })

      expect(parseNdjson(output)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'agent/artifactCreated',
          params: {
            sessionId: 'session-art',
            artifactId: 'abc',
            version: 1,
            title: 'Sine',
            description: 'wave',
            path: '/tmp/sample.html',
            bytes: 42,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ])
    })

    test('artifacts/list returns empty array for a fresh session', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)

      const handler = handlers.get('artifacts/list')!
      expect(handler).toBeDefined()
      const result = (await handler({ sessionId: 'no-such-session' })) as {
        artifacts: unknown[]
      }
      expect(Array.isArray(result.artifacts)).toBe(true)
      expect(result.artifacts).toHaveLength(0)
      ctx.transcriptStore.close()
    })

    test('artifacts/list rejects missing sessionId with INVALID_PARAMS', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)
      const handler = handlers.get('artifacts/list')!
      try {
        await handler({})
        expect.unreachable('expected HandlerError')
      } catch (e) {
        expect(e).toBeInstanceOf(HandlerError)
        expect((e as HandlerError).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS.code)
      }
      ctx.transcriptStore.close()
    })

    test('artifacts/read errors on unknown artifactId with INTERNAL_ERROR', async () => {
      const ctx = createTestContext()
      const handlers = createHandlers(ctx)
      const handler = handlers.get('artifacts/read')!
      try {
        await handler({ sessionId: 'sess-x', artifactId: 'nope' })
        expect.unreachable('expected HandlerError')
      } catch (e) {
        expect(e).toBeInstanceOf(HandlerError)
      }
      ctx.transcriptStore.close()
    })
  })

  // -------------------------------------------------------------------
  // Test: writeMessage outputs valid NDJSON
  // -------------------------------------------------------------------
  describe('NDJSON output format', () => {
    test('multiple messages produce valid NDJSON', async () => {
      const output = await captureStdout(async () => {
        writeMessage(makeResponse(1, 'first'))
        writeMessage(makeNotification('agent/text', { text: 'delta' }))
        writeMessage(makeResponse(2, 'second'))
      })

      const lines = output.split('\n').filter((l) => l.length > 0)
      expect(lines).toHaveLength(3)

      // Each line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    })
  })
})
