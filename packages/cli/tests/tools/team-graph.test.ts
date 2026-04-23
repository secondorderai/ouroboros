import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { configSchema } from '@src/config'
import { TranscriptStore } from '@src/memory/transcripts'
import { TaskGraphStore } from '@src/team/task-graph'
import { ToolRegistry } from '@src/tools/registry'
import * as teamGraphTool from '@src/tools/team-graph'
import { cleanupTempDir, makeTempDir } from '../helpers/test-utils'
import { createMockModel } from '../helpers/mock-llm'

describe('team_graph tool', () => {
  let tempDir: string
  let registry: ToolRegistry
  let transcriptStore: TranscriptStore
  let taskGraphStore: TaskGraphStore
  const emitted: unknown[] = []

  beforeEach(() => {
    tempDir = makeTempDir('ouroboros-team-graph-tool')
    registry = new ToolRegistry()
    registry.register(teamGraphTool)
    transcriptStore = new TranscriptStore(join(tempDir, 'transcripts.db'))
    taskGraphStore = new TaskGraphStore(transcriptStore)
    emitted.length = 0
  })

  afterEach(() => {
    transcriptStore.close()
    cleanupTempDir(tempDir)
  })

  function context() {
    return {
      model: createMockModel([]),
      toolRegistry: registry,
      config: configSchema.parse({}),
      transcriptStore,
      taskGraphStore,
      basePath: tempDir,
      agentId: 'default',
      emitEvent: (event: unknown) => emitted.push(event),
    }
  }

  test('creates a persistent graph and emits a desktop open event', async () => {
    const result = await registry.executeTool(
      'team_graph',
      {
        action: 'create',
        name: 'Read-only package inspection',
        tasks: [
          { id: 'inspect-cli', title: 'Inspect CLI package' },
          {
            id: 'inspect-desktop',
            title: 'Inspect desktop package',
            dependencies: ['inspect-cli'],
          },
        ],
      },
      context(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const graph = (result.value as { graph: { id: string; tasks: Array<{ status: string }> } })
      .graph
    expect(graph.tasks.map((task) => task.status)).toEqual(['pending', 'blocked'])
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'team-graph-open',
        graph: expect.objectContaining({ id: graph.id }),
      }),
    )

    const reloadedStore = new TaskGraphStore(transcriptStore)
    const reloaded = reloadedStore.getGraph(graph.id)
    expect(reloaded.ok).toBe(true)
    if (reloaded.ok) {
      expect(reloaded.value.name).toBe('Read-only package inspection')
    }
  })

  test('create-workflow records verdict guidance as a visible workflow event', async () => {
    const result = await registry.executeTool(
      'team_graph',
      {
        action: 'create-workflow',
        template: 'architecture-decision',
        taskContext: 'Choose a subagent orchestration design.',
      },
      context(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const graph = (result.value as { graph: { messages: Array<{ message: string }> } }).graph
    expect(graph.messages.some((message) => message.message.includes('Verdict tasks'))).toBe(true)
  })
})
