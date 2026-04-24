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
  await launched.page.getByRole('button', { name: "I'll set this up later" }).click()
  await launched.page.getByText('Help me with a project').click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()

  await expect
    .poll(async () => readFile(launched!.paths.mockLogPath, 'utf8').catch(() => ''))
    .toContain('"path":"model.baseUrl","value":"http://localhost:11434/v1"')
})

test('onboarding creates a session for the first chat history entry', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await completeOnboarding(launched.page, {
    templateName: 'Help me with a project',
  })

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
  await expect(launched.page.getByText('Choose your workspace')).toBeVisible()

  await launched.page.getByRole('button', { name: "I'll set this up later" }).click()
  await expect(launched.page.getByText('What would you like to do?')).toBeVisible()

  await launched.page.getByText('Help me with a project').click()
  await launched.page.getByRole('button', { name: 'Get Started' }).click()

  await expect(launched.page.getByText('Invalid API key')).toBeVisible()
  await expect(launched.page.getByText('What would you like to do?')).toBeVisible()
})

test('onboarding supports ChatGPT subscription without API key entry', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await clearClientState(launched.page)

  await launched.page.getByText('ChatGPT Subscription', { exact: true }).click()
  await expect(launched.page.getByPlaceholder('sk-...')).toHaveCount(0)

  await launched.page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
  await expect(launched.page.getByText(/Connected/)).toBeVisible()
  await launched.page.getByRole('button', { name: 'Next' }).click()

  await expect(launched.page.getByText('Choose your workspace')).toBeVisible()
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
  await expect(launched.page.getByText('Ouroboros is still working in this session')).toBeVisible()

  await emitNotification(launched.page, 'agent/toolCallStart', {
    toolCallId: 'tool-processing-1',
    toolName: 'bash',
    input: { command: 'bun test' },
  })

  await expect(launched.page.getByText('Running command')).toBeVisible()
  await expect(launched.page.getByText('Running a command', { exact: true })).toBeVisible()

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

  await emitNotification(launched.page, 'agent/turnComplete', {
    text: markdownResponse,
    iterations: 1,
  })

  await expect(launched.page.getByRole('heading', { name: 'Short answer' }).last()).toBeVisible()
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
})
