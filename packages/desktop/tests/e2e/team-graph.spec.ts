import { expect, test } from '@playwright/test'
import type { LaunchedApp } from './helpers'
import { launchTestApp, setRpcOverride } from './helpers'

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

async function openTeamGraph(): Promise<void> {
  if (!launched) throw new Error('App not launched')
  await launched.page.evaluate((currentModKey) => {
    window.dispatchEvent(
      new KeyboardEvent(
        'keydown',
        currentModKey === 'metaKey' ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true },
      ),
    )
  }, modKey)
  await expect(launched.page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await launched.page.getByPlaceholder('Search actions...').fill('team graph')
  await launched.page.getByRole('option', { name: /Team graph/ }).click()
  await expect(launched.page.getByRole('dialog', { name: 'Team graph' })).toBeVisible()
}

function mockGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = '2026-04-23T10:00:00.000Z'
  return {
    id: 'graph-mock-1',
    name: 'Mock implementation team',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    agents: [
      { id: 'Sam', status: 'active', activeTaskIds: ['task-running'], updatedAt: now },
      { id: 'Tim', status: 'active', activeTaskIds: ['task-blocked'], updatedAt: now },
      { id: 'Jack', status: 'completed', activeTaskIds: [], updatedAt: now },
    ],
    tasks: [
      {
        id: 'task-completed',
        title: 'Define protocol contract',
        description: 'Backend contract is ready for desktop rendering.',
        status: 'completed',
        dependencies: [],
        assignedAgentId: 'Jack',
        requiredArtifacts: ['packages/desktop/src/shared/protocol.ts'],
        qualityGates: [{ id: 'gate-contract', description: 'Contract test passes', required: true, status: 'passed' }],
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      {
        id: 'task-running',
        title: 'Implement review surface',
        description: 'Build the renderer panel and inspector.',
        status: 'running',
        dependencies: ['task-completed'],
        assignedAgentId: 'Sam',
        requiredArtifacts: ['TeamGraphDrawer.tsx', 'TeamGraphDrawer.css'],
        qualityGates: [
          { id: 'gate-e2e', description: 'E2E covers task details', required: true, status: 'pending' },
          { id: 'gate-design', description: 'Uses desktop design tokens', required: true, status: 'passed' },
        ],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-blocked',
        title: 'Wait for debate handoff',
        description: 'Blocked by a separate workflow ticket.',
        status: 'blocked',
        dependencies: ['task-running'],
        assignedAgentId: 'Tim',
        requiredArtifacts: ['handoff-notes.md'],
        qualityGates: [{ id: 'gate-handoff', description: 'Handoff received', required: true, status: 'pending' }],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-failed',
        title: 'Publish stale dashboard',
        description: 'Failed because graph must remain progressive disclosure.',
        status: 'failed',
        dependencies: [],
        assignedAgentId: 'Sam',
        requiredArtifacts: ['failure-report.md'],
        qualityGates: [{ id: 'gate-ux', description: 'Chat-first UX preserved', required: true, status: 'failed' }],
        createdAt: now,
        updatedAt: now,
      },
    ],
    messages: [
      {
        id: 'event-1',
        message: 'Renderer panel mounted with mock team data.',
        agentId: 'Sam',
        taskId: 'task-running',
        createdAt: now,
      },
    ],
    ...overrides,
  }
}

test('renders blocked running completed and failed task graph states', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await setRpcOverride(launched.page, 'team/create', { ok: true, result: { graph: mockGraph() } })

  await openTeamGraph()

  await expect(launched.page.getByTestId('team-graph-task-blocked')).toContainText('blocked')
  await expect(launched.page.getByTestId('team-graph-task-running')).toContainText('running')
  await expect(launched.page.getByTestId('team-graph-task-completed')).toContainText('completed')
  await expect(launched.page.getByTestId('team-graph-task-failed')).toContainText('failed')
  await expect(launched.page.getByText('Agent: Sam').first()).toBeVisible()
  await expect(launched.page.getByText('Depends on: Define protocol contract')).toBeVisible()

  const stateColors = await launched.page
    .locator('.team-graph-task-state')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor))
  expect(new Set(stateColors).size).toBeGreaterThanOrEqual(4)
})

test('selecting a task shows artifacts quality gates and recent events', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  await setRpcOverride(launched.page, 'team/create', { ok: true, result: { graph: mockGraph() } })

  await openTeamGraph()
  await launched.page.getByTestId('team-graph-task-running').click()

  const inspector = launched.page.getByTestId('team-graph-inspector')
  await expect(inspector).toContainText('TeamGraphDrawer.tsx')
  await expect(inspector).toContainText('TeamGraphDrawer.css')
  await expect(inspector).toContainText('E2E covers task details')
  await expect(inspector).toContainText('Uses desktop design tokens')
  await expect(inspector).toContainText('Renderer panel mounted with mock team data.')
})

test('cancelled team graph shows cancellation and cleanup state', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()
  const graph = mockGraph({
    status: 'cancelled',
    cancelledAt: '2026-04-23T10:05:00.000Z',
    cancellationReason: 'User stopped the team run.',
    agents: [
      { id: 'Sam', status: 'cancelled', activeTaskIds: [], updatedAt: '2026-04-23T10:05:00.000Z' },
      { id: 'Tim', status: 'cancelled', activeTaskIds: [], updatedAt: '2026-04-23T10:05:00.000Z' },
    ],
    tasks: [
      {
        id: 'task-cancelled',
        title: 'Cancel remaining desktop work',
        description: 'Cancelled during team shutdown.',
        status: 'cancelled',
        dependencies: [],
        assignedAgentId: 'Sam',
        requiredArtifacts: ['shutdown-log.md'],
        qualityGates: [{ id: 'gate-cancel', description: 'Cancellation visible', required: true, status: 'pending' }],
        createdAt: '2026-04-23T10:00:00.000Z',
        updatedAt: '2026-04-23T10:05:00.000Z',
        cancellationReason: 'Team cancelled',
      },
    ],
    messages: [],
  })
  await setRpcOverride(launched.page, 'team/create', { ok: true, result: { graph } })

  await openTeamGraph()

  await expect(launched.page.getByTestId('team-graph-cancellation')).toContainText(
    'User stopped the team run.',
  )
  await expect(launched.page.getByTestId('team-graph-cancellation')).toContainText(
    'Cleanup is ready',
  )
  await expect(launched.page.getByTestId('team-graph-task-cancelled')).toContainText('cancelled')
  await expect(launched.page.getByTestId('team-graph-summary-cancelled')).toContainText('1')
})

test('agent-created team graph notification opens the matching graph drawer', async ({}, testInfo) => {
  const graph = mockGraph({ id: 'graph-from-agent', name: 'Agent-created team plan' })
  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: 'Created the team graph.',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'team/graphOpen', params: { graph, reason: 'Created by team_graph' } },
          { delayMs: 20, method: 'agent/text', params: { text: 'Created the team graph.' } },
          {
            delayMs: 30,
            method: 'agent/turnComplete',
            params: { text: 'Created the team graph.', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()
  await setRpcOverride(launched.page, 'team/get', { ok: true, result: { graph } })

  await launched.page.getByLabel('Message input').fill('Create a team graph and show it.')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByRole('dialog', { name: 'Team graph' })).toBeVisible()
  await expect(launched.page.getByRole('heading', { name: 'Agent-created team plan' })).toBeVisible()
  await expect(launched.page.getByTestId('team-graph-workflow-events')).toContainText(
    'Renderer panel mounted with mock team data.',
  )
})
