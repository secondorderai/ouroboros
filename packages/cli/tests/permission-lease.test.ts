import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { configSchema } from '@src/config'
import { TranscriptStore } from '@src/memory/transcripts'
import {
  approvePermissionLease,
  createPermissionLease,
  createPermissionLeaseWithApproval,
  setPermissionLeaseApprovalHandler,
  type PermissionLease,
} from '@src/permission-lease'
import { ToolRegistry } from '@src/tools/registry'
import type { ToolDefinition, ToolExecutionContext } from '@src/tools/types'
import { err, ok } from '@src/types'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-permission-lease-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeContext(
  registry: ToolRegistry,
  lease: PermissionLease,
  basePath: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    model: {} as ToolExecutionContext['model'],
    toolRegistry: registry,
    config: configSchema.parse({}),
    basePath,
    agentId: 'writer',
    permissionLease: lease,
    ...overrides,
  }
}

function makeFileEditTool(onExecute: () => void): ToolDefinition {
  return {
    name: 'file-edit',
    description: 'Edit a file',
    schema: z.object({
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
    }),
    execute: async (args) => {
      onExecute()
      return ok({ path: args.path, content: args.newString })
    },
  }
}

function makeBashTool(onExecute: () => void): ToolDefinition {
  return {
    name: 'bash',
    description: 'Run shell command',
    schema: z.object({
      command: z.string(),
    }),
    execute: async () => {
      onExecute()
      return ok({ stdout: '', stderr: '', exitCode: 0 })
    },
  }
}

describe('Permission lease core', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    setPermissionLeaseApprovalHandler(null)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('allowed path edit passes before tool execution', async () => {
    let executed = false
    const registry = new ToolRegistry()
    registry.register(makeFileEditTool(() => (executed = true)))
    mkdirSync(join(tempDir, 'packages/cli/tests'), { recursive: true })
    writeFileSync(join(tempDir, 'packages/cli/tests/lease-target.ts'), 'old')

    const lease = createPermissionLease({
      id: 'lease-allowed-path',
      agentRunId: 'run-allowed-path',
      allowedTools: ['file-edit'],
      allowedPaths: ['packages/cli/tests/**'],
    })

    const result = await registry.executeTool(
      'file-edit',
      {
        path: 'packages/cli/tests/lease-target.ts',
        oldString: 'old',
        newString: 'new',
      },
      makeContext(registry, lease, tempDir),
    )

    expect(result.ok).toBe(true)
    expect(executed).toBe(true)
    expect(lease.toolCallCount).toBe(1)
  })

  test('denied path edit fails before tool execution', async () => {
    let executed = false
    const registry = new ToolRegistry()
    registry.register(makeFileEditTool(() => (executed = true)))

    const lease = createPermissionLease({
      id: 'lease-denied-path',
      agentRunId: 'run-denied-path',
      allowedTools: ['file-edit'],
      allowedPaths: ['packages/cli/tests/**'],
    })

    const result = await registry.executeTool(
      'file-edit',
      {
        path: 'packages/desktop/src/App.tsx',
        oldString: 'old',
        newString: 'new',
      },
      makeContext(registry, lease, tempDir),
    )

    expect(result.ok).toBe(false)
    expect(executed).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain(
        'Permission lease "lease-denied-path" denied file-edit',
      )
      expect(result.error.message).toContain('outside allowed paths')
    }
    expect(lease.deniedCallCount).toBe(1)
  })

  test('bash command outside allowedBash fails before execution', async () => {
    let executed = false
    const registry = new ToolRegistry()
    registry.register(makeBashTool(() => (executed = true)))

    const lease = createPermissionLease({
      id: 'lease-denied-bash',
      agentRunId: 'run-denied-bash',
      allowedTools: ['bash'],
      allowedBash: ['bun test packages/cli/tests/tools/registry.test.ts'],
    })

    const result = await registry.executeTool(
      'bash',
      { command: 'rm -rf /tmp/example' },
      makeContext(registry, lease, tempDir),
    )

    expect(result.ok).toBe(false)
    expect(executed).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('outside allowed commands')
      expect(result.error.message).toContain('bun test packages/cli/tests/tools/registry.test.ts')
    }
  })

  test('approval response grants an approval-required lease', async () => {
    setPermissionLeaseApprovalHandler(async (request) => {
      expect(request.details.requestedTools).toEqual(['file-edit'])
      expect(request.details.requestedPaths).toEqual(['packages/cli/tests/**'])
      expect(request.details.requestedBashCommands).toEqual([])
      expect(request.details.expiresAt).toBe('2026-04-23T00:00:00.000Z')
      expect(request.details.riskSummary).toBe('Edit one test fixture')
      return ok(approvePermissionLease(request.lease, '2026-04-22T00:00:00.000Z'))
    })

    const result = await createPermissionLeaseWithApproval({
      id: 'lease-approve',
      agentRunId: 'run-approve',
      allowedTools: ['file-edit'],
      allowedPaths: ['packages/cli/tests/**'],
      expiresAt: '2026-04-23T00:00:00.000Z',
      approvalRequired: true,
      riskSummary: 'Edit one test fixture',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.approvedAt).toBe('2026-04-22T00:00:00.000Z')
  })

  test('denied approval prevents lease from becoming active', async () => {
    setPermissionLeaseApprovalHandler(async () => err(new Error('Insufficient path scope.')))

    const result = await createPermissionLeaseWithApproval({
      id: 'lease-deny',
      agentRunId: 'run-deny',
      allowedTools: ['bash'],
      allowedBash: ['bun test packages/cli/tests/permission-lease.test.ts'],
      approvalRequired: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('Insufficient path scope.')
  })

  test('expired lease denies restricted tool call', async () => {
    let executed = false
    const events: Array<{ type: string; status?: string; reason?: string }> = []
    const registry = new ToolRegistry()
    registry.register(makeFileEditTool(() => (executed = true)))

    const lease = createPermissionLease({
      id: 'lease-expired',
      agentRunId: 'run-expired',
      allowedTools: ['file-edit'],
      allowedPaths: ['packages/cli/tests/**'],
      expiresAt: '2020-01-01T00:00:00.000Z',
    })

    const result = await registry.executeTool(
      'file-edit',
      {
        path: 'packages/cli/tests/lease-target.ts',
        oldString: 'old',
        newString: 'new',
      },
      makeContext(registry, lease, tempDir, {
        emitEvent: (event) => events.push(event as (typeof events)[number]),
      }),
    )

    expect(result.ok).toBe(false)
    expect(executed).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('lease expired at 2020-01-01T00:00:00.000Z')
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission-lease-check',
        status: 'denied',
        reason: expect.stringContaining('lease expired'),
      }),
    )
  })

  test('max tool calls deny further restricted actions', async () => {
    let executions = 0
    const registry = new ToolRegistry()
    registry.register(makeFileEditTool(() => (executions += 1)))

    const lease = createPermissionLease({
      id: 'lease-max-calls',
      agentRunId: 'run-max-calls',
      allowedTools: ['file-edit'],
      allowedPaths: ['packages/cli/tests/**'],
      maxToolCalls: 1,
    })
    const context = makeContext(registry, lease, tempDir)

    const first = await registry.executeTool(
      'file-edit',
      { path: 'packages/cli/tests/a.ts', oldString: 'a', newString: 'b' },
      context,
    )
    const second = await registry.executeTool(
      'file-edit',
      { path: 'packages/cli/tests/b.ts', oldString: 'a', newString: 'b' },
      context,
    )

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(executions).toBe(1)
    if (!second.ok) {
      expect(second.error.message).toContain('max tool calls exceeded')
    }
  })

  test('lease records persist and remain traceable to a subagent run', async () => {
    const store = new TranscriptStore(join(tempDir, 'leases.db'))
    try {
      const parent = store.createSession(tempDir)
      const child = store.createSession(tempDir)
      expect(parent.ok).toBe(true)
      expect(child.ok).toBe(true)
      if (!parent.ok || !child.ok) return

      const run = store.addSubagentRun({
        id: 'run-persisted',
        parentSessionId: parent.value,
        childSessionId: child.value,
        agentId: 'writer',
        task: 'Edit allowed files.',
        status: 'completed',
      })
      expect(run.ok).toBe(true)

      const leaseResult = store.addPermissionLease({
        id: 'lease-persisted',
        agentRunId: 'run-persisted',
        allowedTools: ['file-edit'],
        allowedPaths: ['packages/cli/tests/**'],
        allowedBash: ['bun test packages/cli/tests/permission-lease.test.ts'],
        maxToolCalls: 3,
        approvalRequired: true,
        approvedAt: '2026-01-01T00:00:00.000Z',
      })
      expect(leaseResult.ok).toBe(true)

      const registry = new ToolRegistry()
      registry.register(makeFileEditTool(() => undefined))
      const lease = createPermissionLease({
        id: 'lease-persisted',
        agentRunId: 'run-persisted',
        allowedTools: ['file-edit'],
        allowedPaths: ['packages/cli/tests/**'],
        maxToolCalls: 3,
        approvalRequired: true,
        approvedAt: '2026-01-01T00:00:00.000Z',
      })
      const call = await registry.executeTool(
        'file-edit',
        { path: 'packages/cli/tests/a.ts', oldString: 'a', newString: 'b' },
        makeContext(registry, lease, tempDir, { transcriptStore: store }),
      )
      expect(call.ok).toBe(true)

      const leases = store.getPermissionLeasesForAgentRun('run-persisted')
      expect(leases.ok).toBe(true)
      if (!leases.ok) return
      expect(leases.value).toEqual([
        expect.objectContaining({
          id: 'lease-persisted',
          agentRunId: 'run-persisted',
          allowedTools: ['file-edit'],
          allowedPaths: ['packages/cli/tests/**'],
          allowedBash: ['bun test packages/cli/tests/permission-lease.test.ts'],
          maxToolCalls: 3,
          approvalRequired: true,
          approvedAt: '2026-01-01T00:00:00.000Z',
          toolCallCount: 1,
        }),
      ])
    } finally {
      store.close()
    }
  })
})
