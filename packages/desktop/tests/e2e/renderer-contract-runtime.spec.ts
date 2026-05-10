import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LaunchedApp } from './helpers'
import {
  clearClientState,
  clearRpcOverrides,
  completeOnboarding,
  emitNotification,
  emitUpdateDownloaded,
  getInstallUpdateCount,
  launchTestApp,
  resetInstallUpdateCount,
  setRpcOverride,
} from './helpers'

let launched: LaunchedApp | null = null
const modKey = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function openMainApp(): Promise<void> {
  if (!launched) throw new Error('App not launched')
  await launched.page.evaluate(() => {
    localStorage.setItem('ouroboros:onboarding-done', 'true')
  })
  await launched.page.reload()
  await expect(launched.page.getByLabel('Message input')).toBeVisible()
}

async function writeTestImageFiles(prefix: string): Promise<{
  pngPath: string
  jpgPath: string
  webpPath: string
  gifPath: string
}> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  const pngPath = path.join(dir, 'diagram.png')
  const jpgPath = path.join(dir, 'photo.jpg')
  const webpPath = path.join(dir, 'mockup.webp')
  const gifPath = path.join(dir, 'animation.gif')

  await writeFile(
    pngPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await writeFile(webpPath, Buffer.from('RIFF\x0c\x00\x00\x00WEBPVP8 \x00\x00\x00\x00', 'binary'))
  await writeFile(gifPath, Buffer.from('GIF89a', 'binary'))

  return { pngPath, jpgPath, webpPath, gifPath }
}

function mockTeamGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = '2026-04-23T10:00:00.000Z'
  return {
    id: 'renderer-contract-graph',
    name: 'Renderer contract team graph',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    agents: [{ id: 'code-reviewer', status: 'active', activeTaskIds: [], updatedAt: now }],
    tasks: [],
    messages: [],
    ...overrides,
  }
}

test('loaded session shows tool-call chips alongside assistant messages', async ({}, testInfo) => {
  const historicalTimestamp = new Date(Date.now() - 60_000).toISOString()
  launched = await launchTestApp(testInfo, {
    scenario: {
      sessions: [
        {
          id: 'session-with-tools',
          createdAt: historicalTimestamp,
          lastActive: historicalTimestamp,
          title: 'Historical tool-using chat',
          messages: [
            {
              role: 'user',
              content: 'Search for ouroboros repo',
              timestamp: historicalTimestamp,
            },
            {
              role: 'assistant',
              content: 'Found it in the results below.',
              timestamp: historicalTimestamp,
              toolCalls: [
                {
                  id: 'loaded-tool-1',
                  toolName: 'web-search',
                  input: { query: 'ouroboros repo' },
                  output: { results: ['repo-link'] },
                },
              ],
            },
          ],
        },
      ],
    },
  })
  await openMainApp()

  await launched.page.getByRole('button', { name: /Session: Historical tool-using chat/ }).click()

  await expect(launched.page.getByText('Found it in the results below.')).toBeVisible()
  await expect(launched.page.getByRole('button', { name: /Searched web/ })).toBeVisible()
})

test('agent notifications finalize chat output and completed tool calls', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Final answer',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Summarize the repo')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-1',
    toolName: 'web-search',
    input: { q: 'ouroboros repo' },
  })
  await emitNotification(launched.page, 'agent/text', { text: 'Working through the repository...' })
  await emitNotification(launched.page, 'agent/toolCallEnd', {
    toolCallId: 'tool-1',
    toolName: 'web-search',
    result: { ok: true },
    isError: false,
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Final answer',
    iterations: 1,
  })

  await expect(launched.page.getByText('Final answer')).toBeVisible()
  await expect(launched.page.getByText('Searched web')).toBeVisible()
})

test('running subagent notification appears under the active turn', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'team/create', {
    ok: true,
    result: { graph: mockTeamGraph() },
  })
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Final answer',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Delegate repo inspection')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByTestId('titlebar-team-graph-button')).toHaveCount(0)

  await emitNotification(launched.page, 'agent/subagentStarted', {
    runId: 'subagent-running-1',
    agentId: 'code-reviewer',
    task: 'Inspect renderer state changes',
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  const row = launched.page.getByTestId('subagent-activity-row')
  await expect(row).toBeVisible()
  await expect(row).toContainText('code-reviewer')
  await expect(row).toContainText('Inspect renderer state changes')
  await expect(row).toContainText('Running')

  const expandButton = launched.page.getByRole('button', { name: 'code-reviewer subagent running' })
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false')

  const rowGraphButton = row.getByTestId('subagent-team-graph-button')
  await expect(rowGraphButton).toBeVisible()
  await rowGraphButton.click()
  await expect(expandButton).toHaveAttribute('aria-expanded', 'false')
  await expect(launched.page.getByRole('dialog', { name: 'Team graph' })).toBeVisible()

  await launched.page.getByLabel('Close team graph').click()
  await expandButton.click()
  await expect(expandButton).toHaveAttribute('aria-expanded', 'true')

  const titlebarGraphButton = launched.page.getByTestId('titlebar-team-graph-button')
  await expect(titlebarGraphButton).toBeVisible()
  await titlebarGraphButton.click()
  await expect(launched.page.getByRole('dialog', { name: 'Team graph' })).toBeVisible()
})

test('team graph update notification reveals title bar graph control', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await expect(launched.page.getByTestId('titlebar-team-graph-button')).toHaveCount(0)
  await emitNotification(launched.page, 'team/graphUpdated', {
    graph: mockTeamGraph({ id: 'graph-from-update', name: 'Graph from update notification' }),
  })

  const titlebarGraphButton = launched.page.getByTestId('titlebar-team-graph-button')
  await expect(titlebarGraphButton).toBeVisible()
  await titlebarGraphButton.click()
  await expect(launched.page.getByRole('dialog', { name: 'Team graph' })).toBeVisible()
  await expect(launched.page.getByText('Graph from update notification')).toBeVisible()
})

test('completed subagent row shows summary and evidence count after turn completion', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Parent final answer',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Use a subagent')
  await launched.page.getByLabel('Message input').press('Enter')

  const startedAt = new Date(Date.now() - 1200).toISOString()
  await emitNotification(launched.page, 'agent/subagentStarted', {
    runId: 'subagent-complete-1',
    agentId: 'researcher',
    task: 'Find supporting files',
    status: 'running',
    startedAt,
  })
  await emitNotification(launched.page, 'agent/subagentCompleted', {
    runId: 'subagent-complete-1',
    agentId: 'researcher',
    task: 'Find supporting files',
    status: 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    result: {
      summary: 'Renderer store and chat message components need subagent activity state.',
      claims: [
        {
          claim: 'The chat renders agent messages in AgentMessage.',
          confidence: 0.9,
          evidence: [
            { type: 'file', path: 'packages/desktop/src/renderer/components/AgentMessage.tsx' },
            { type: 'file', path: 'packages/desktop/src/renderer/views/ChatView.tsx', line: 270 },
          ],
        },
      ],
      uncertainty: ['Loaded sessions do not yet persist subagent metadata.'],
      suggestedNextSteps: [],
    },
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Parent final answer',
    iterations: 1,
  })

  const row = launched.page.getByTestId('subagent-activity-row')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Completed')
  await expect(row).toContainText('2 evidence')
  await expect(row).toContainText('1 uncertainty')
  await expect(row).toContainText(
    'Renderer store and chat message components need subagent activity state.',
  )
  await expect(row).toContainText('packages/desktop/src/renderer/views/ChatView.tsx:270')
  await expect(launched.page.getByText('Parent final answer')).toBeVisible()
})

test('worker subagent row shows diff summary and review status', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Parent final answer',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Use a worker')
  await launched.page.getByLabel('Message input').press('Enter')

  const startedAt = new Date(Date.now() - 800).toISOString()
  await emitNotification(launched.page, 'agent/subagentStarted', {
    runId: 'worker-diff-1',
    agentId: 'worker',
    task: 'Implement a ticket',
    status: 'running',
    startedAt,
  })
  await emitNotification(launched.page, 'agent/subagentCompleted', {
    runId: 'worker-diff-1',
    agentId: 'worker',
    task: 'Implement a ticket',
    status: 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    result: {
      summary: 'Worker completed the isolated implementation.',
      claims: [],
      workerDiff: {
        taskId: 'ticket-15',
        branchName: 'worker/ticket-15',
        worktreePath: '/tmp/ouroboros-worker-ticket-15',
        changedFiles: ['packages/cli/src/tools/worker-diff-approval.ts'],
        diff: 'diff --git a/file b/file\n+new line\n',
        diffLineCount: 2,
        testResult: {
          command: 'bun test packages/cli/tests/tools/spawn-agent.test.ts',
          exitCode: 0,
          status: 'passed',
        },
        unresolvedRisks: [],
        reviewStatus: 'awaiting-review',
      },
      uncertainty: [],
      suggestedNextSteps: [],
    },
    workerDiff: {
      taskId: 'ticket-15',
      branchName: 'worker/ticket-15',
      worktreePath: '/tmp/ouroboros-worker-ticket-15',
      changedFiles: ['packages/cli/src/tools/worker-diff-approval.ts'],
      diff: 'diff --git a/file b/file\n+new line\n',
      diffLineCount: 2,
      testResult: {
        command: 'bun test packages/cli/tests/tools/spawn-agent.test.ts',
        exitCode: 0,
        status: 'passed',
      },
      unresolvedRisks: [],
      reviewStatus: 'awaiting-review',
    },
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Parent final answer',
    iterations: 1,
  })

  const row = launched.page.getByTestId('subagent-activity-row')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Awaiting review')
  await expect(row).toContainText('Worker diff')
  await expect(row).toContainText('1 files')
  await expect(row).toContainText('packages/cli/src/tools/worker-diff-approval.ts')
  await expect(row).toContainText(
    'Tests: passed: bun test packages/cli/tests/tools/spawn-agent.test.ts',
  )
})

test('subagent row renders pending active and denied lease details', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Parent final answer',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Use a lease-backed subagent')
  await launched.page.getByLabel('Message input').press('Enter')

  const startedAt = new Date(Date.now() - 900).toISOString()
  await emitNotification(launched.page, 'agent/subagentStarted', {
    runId: 'subagent-lease-1',
    agentId: 'tester',
    task: 'Run focused tests',
    status: 'running',
    startedAt,
  })
  await emitNotification(launched.page, 'agent/permissionLeaseUpdated', {
    leaseId: 'lease-pending-1',
    agentRunId: 'subagent-lease-1',
    requestedTools: ['bash', 'file-edit'],
    requestedPaths: ['packages/cli/tests/**'],
    requestedBashCommands: ['bun test packages/cli/tests/permission-lease.test.ts'],
    expiresAt: '2026-04-23T00:00:00.000Z',
    riskSummary: 'Subagent needs scoped test edits and one exact command.',
    risk: 'high',
    createdAt: '2026-04-22T00:00:00.000Z',
    status: 'pending',
  })
  await emitNotification(launched.page, 'agent/permissionLeaseUpdated', {
    leaseId: 'lease-pending-1',
    agentRunId: 'subagent-lease-1',
    requestedTools: ['bash', 'file-edit'],
    requestedPaths: ['packages/cli/tests/**'],
    requestedBashCommands: ['bun test packages/cli/tests/permission-lease.test.ts'],
    expiresAt: '2026-04-23T00:00:00.000Z',
    riskSummary: 'Subagent needs scoped test edits and one exact command.',
    risk: 'high',
    createdAt: '2026-04-22T00:00:00.000Z',
    status: 'active',
    approvedAt: '2026-04-22T00:01:00.000Z',
  })
  await emitNotification(launched.page, 'agent/permissionLeaseUpdated', {
    leaseId: 'lease-denied-1',
    agentRunId: 'subagent-lease-1',
    requestedTools: ['bash'],
    requestedPaths: [],
    requestedBashCommands: ['rm -rf /tmp/ouroboros-denied'],
    riskSummary: 'Destructive cleanup was requested.',
    risk: 'high',
    createdAt: '2026-04-22T00:02:00.000Z',
    status: 'denied',
    denialReason: 'Command is destructive and outside the task.',
  })
  await emitNotification(launched.page, 'agent/subagentCompleted', {
    runId: 'subagent-lease-1',
    agentId: 'tester',
    task: 'Run focused tests',
    status: 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    result: {
      summary: 'Focused tests passed.',
      claims: [],
      uncertainty: [],
      suggestedNextSteps: [],
    },
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Parent final answer',
    iterations: 1,
  })

  const row = launched.page.getByTestId('subagent-activity-row')
  await expect(row).toContainText('Active lease')
  await expect(row).toContainText('bash, file-edit')
  await expect(row).toContainText('packages/cli/tests/**')
  await expect(row).toContainText('bun test packages/cli/tests/permission-lease.test.ts')
  await expect(row).toContainText('Expires:')
  await expect(row).toContainText('Denied lease')
  await expect(row).toContainText('Command is destructive and outside the task.')
})

test('failed subagent row shows failure state without breaking chat rendering', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Parent recovered',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Delegate risky work')
  await launched.page.getByLabel('Message input').press('Enter')

  const startedAt = new Date(Date.now() - 700).toISOString()
  await emitNotification(launched.page, 'agent/subagentFailed', {
    runId: 'subagent-failed-1',
    agentId: 'tester',
    task: 'Run verification',
    status: 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    error: { message: 'Child agent stopped with reason: max_steps' },
    result: {
      summary: 'Verification did not finish.',
      claims: [],
      uncertainty: ['Need another pass with more steps.'],
      suggestedNextSteps: [],
    },
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Parent recovered',
    iterations: 1,
  })

  const row = launched.page.getByTestId('subagent-activity-row')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Failed')
  await expect(row).toContainText('Child agent stopped with reason: max_steps')
  await expect(row).toContainText('Verification did not finish.')
  await expect(launched.page.getByText('Parent recovered')).toBeVisible()
})

test('running sessions show sidebar and chat processing indicators', async ({}, testInfo) => {
  const now = new Date().toISOString()
  launched = await launchTestApp(testInfo, {
    scenario: {
      sessions: [
        {
          id: 'session-processing',
          createdAt: now,
          lastActive: now,
          title: 'Long running desktop task',
          messages: [],
        },
      ],
    },
  })
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Done',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByRole('button', { name: /Session: Long running desktop task/ }).click()
  await launched.page.getByLabel('Message input').fill('Run a long desktop task')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByLabel('Session is still processing')).toBeVisible()
  await expect(launched.page.getByText('Working', { exact: true })).toBeVisible()

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-processing-1',
    toolName: 'bash',
    input: { command: 'bun test' },
  })

  await expect(launched.page.getByText('Running command')).toBeVisible()

  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Done',
    iterations: 1,
  })

  await expect(launched.page.getByLabel('Session is still processing')).toHaveCount(0)
  await expect(launched.page.getByText('Done')).toBeVisible()
})

test('completed tool chip stays expanded and does not flash the jump button', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: 'Done',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Check the latest report')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-expand-1',
    toolName: 'web-search',
    input: { query: 'latest report' },
  })
  await emitNotification(launched.page, 'agent/toolCallEnd', {
    toolCallId: 'tool-expand-1',
    toolName: 'web-search',
    result: { results: ['report-a', 'report-b'] },
    isError: false,
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Done',
    iterations: 1,
  })

  await launched.page.getByRole('button', { name: /Searched web/ }).click()

  const expandedChipHeader = launched.page.getByRole('button', {
    name: 'Searched web — click to collapse',
  })
  await expect(expandedChipHeader).toBeVisible()
  await expect(launched.page.getByText('Input')).toBeVisible()
  await expect(launched.page.getByText('Output')).toBeVisible()

  await launched.page.waitForTimeout(300)
  await expect(expandedChipHeader).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Jump to bottom' })).toHaveCount(0)
})

test('desktop chat uses readable assistant layout and desktop-specific response hints', async ({}, testInfo) => {
  const markdownResponse = [
    '## Short answer',
    '',
    'For desktop chat, prose should read more like a document than a raw terminal dump.',
    '',
    '- Start with a framing paragraph.',
    '- Keep the bullet count short.',
    '- Leave enough space between sections.',
    '',
    '```ts',
    "console.log('readable desktop output')",
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: markdownResponse,
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'agent/text', params: { text: markdownResponse } },
          {
            delayMs: 20,
            method: 'agent/turnComplete',
            params: { text: markdownResponse, iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  await launched.page.getByLabel('Message input').fill('Explain desktop readability')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(
    launched.page.getByText(
      'For desktop chat, prose should read more like a document than a raw terminal dump.',
    ),
  ).toBeVisible()
  await expect(launched.page.getByText('Keep the bullet count short.')).toBeVisible()
  await expect(
    launched.page.locator('[data-testid="agent-message"] .code-block-wrapper'),
  ).toBeVisible()

  await expect
    .poll(async () => {
      const log = await readFile(launched!.paths.mockLogPath, 'utf8').catch(() => '')
      return log
    })
    .toContain('"responseStyle":"desktop-readable"')

  await expect
    .poll(async () => {
      const log = await readFile(launched!.paths.mockLogPath, 'utf8').catch(() => '')
      return log
    })
    .toContain('"client":"desktop"')

  const assistantMessage = launched.page.locator('[data-testid="agent-message"]').last()

  const layoutMetrics = await assistantMessage.evaluate((node) => {
    const markdownBody = node.querySelector('.markdown-body') as HTMLElement | null
    const content = node.querySelector(
      '[data-testid="agent-message-content"]',
    ) as HTMLElement | null
    const codeBlock = node.querySelector('.code-block-wrapper') as HTMLElement | null

    if (!markdownBody || !content || !codeBlock) {
      throw new Error('Assistant message layout nodes not found')
    }

    return {
      firstBlockTag: markdownBody.firstElementChild?.tagName ?? null,
      contentWidth: content.getBoundingClientRect().width,
      viewportWidth: window.innerWidth,
      codeBlockCount: markdownBody.querySelectorAll('.code-block-wrapper').length,
    }
  })

  const paragraphSpacing = await launched.page
    .getByText('For desktop chat, prose should read more like a document than a raw terminal dump.')
    .evaluate((node) => {
      const el = node as HTMLElement
      return {
        tagName: el.tagName,
        marginBottom: Number.parseFloat(getComputedStyle(el).marginBottom),
      }
    })

  const listSpacing = await launched.page
    .getByText('Keep the bullet count short.')
    .evaluate((node) => {
      const el = (node.closest('li') as HTMLElement | null) ?? (node as HTMLElement)
      return {
        tagName: el.tagName,
        marginBottom: Number.parseFloat(getComputedStyle(el).marginBottom),
      }
    })

  expect(layoutMetrics.firstBlockTag).toBe('H2')
  expect(layoutMetrics.contentWidth).toBeLessThan(layoutMetrics.viewportWidth * 0.72)
  expect(paragraphSpacing.tagName).toBe('P')
  expect(paragraphSpacing.marginBottom).toBeGreaterThanOrEqual(14)
  expect(listSpacing.tagName).toBe('LI')
  expect(listSpacing.marginBottom).toBeGreaterThanOrEqual(8)
  expect(layoutMetrics.codeBlockCount).toBeGreaterThanOrEqual(1)
})

test('streaming assistant text renders markdown before turn completion', async ({}, testInfo) => {
  const markdownResponse = [
    '## Short answer',
    '',
    'The streaming row should render markdown as formatted content.',
    '',
    '- First point',
    '- Second point',
    '',
    '```ts',
    "console.log('streaming markdown')",
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: markdownResponse,
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Show me a formatted streamed answer')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/text', { text: markdownResponse })

  const streamingMessage = launched.page.locator('[data-testid="agent-message"]').last()

  await expect(streamingMessage.getByText('Writing the response...')).toBeVisible()
  await expect(streamingMessage.getByRole('heading', { name: 'Short answer' })).toBeVisible()
  await expect(streamingMessage.getByText('First point')).toBeVisible()
  await expect(streamingMessage.locator('.code-block-wrapper')).toBeVisible()
  await expect(streamingMessage.locator('.markdown-body')).toBeVisible()
  await expect(streamingMessage.getByText('## Short answer')).toHaveCount(0)

  const progressOrder = await streamingMessage.evaluate((node) => {
    const content = node.querySelector('[data-testid="agent-message-content"]')
    const markdown = node.querySelector('.markdown-body')
    const progress = node.querySelector('[data-testid="agent-progress-chip"]')
    if (!content || !markdown || !progress) {
      throw new Error('Expected streaming markdown and progress chip to be rendered')
    }

    return {
      progressIsAfterMarkdown: Boolean(
        markdown.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      contentLastElementIsProgress: content.lastElementChild === progress,
    }
  })

  expect(progressOrder).toEqual({
    progressIsAfterMarkdown: true,
    contentLastElementIsProgress: true,
  })

  await emitNotification(launched.page, 'agent/turnComplete', {
    text: markdownResponse,
    iterations: 1,
  })

  await expect(launched.page.getByRole('heading', { name: 'Short answer' }).last()).toBeVisible()
})

test('streaming status chip stays at the bottom of a growing assistant bubble', async ({}, testInfo) => {
  const longResponse = [
    '## Long response',
    '',
    ...Array.from(
      { length: 36 },
      (_, index) =>
        `Paragraph ${index + 1}: streamed content keeps growing while the status chip remains reachable near the active end of the bubble.`,
    ),
  ].join('\n\n')

  launched = await launchTestApp(testInfo)
  await launched.page.setViewportSize({ width: 1200, height: 720 })
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: longResponse,
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Write a long streamed answer')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/text', { text: longResponse })

  const streamingMessage = launched.page.locator('[data-testid="agent-message"]').last()
  const progressChip = streamingMessage.getByTestId('agent-progress-chip')

  await expect(progressChip).toBeVisible()
  await expect(streamingMessage.locator('.markdown-body p').last()).toContainText('Paragraph 36')

  await expect
    .poll(async () =>
      streamingMessage.evaluate((node) => {
        const progress = node.querySelector(
          '[data-testid="agent-progress-chip"]',
        ) as HTMLElement | null
        const paragraphs = Array.from(node.querySelectorAll('.markdown-body p')) as HTMLElement[]
        const finalParagraph = paragraphs.at(-1)
        if (!progress || !finalParagraph) return false

        const progressRect = progress.getBoundingClientRect()
        const finalParagraphRect = finalParagraph.getBoundingClientRect()

        return (
          progressRect.height > 0 &&
          finalParagraphRect.height > 0 &&
          progressRect.top > finalParagraphRect.bottom &&
          progressRect.bottom <= window.innerHeight
        )
      }),
    )
    .toBe(true)
})

test('streaming cursor stays attached to the last rendered line', async ({}, testInfo) => {
  const markdownResponse = [
    '## Cursor check',
    '',
    'The cursor should sit on this final rendered line.',
  ].join('\n')

  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: markdownResponse,
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Show a cursor-aligned streamed answer')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/text', { text: markdownResponse })

  const streamingMessage = launched.page.locator('[data-testid="agent-message"]').last()
  const finalParagraph = streamingMessage.getByText(
    'The cursor should sit on this final rendered line.',
  )
  const cursor = streamingMessage.locator('.streaming-cursor')

  await expect(finalParagraph).toBeVisible()
  await expect(cursor).toBeVisible()

  const metrics = await streamingMessage.evaluate((node) => {
    const paragraph = Array.from(node.querySelectorAll('p')).find((el) =>
      el.textContent?.includes('The cursor should sit on this final rendered line.'),
    ) as HTMLElement | undefined
    const cursorEl = node.querySelector('.streaming-cursor') as HTMLElement | null

    if (!paragraph || !cursorEl) {
      throw new Error('Streaming paragraph or cursor not found')
    }

    const paragraphRect = paragraph.getBoundingClientRect()
    const cursorRect = cursorEl.getBoundingClientRect()

    return {
      paragraphTop: paragraphRect.top,
      paragraphBottom: paragraphRect.bottom,
      cursorTop: cursorRect.top,
      cursorBottom: cursorRect.bottom,
    }
  })

  expect(metrics.cursorTop).toBeGreaterThan(metrics.paragraphTop)
  expect(metrics.cursorTop).toBeLessThan(metrics.paragraphBottom + 2)
  expect(metrics.cursorBottom).toBeLessThan(metrics.paragraphBottom + 6)
})

test('settings overlay surfaces load failures and closes with Escape', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/get', {
    ok: false,
    error: { name: 'Error', message: 'Settings unavailable' },
  })

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await expect(launched.page.getByText('Settings unavailable')).toBeVisible()
  await launched.page.keyboard.press('Escape')
  await expect(launched.page.getByRole('button', { name: 'Close settings' })).toHaveCount(0)
})

test('composer mode chip and settings mode section stay in sync', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      plan: {
        title: 'Repository migration plan',
        summary: 'Break the migration into reviewable phases before coding.',
        steps: [
          { id: 'step-1', title: 'Audit affected modules', status: 'completed' },
          { id: 'step-2', title: 'Stage incremental patches', status: 'in_progress' },
        ],
        exploredFiles: ['packages/cli/src/agent.ts'],
        status: 'submitted',
      },
    },
  })
  await openMainApp()

  const modeButton = launched.page.getByRole('button', { name: 'Open mode picker' })
  await expect(modeButton).toBeVisible()
  await modeButton.click()
  await launched.page.getByRole('menuitem', { name: /Plan/ }).click()

  await expect(launched.page.getByRole('button', { name: 'Exit Plan mode' })).toBeVisible()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await expect(launched.page.getByRole('button', { name: 'Modes' })).toBeVisible()
  await launched.page.getByRole('button', { name: 'Modes' }).click()
  await expect(launched.page.getByText('Current mode', { exact: true })).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Exit current mode' })).toBeVisible()
  await expect(launched.page.getByText('Repository migration plan')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Exit current mode' }).click()
  await launched.page.getByLabel('Close settings').click()

  await expect(launched.page.getByRole('button', { name: 'Open mode picker' })).toBeVisible()
})

test('mode notifications update both the composer and settings surfaces', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await emitNotification(launched.page, 'mode/entered', {
    modeId: 'plan',
    displayName: 'Plan',
    reason: 'Testing notification sync',
  })

  await expect(launched.page.getByRole('button', { name: 'Exit Plan mode' })).toBeVisible()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)
  await launched.page.getByRole('button', { name: 'Modes' }).click()
  await expect(launched.page.getByText('Plan mode has been active since')).toBeVisible()

  await emitNotification(launched.page, 'mode/exited', {
    modeId: 'plan',
    reason: 'Stopped testing notification sync',
  })

  await expect(launched.page.getByText('Inactive')).toBeVisible()
  await launched.page.getByLabel('Close settings').click()
  await expect(launched.page.getByRole('button', { name: 'Open mode picker' })).toBeVisible()
})

test('update banner can be exercised without leaving the renderer contract suite', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await resetInstallUpdateCount(launched.page)

  await emitUpdateDownloaded(launched.page, '1.2.3')

  await expect(launched.page.getByRole('alert')).toContainText(
    'Update available (v1.2.3). Restart to apply.',
  )
  await launched.page.getByRole('button', { name: 'Restart now' }).click()

  await expect.poll(async () => getInstallUpdateCount(launched!.page)).toBe(1)
  await expect(launched.page.getByRole('button', { name: 'Restarting...' })).toBeVisible()
  await expect.poll(async () => readFile(launched!.paths.bootLogPath, 'utf8')).toContain('cli exit')
})

test('update settings can manually check and report up-to-date status', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await launched.page.getByRole('button', { name: 'Updates' }).click()
  await launched.page.getByRole('button', { name: 'Check for updates' }).click()

  await expect(launched.page.getByText(/up to date/)).toBeVisible()
})

test('update settings can manually check and report a downloaded update', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    updateDownloadedVersion: '2.0.0',
    updateDownloadedDelayMs: 5000,
  })
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await launched.page.getByRole('button', { name: 'Updates' }).click()
  await launched.page.getByRole('button', { name: 'Check for updates' }).click()

  await expect(launched.page.getByText('Version 2.0.0 is ready to install.')).toBeVisible()
  await expect(launched.page.getByRole('alert')).toContainText(
    'Update available (v2.0.0). Restart to apply.',
  )
})

test('update preferences persist across relaunch', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  const userDataDir = launched.paths.userDataDir

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await launched.page.getByRole('button', { name: 'Updates' }).click()
  await launched.page.getByRole('button', { name: 'Manual' }).click()
  await expect(launched.page.getByRole('button', { name: 'Manual' })).toHaveAttribute(
    'data-active',
    'true',
  )

  await launched.app.close()
  launched = await launchTestApp(testInfo, { userDataDir })
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await launched.page.getByRole('button', { name: 'Updates' }).click()
  await expect(launched.page.getByRole('button', { name: 'Manual' })).toHaveAttribute(
    'data-active',
    'true',
  )
})

test('top bar workspace mode selector picks a workspace folder', async ({}, testInfo) => {
  const workspacePath = '/tmp/ouroboros-test-workspace-select'
  launched = await launchTestApp(testInfo, {
    dialogResponses: [workspacePath],
  })
  await openMainApp()

  await expect(launched.page.getByRole('button', { name: 'Change workspace' })).toHaveCount(0)

  const modeButton = launched.page.getByRole('button', { name: 'Workspace mode' })
  await expect(modeButton).toBeVisible()
  await expect(modeButton).toContainText('Simple')

  await modeButton.click()
  await launched.page.getByRole('menuitem', { name: /Workspace/ }).click()

  await expect(modeButton).toContainText('ouroboros-test-workspace-select')

  await launched.page.getByLabel('New conversation').click()
  await expect(modeButton).toContainText('Simple')
})

test('chats persist when switching between sessions — regression for "chats lost on switch back"', async ({}, testInfo) => {
  // Reproduces the user-reported bug:
  //   1. Start a new chat session, send a message → assistant replies.
  //   2. Start another new chat session.
  //   3. Click back to the first session.
  //   4. The first session's chats must still be there.
  //
  // Before the per-session-CLI fix, step 4 showed an empty chat because the
  // singleton agent's history was cleared mid-flight by `session/new` and
  // persistence was misrouted to the wrong session.
  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: 'Reply to first session',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 5, method: 'agent/text', params: { text: 'Reply to first session' } },
          {
            delayMs: 10,
            method: 'agent/turnComplete',
            params: { text: 'Reply to first session', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  // The session title also contains the user message text, so scope our
  // chat-content assertions to the virtuoso list to avoid matching the
  // sidebar entry.
  const chatList = launched.page.getByTestId('virtuoso-item-list')

  // 1. First session: type a message, agent replies.
  await launched.page.getByLabel('Message input').fill('First message in session A')
  await launched.page.getByLabel('Message input').press('Enter')
  await expect(chatList.getByText('Reply to first session')).toBeVisible()
  await expect(chatList.getByText('First message in session A')).toBeVisible()

  // 2. Click "+ new chat" to create a second session.
  await launched.page.getByLabel('New conversation').click()
  // The visible chat clears for the new session.
  await expect(chatList.getByText('Reply to first session')).toHaveCount(0)
  await expect(chatList.getByText('First message in session A')).toHaveCount(0)

  // 3. Click back to the first session in the sidebar. The new session
  //    has aria-label "Open untitled session" until it gets a title; the
  //    titled "Session A" entry uses 'Session: ...'.
  await expect(
    launched.page.getByRole('button', { name: 'Open untitled session' }),
  ).toBeVisible()
  await launched.page
    .getByRole('button', { name: 'Session: First message in session A' })
    .click()

  // 4. The first session's chat history is restored — both the user's
  //    original message and the assistant's reply must be visible again.
  await expect(chatList.getByText('First message in session A')).toBeVisible()
  await expect(chatList.getByText('Reply to first session')).toBeVisible()
})

test('switching mid-processing preserves the in-flight chat (user message + partial reply)', async ({}, testInfo) => {
  // Regression for the user's follow-up complaint: "I tested it in desktop
  // app with 2 chat sessions. When I switched between them and they are
  // still processing, the chat UI becomes empty. I can't even see my
  // initial question entered."
  //
  // Per-session snapshots in the conversation store now preserve every
  // session's in-flight state across view switches, so the user message
  // and any streamed partial reply remain visible after switching back.
  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        // Make the run intentionally slow so the test can switch away
        // BEFORE the turn completes.
        response: {
          text: 'Slow reply for A',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          // Stream a partial chunk quickly so the user sees something
          // before they switch away.
          { delayMs: 5, method: 'agent/text', params: { text: 'Slow reply' } },
          // Hold the turn open long enough that we can switch sessions
          // and back, then finalize.
          {
            delayMs: 800,
            method: 'agent/text',
            params: { text: ' for A' },
          },
          {
            delayMs: 820,
            method: 'agent/turnComplete',
            params: { text: 'Slow reply for A', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()
  const chatList = launched.page.getByTestId('virtuoso-item-list')

  // 1. Start session A and send a slow message. Wait until at least the
  //    first chunk has rendered so we know the run is mid-stream.
  await launched.page.getByLabel('Message input').fill('Initial question for A')
  await launched.page.getByLabel('Message input').press('Enter')
  await expect(chatList.getByText('Initial question for A')).toBeVisible()
  await expect(chatList.getByText('Slow reply')).toBeVisible()

  // 2. Mid-processing, switch to a brand-new session B.
  await launched.page.getByLabel('New conversation').click()
  await expect(chatList.getByText('Initial question for A')).toHaveCount(0)
  await expect(chatList.getByText('Slow reply')).toHaveCount(0)

  // 3. Immediately switch BACK to A while its run is (very likely) still
  //    streaming. The user's question and the partial streamed reply must
  //    be visible — that's the UX fix.
  await launched.page
    .getByRole('button', { name: 'Session: Initial question for A' })
    .click()
  await expect(chatList.getByText('Initial question for A')).toBeVisible()
  // The partial reply ("Slow reply") was preserved; once the turn
  // completes, the full reply ("Slow reply for A") will appear in its
  // place. Either is acceptable evidence that the snapshot was preserved.
  await expect(
    chatList.getByText('Slow reply for A').or(chatList.getByText('Slow reply')),
  ).toBeVisible()
})

test('model badge updates when model name changes in settings', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      config: {
        model: { provider: 'anthropic', name: 'claude-sonnet-4-20250514' },
        permissions: {},
        rsi: { autoReflect: true, noveltyThreshold: 0.7 },
        memory: { consolidationSchedule: 'manual' },
      },
    },
  })
  await openMainApp()

  // Verify initial model badge
  await expect(launched.page.getByText('claude-sonnet-4-20250514')).toBeVisible()

  // Open settings with Cmd+,
  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  // Verify settings opened and shows current model
  await expect(launched.page.getByLabel('Close settings')).toBeVisible()

  // Mock config/set to return the updated model name
  await setRpcOverride(launched.page, 'config/set', {
    ok: true,
    result: {
      model: { provider: 'anthropic', name: 'claude-opus-4-20250514' },
      permissions: {},
      rsi: { autoReflect: true, noveltyThreshold: 0.7 },
      memory: { consolidationSchedule: 'manual' },
    },
  })

  // Change the model name input
  const modelInput = launched.page.getByLabel('Model')
  await modelInput.fill('claude-opus-4-20250514')

  // Close settings
  await launched.page.getByLabel('Close settings').click()
  await expect(launched.page.getByLabel('Close settings')).toHaveCount(0)

  // Verify the model badge has updated
  await expect(launched.page.getByText('claude-opus-4-20250514')).toBeVisible()
})
