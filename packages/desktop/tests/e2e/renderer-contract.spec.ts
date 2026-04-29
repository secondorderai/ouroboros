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

test('onboarding renders and preload bridges are available', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await expect(launched.page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible()

  const bridgeInfo = await launched.page.evaluate(() => ({
    hasRpc: typeof window.ouroboros?.rpc === 'function',
    hasNotificationBridge: typeof window.ouroboros?.onNotification === 'function',
    hasExternalOpen: typeof window.electronAPI?.openExternal === 'function',
  }))

  expect(bridgeInfo).toEqual({
    hasRpc: true,
    hasNotificationBridge: true,
    hasExternalOpen: true,
  })
})

test('command palette supports empty search state and Escape close', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    window.dispatchEvent(
      new KeyboardEvent(
        'keydown',
        currentModKey === 'metaKey' ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true },
      ),
    )
  }, modKey)
  await expect(launched.page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await launched.page.getByPlaceholder('Search actions...').fill('zzzz-no-action')
  await expect(launched.page.getByText('No matching actions')).toBeVisible()

  await launched.page.keyboard.press('Escape')
  await expect(launched.page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
})

test('onboarding provider and model selection are single choice', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  const providerGroup = launched.page.getByRole('radiogroup', { name: 'AI provider' })
  const accentBorder = 'rgb(62, 95, 138)'
  const unselectedBorder = 'rgb(220, 225, 231)'
  await expect(providerGroup.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(launched.page.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  await launched.page.getByRole('radio', { name: 'OpenAI API' }).click()
  await expect(providerGroup.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(launched.page.getByRole('radio', { name: 'OpenAI API' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(launched.page.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(launched.page.getByRole('radio', { name: 'OpenAI API' })).toHaveCSS(
    'border-top-color',
    accentBorder,
  )
  await expect(launched.page.getByRole('radio', { name: 'Anthropic' })).toHaveCSS(
    'border-top-color',
    unselectedBorder,
  )

  await launched.page.getByRole('radio', { name: 'OpenAI-compatible' }).click()
  await expect(providerGroup.getByRole('radio', { checked: true })).toHaveCount(1)
  await expect(launched.page.getByRole('radio', { name: 'OpenAI-compatible' })).toHaveCSS(
    'border-top-color',
    accentBorder,
  )
  await expect(launched.page.getByRole('radio', { name: 'OpenAI API' })).toHaveCSS(
    'border-top-color',
    unselectedBorder,
  )

  await launched.page.getByRole('radio', { name: 'OpenAI API' }).click()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/testConnection', {
    ok: true,
    result: { success: true, models: ['o4-mini', 'o3'] },
  })

  await launched.page.getByPlaceholder('sk-...').fill('sk-test-key')
  await launched.page.getByRole('button', { name: 'Test Connection' }).click()
  await expect(launched.page.getByLabel('Model')).toHaveValue('o4-mini')
})

test('onboarding provider cards do not retain selected-looking borders after switching', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  const providers = ['Anthropic', 'OpenAI API', 'ChatGPT Subscription', 'OpenAI-compatible']
  const accentBorder = 'rgb(62, 95, 138)'
  const unselectedBorder = 'rgb(220, 225, 231)'
  const nativeButtonBorder = 'rgb(0, 0, 0)'

  for (const selectedProvider of providers) {
    await launched.page.getByRole('radio', { name: selectedProvider }).click()

    for (const provider of providers) {
      const providerCard = launched.page.getByRole('radio', { name: provider })
      const expectedBorder = provider === selectedProvider ? accentBorder : unselectedBorder

      await expect(providerCard).toHaveCSS('border-top-color', expectedBorder)
      await expect(providerCard).not.toHaveCSS('border-top-color', nativeButtonBorder)
    }
  }
})

test('onboarding captures OpenAI-compatible base URL and persists it', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await expect(launched.page.getByLabel('API Base URL')).toHaveCount(0)

  await launched.page.getByRole('radio', { name: 'OpenAI-compatible' }).click()
  await expect(launched.page.getByLabel('API Base URL')).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Test Connection' })).toBeDisabled()

  await launched.page.getByPlaceholder('sk-...').fill('sk-compatible-key')
  await expect(launched.page.getByRole('button', { name: 'Test Connection' })).toBeDisabled()

  await launched.page.getByLabel('API Base URL').fill('http://localhost:11434/v1')
  await launched.page.getByLabel('Model').fill('llama3.2')
  await launched.page.getByRole('button', { name: 'Test Connection' }).click()
  await expect(launched.page.getByText('Connected')).toBeVisible()

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"baseUrl":"http://localhost:11434/v1"')

  await launched.page.getByRole('button', { name: 'Next' }).click()
  await expect(launched.page.getByRole('heading', { name: 'Choose your mode' })).toBeVisible()
  await launched.page.getByRole('button', { name: 'Simple' }).click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"path":"model.baseUrl","value":"http://localhost:11434/v1"')
})

test('onboarding creates a session for the first chat history entry', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await completeOnboarding(launched.page)

  await expect(launched.page.getByLabel('Message input')).toBeVisible()
  await expect(launched.page.getByText('New conversation')).toBeVisible()
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"session/new"')
})

test('first message after launch creates a sidebar history session', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: 'Launch question answered.',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'agent/text', params: { text: 'Launch question answered.' } },
          {
            delayMs: 20,
            method: 'agent/turnComplete',
            params: { text: 'Launch question answered.', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  await expect(launched.page.getByText('No sessions yet')).toBeVisible()
  await launched.page
    .getByLabel('Message input')
    .fill('What materials are good for use in wet areas?')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Launch question answered.')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Wet areas materials')).toBeVisible()

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log.indexOf('"method":"session/new"')).toBeLessThan(log.indexOf('"method":"agent/run"'))
})

test('sidebar loads older sessions in pages of 50', async ({}, testInfo) => {
  const baseTime = Date.parse('2026-04-23T10:00:00.000Z')
  const sessions = Array.from({ length: 55 }, (_, index) => {
    const sessionNumber = index + 1
    const timestamp = new Date(baseTime - index * 60_000).toISOString()
    return {
      id: `paged-session-${sessionNumber}`,
      title: `Paged session ${String(sessionNumber).padStart(2, '0')}`,
      createdAt: timestamp,
      lastActive: timestamp,
      messages: [
        {
          role: 'user',
          content: `Question for paged session ${sessionNumber}`,
          timestamp,
        },
        {
          role: 'assistant',
          content: `Answer for paged session ${sessionNumber}`,
          timestamp,
        },
      ],
    }
  })

  launched = await launchTestApp(testInfo, {
    scenario: { sessions },
  })
  await openMainApp()

  await expect(launched.page.getByLabel('Session: Paged session 01')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Paged session 50')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Paged session 51')).toHaveCount(0)

  await launched.page.getByRole('button', { name: 'Load more sessions' }).click()

  await expect(launched.page.getByLabel('Session: Paged session 51')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Paged session 55')).toBeVisible()
  await expect(launched.page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0)

  await launched.page.getByLabel('Session: Paged session 55').click()
  await expect(launched.page.getByText('Answer for paged session 55')).toBeVisible()

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"method":"session/list","params":{"limit":50,"offset":0}')
  expect(log).toContain('"method":"session/list","params":{"limit":50,"offset":50}')
})

test('slash skill picker selects and removes skills for agent runs', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      skills: [
        {
          name: 'code-review',
          description: 'Review code for correctness',
          version: '1.0',
          enabled: true,
        },
        {
          name: 'figma',
          description: 'Implement designs from Figma',
          version: '1.0',
          enabled: true,
        },
      ],
      agentRuns: [
        {
          response: {
            text: 'Review complete.',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 10, method: 'agent/text', params: { text: 'Review complete.' } },
            {
              delayMs: 20,
              method: 'agent/turnComplete',
              params: { text: 'Review complete.', iterations: 1 },
            },
          ],
        },
        {
          response: {
            text: 'Plain run complete.',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 10, method: 'agent/text', params: { text: 'Plain run complete.' } },
            {
              delayMs: 20,
              method: 'agent/turnComplete',
              params: { text: 'Plain run complete.', iterations: 1 },
            },
          ],
        },
      ],
    },
  })
  await openMainApp()

  const input = launched.page.getByLabel('Message input')
  await input.fill('/code')
  await expect(launched.page.getByRole('listbox', { name: 'Skill picker' })).toBeVisible()
  await expect(launched.page.getByRole('option', { name: /code-review/ })).toBeVisible()
  await input.press('Enter')
  await expect(
    launched.page.getByRole('button', { name: 'Remove code-review skill' }),
  ).toBeVisible()

  await input.fill('Review this change')
  await input.press('Enter')
  await expect(launched.page.getByText('Review complete.')).toBeVisible()

  await input.fill('/fig')
  await input.press('Enter')
  await launched.page.getByRole('button', { name: 'Remove figma skill' }).click()
  await input.fill('Run without a skill')
  await input.press('Enter')
  await expect(launched.page.getByText('Plain run complete.')).toBeVisible()

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  const agentRuns = log
    .split('\n')
    .filter((line) => line.includes('"method":"agent/run"'))
    .map((line) => JSON.parse(line.replace(/^\[request\]\s*/, '')))

  expect(agentRuns[0].params).toEqual(
    expect.objectContaining({
      message: 'Review this change',
      skillName: 'code-review',
    }),
  )
  expect(agentRuns[1].params).toEqual(
    expect.objectContaining({
      message: 'Run without a skill',
    }),
  )
  expect(agentRuns[1].params).not.toHaveProperty('skillName')
})

test('skill badge row shows user-selected and LLM-activated skills on the assistant turn', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      skills: [
        {
          name: 'meta-thinking',
          description: 'Bundled meta-thinking',
          version: '1.0',
          enabled: true,
        },
      ],
      agentRuns: [
        {
          response: {
            text: 'All planned.',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            // User-selected skill — server emits this right after activation.
            { delayMs: 5, method: 'skill/activated', params: { name: 'meta-thinking' } },
            // LLM activates an additional skill mid-turn via skill-manager.
            { delayMs: 8, method: 'skill/activated', params: { name: 'self-test' } },
            // Echo of the same name should not duplicate (store dedupes).
            { delayMs: 9, method: 'skill/activated', params: { name: 'meta-thinking' } },
            { delayMs: 12, method: 'agent/text', params: { text: 'All planned.' } },
            {
              delayMs: 18,
              method: 'agent/turnComplete',
              params: { text: 'All planned.', iterations: 1 },
            },
          ],
        },
      ],
    },
  })
  await openMainApp()

  const input = launched.page.getByLabel('Message input')
  await input.fill('/meta')
  await expect(launched.page.getByRole('listbox', { name: 'Skill picker' })).toBeVisible()
  await input.press('Enter')
  await input.fill('Plan it')
  await input.press('Enter')

  await expect(launched.page.getByText('All planned.')).toBeVisible()

  // Assistant turn shows both badges, no duplicates from the echo.
  const badgeRow = launched.page.getByTestId('skill-badge-row')
  await expect(badgeRow).toBeVisible()
  const badges = badgeRow.getByTestId('skill-badge')
  await expect(badges).toHaveCount(2)
  await expect(badges.nth(0)).toHaveText(/meta-thinking/)
  await expect(badges.nth(1)).toHaveText(/self-test/)
})

test('sidebar sessions can be renamed from the context menu', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo, {
    scenario: {
      sessions: [
        {
          id: 'session-rename',
          createdAt: '2026-04-23T00:00:00.000Z',
          lastActive: '2026-04-23T00:00:00.000Z',
          title: 'Generated fragment title',
          titleSource: 'auto',
          messages: [
            {
              role: 'user',
              content: 'Implement the recommended direction',
              timestamp: '2026-04-23T00:00:00.000Z',
            },
          ],
        },
      ],
    },
  })
  await openMainApp()

  await launched.page.getByLabel('Session: Generated fragment title').click({ button: 'right' })
  await launched.page.getByRole('button', { name: 'Rename' }).click()
  await launched.page.getByLabel('Session title').fill('Desktop Sidebar Titles')
  await launched.page.getByRole('button', { name: 'Save' }).click()

  await expect(launched.page.getByLabel('Session: Desktop Sidebar Titles')).toBeVisible()
  await expect(launched.page.getByLabel('Session: Generated fragment title')).toHaveCount(0)

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"session/rename"')
})

test('native attachment dialog adds multiple images, de-dupes, rejects unsupported images, and sends metadata', async ({}, testInfo) => {
  const { pngPath, jpgPath, gifPath } = await writeTestImageFiles('ouroboros-images-dialog-')
  launched = await launchTestApp(testInfo, {
    dialogResponses: [[pngPath, jpgPath, pngPath, gifPath]],
    scenario: {
      defaultAgentRun: {
        response: {
          text: 'Image context received.',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'agent/text', params: { text: 'Image context received.' } },
          {
            delayMs: 20,
            method: 'agent/turnComplete',
            params: { text: 'Image context received.', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  await launched.page.getByRole('button', { name: 'Attach files' }).click()

  await expect(launched.page.getByRole('button', { name: 'Remove diagram.png' })).toHaveCount(1)
  await expect(launched.page.getByRole('button', { name: 'Remove photo.jpg' })).toHaveCount(1)
  await expect(launched.page.getByText(/Could not attach animation\.gif/)).toBeVisible()

  await launched.page.getByRole('button', { name: 'Remove photo.jpg' }).click()
  await expect(launched.page.getByRole('button', { name: 'Remove photo.jpg' })).toHaveCount(0)

  await launched.page.getByLabel('Message input').fill('Describe the attached image')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Image context received.')).toBeVisible()
  const pngImage = launched.page.getByRole('img', { name: 'diagram.png' })
  await expect(pngImage).toBeVisible()
  // Guard against CSP regressions that block `data:` URLs in <img> src.
  await expect
    .poll(async () =>
      pngImage.evaluate((el) => {
        const img = el as HTMLImageElement
        return img.complete && img.naturalWidth > 0
      }),
    )
    .toBe(true)
  await expect(launched.page.getByText('photo.jpg')).toHaveCount(0)

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"agent/run"')
  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"images"')
  expect(log).toContain('"name":"diagram.png"')
  expect(log).toContain('"mediaType":"image/png"')
  expect(log).not.toContain('"name":"photo.jpg"')
  expect(log).not.toContain('previewDataUrl')
})

test('dragged image paths use validation and image metadata in the agent run payload', async ({}, testInfo) => {
  const { webpPath, gifPath } = await writeTestImageFiles('ouroboros-images-drop-')
  launched = await launchTestApp(testInfo, {
    scenario: {
      defaultAgentRun: {
        response: {
          text: 'Dropped image received.',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
        notifications: [
          { delayMs: 10, method: 'agent/text', params: { text: 'Dropped image received.' } },
          {
            delayMs: 20,
            method: 'agent/turnComplete',
            params: { text: 'Dropped image received.', iterations: 1 },
          },
        ],
      },
    },
  })
  await openMainApp()

  await launched.page.evaluate(
    ([currentWebpPath, currentGifPath]) => {
      const addFiles = (window as unknown as Record<string, unknown>).__inputBarAddFiles as
        | ((files: string[]) => void)
        | undefined
      addFiles?.([currentWebpPath, currentGifPath, currentWebpPath])
    },
    [webpPath, gifPath],
  )

  await expect(launched.page.getByRole('button', { name: 'Remove mockup.webp' })).toHaveCount(1)
  await expect(launched.page.getByText(/Could not attach animation\.gif/)).toBeVisible()

  await launched.page.getByLabel('Message input').fill('Use the dropped image')
  await launched.page.getByLabel('Message input').press('Enter')

  await expect(launched.page.getByText('Dropped image received.')).toBeVisible()
  await expect(launched.page.getByRole('img', { name: 'mockup.webp' })).toBeVisible()

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"name":"mockup.webp"')
  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"mediaType":"image/webp"')
  expect(log).not.toContain('animation.gif')
  expect(log).not.toContain('previewDataUrl')
})

test('approval notifications populate the UI and failed responses keep the approval visible', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'approval/respond', {
    ok: false,
    error: { name: 'Error', message: 'CLI restarting' },
  })

  await emitNotification(launched.page, 'approval/request', {
    id: 'approval-1',
    type: 'self-modification',
    description: 'Approve this desktop patch',
    createdAt: new Date().toISOString(),
    risk: 'high',
  })

  await expect(launched.page.getByText('Approval Required')).toBeVisible()
  await expect(launched.page.getByText('Approve this desktop patch')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Approve' }).click()

  await expect(launched.page.getByText('CLI restarting')).toBeVisible()
  await expect(launched.page.getByText('Approve this desktop patch')).toBeVisible()
})

test('ask-user notification opens modal and submits selected option', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: '',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Ask me a question')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'ask-tool-1',
    toolName: 'ask-user',
    input: { question: 'Choose a release channel', options: ['Stable', 'Beta'] },
  })
  await emitNotification(launched.page, 'askUser/request', {
    id: 'ask-user-1',
    question: 'Choose a release channel',
    options: ['Stable', 'Beta'],
    createdAt: new Date().toISOString(),
  })

  await expect(launched.page.getByRole('dialog', { name: 'Input Needed' })).toBeVisible()
  await expect(launched.page.getByText('Choose a release channel')).toBeVisible()
  await expect(launched.page.getByRole('radio', { name: 'Stable' })).toBeVisible()
  await expect(launched.page.getByLabel('Custom response')).toBeVisible()
  await expect(launched.page.getByRole('button', { name: /Waiting for your answer/ })).toBeVisible()

  await launched.page.getByRole('radio', { name: 'Beta' }).click()
  await launched.page.getByRole('button', { name: 'Submit' }).click()

  await expect(launched.page.getByRole('dialog', { name: 'Input Needed' })).toHaveCount(0)
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"method":"askUser/respond"')
  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"response":"Beta"')
})

test('ask-user modal submits custom text and keeps failed responses visible', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'askUser/respond', {
    ok: false,
    error: { name: 'Error', message: 'CLI restarting' },
  })

  await emitNotification(launched.page, 'askUser/request', {
    id: 'ask-user-custom',
    question: 'How should this be handled?',
    options: ['Skip', 'Retry'],
    createdAt: new Date().toISOString(),
  })

  await launched.page.getByLabel('Custom response').fill('Wait for deployment')
  await launched.page.getByRole('button', { name: 'Submit' }).click()

  await expect(launched.page.getByText('CLI restarting')).toBeVisible()
  await expect(launched.page.getByRole('dialog', { name: 'Input Needed' })).toBeVisible()
  await expect(launched.page.getByLabel('Custom response')).toHaveValue('Wait for deployment')

  await setRpcOverride(launched.page, 'askUser/respond', null)
  await launched.page.getByRole('button', { name: 'Submit' }).click()

  await expect(launched.page.getByRole('dialog', { name: 'Input Needed' })).toHaveCount(0)
})

test('submitted plan renders in chat and decision prompt sends next message', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await openMainApp()

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'agent/run', {
    ok: true,
    result: {
      text: '',
      iterations: 1,
      stopReason: 'completed',
      maxIterationsReached: false,
    },
  })

  await launched.page.getByLabel('Message input').fill('Create a plan')
  await launched.page.getByLabel('Message input').press('Enter')

  await emitNotification(launched.page, 'mode/planSubmitted', {
    plan: {
      title: 'Desktop Plan Review Prompt',
      summary: 'Render submitted plans and collect a decision.',
      steps: [
        {
          description: 'Display the submitted plan',
          targetFiles: ['packages/desktop/src/renderer/App.tsx'],
          tools: ['file-edit'],
        },
      ],
      exploredFiles: ['packages/desktop/src/renderer/App.tsx'],
      status: 'submitted',
    },
  })
  await emitNotification(launched.page, 'agent/turnComplete', {
    text: 'Plan submitted. Please review and let me know if you approve, reject, or cancel.',
    iterations: 1,
  })

  await expect(
    launched.page.getByRole('heading', { name: 'Desktop Plan Review Prompt' }),
  ).toBeVisible()
  await expect(launched.page.getByText('Display the submitted plan')).toBeVisible()
  await expect(launched.page.getByRole('dialog', { name: 'Review Plan' })).toBeVisible()
  await expect(launched.page.getByRole('radio', { name: 'Approve' })).toBeVisible()
  await expect(launched.page.getByRole('radio', { name: 'Reject' })).toBeVisible()
  await expect(launched.page.getByRole('radio', { name: 'Custom response' })).toBeVisible()

  await launched.page.getByRole('button', { name: 'Submit' }).click()

  await expect(launched.page.getByRole('dialog', { name: 'Review Plan' })).toHaveCount(0)
  await expect(launched.page.getByText('Approved. Proceed with the plan.')).toBeVisible()
})

test('onboarding stays open when required setup fails', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await clearRpcOverrides(launched.page)
  await setRpcOverride(launched.page, 'config/testConnection', {
    ok: true,
    result: { success: true, models: ['claude-opus-4-20250514'] },
  })
  await setRpcOverride(launched.page, 'config/setApiKey', {
    ok: false,
    error: { name: 'Error', message: 'Invalid API key' },
  })

  await launched.page.getByPlaceholder('sk-...').fill('sk-test-key')
  await launched.page.getByRole('button', { name: 'Test Connection' }).click()
  await expect(launched.page.getByText('Connected')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Next' }).click()
  await expect(launched.page.getByText('Choose your mode')).toBeVisible()
  await launched.page.getByRole('button', { name: 'Simple' }).click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()

  await expect(launched.page.getByText('Invalid API key')).toBeVisible()
  await expect(launched.page.getByText('Choose your mode')).toBeVisible()
})

test('onboarding supports ChatGPT subscription without API key entry', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await launched.page.getByText('ChatGPT Subscription', { exact: true }).click()
  await expect(launched.page.getByPlaceholder('sk-...')).toHaveCount(0)

  await launched.page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
  await expect(launched.page.getByText(/Connected/)).toBeVisible()
  await launched.page.getByRole('button', { name: 'Next' }).click()

  await expect(launched.page.getByText('Choose your mode')).toBeVisible()
})

test('settings can switch to ChatGPT subscription and sign out cleanly', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)

  await expect(
    launched.page.getByRole('navigation').getByText('Settings', { exact: true }),
  ).toBeVisible()
  await launched.page.locator('select').first().selectOption('openai-chatgpt')
  await expect(launched.page.getByPlaceholder('Enter your API key...')).toHaveCount(0)

  await launched.page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
  await expect(launched.page.getByText('Connected account: acct_test')).toBeVisible()

  await launched.page.getByRole('button', { name: 'Sign out' }).click()
  await expect(launched.page.getByText('Disconnected from ChatGPT subscription')).toBeVisible()
})

test('settings manages skills and lookup paths without exposing tools', async ({}, testInfo) => {
  const addedPath = path.join(tmpdir(), 'ouroboros-extra-skills')
  launched = await launchTestApp(testInfo, {
    dialogResponses: [addedPath],
    scenario: {
      config: {
        model: { provider: 'anthropic', name: 'claude-opus-4-20250514' },
        permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
        skillDirectories: ['skills/core'],
        disabledSkills: ['generated-off'],
        memory: { consolidationSchedule: 'session-end' },
        rsi: { noveltyThreshold: 0.5, autoReflect: true },
      },
      skills: [
        {
          name: 'meta-thinking',
          description: 'Built-in planning skill',
          version: '1.0',
          enabled: true,
          status: 'builtin',
          path: '/Applications/Ouroboros.app/skills/builtin/meta-thinking',
        },
        {
          name: 'generated-off',
          description: 'Disabled generated skill',
          version: '1.0',
          enabled: false,
          status: 'generated',
          path: 'skills/generated/generated-off',
        },
        {
          name: 'generated-on',
          description: 'Enabled generated skill',
          version: '1.0',
          enabled: true,
          status: 'generated',
          path: 'skills/generated/generated-on',
        },
      ],
    },
  })
  await openMainApp()

  await launched.page.evaluate((currentModKey) => {
    const init =
      currentModKey === 'metaKey' ? { key: ',', metaKey: true } : { key: ',', ctrlKey: true }
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  }, modKey)
  await expect(launched.page.getByLabel('Close settings')).toBeVisible()
  await launched.page.getByRole('button').filter({ hasText: 'Skill availability' }).click()

  await expect(launched.page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible()
  await expect(launched.page.getByText('meta-thinking', { exact: true })).toBeVisible()
  await expect(launched.page.getByText('Built-in planning skill')).toBeVisible()
  await expect(launched.page.getByText('generated-off', { exact: true })).toBeVisible()
  await expect(launched.page.getByText('Tool', { exact: true })).toHaveCount(0)

  await launched.page.getByRole('button', { name: 'meta-thinking: enabled' }).click()
  await expect(launched.page.getByRole('button', { name: 'meta-thinking: disabled' })).toBeVisible()

  await launched.page.getByRole('button', { name: 'Add path' }).click()
  await expect(launched.page.getByText(addedPath)).toBeVisible()

  await launched.page.getByRole('button', { name: 'Remove skills/core' }).click()
  await expect(launched.page.getByText('skills/core')).toHaveCount(0)

  await launched.page.getByLabel('Close settings').click()
  await launched.page.getByLabel('Message input').fill('/generated')
  const skillPicker = launched.page.getByRole('listbox', { name: 'Skill picker' })
  await expect(skillPicker).toBeVisible()
  await expect(skillPicker.getByRole('option', { name: /generated-on/ })).toBeVisible()
  await expect(skillPicker.getByText('generated-off')).toHaveCount(0)

  const log = await readFile(launched.paths.mockLogPath, 'utf8')
  expect(log).toContain('"method":"skills/list","params":{"includeDisabled":true}')
  expect(log).toContain('"path":"disabledSkills","value":["generated-off","meta-thinking"]')
  expect(log).toContain(`"path":"skillDirectories","value":["skills/core","${addedPath}"]`)
  expect(log).toContain(`"path":"skillDirectories","value":["${addedPath}"]`)
})
