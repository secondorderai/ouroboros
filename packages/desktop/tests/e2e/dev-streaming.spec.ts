import { expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { emitNotification, launchTestApp, setRpcOverride } from './helpers'

let server: ViteDevServer

test.beforeAll(async () => {
  // Production React does not replay mount effects. Exercise the development
  // renderer used by `bun run dev`, with an isolated mock CLI and profile.
  server = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dirname, '../../src/renderer'),
    cacheDir: await mkdtemp(path.join(tmpdir(), 'ouroboros-dev-streaming-')),
    plugins: [react()],
    resolve: { dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
})

test.afterAll(async () => {
  await server?.close()
})

test('development renderer restores an existing stream after StrictMode remount', async ({}, testInfo) => {
  const launched = await launchTestApp(testInfo, {
    env: { ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0] },
  })
  try {
    const { page } = launched
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(() => localStorage.setItem('ouroboros:onboarding-done', 'true'))
    await page.reload()
    await expect(page.getByLabel('Message input')).toBeVisible()
    await setRpcOverride(page, 'agent/run', {
      ok: true,
      result: { text: 'Done', iterations: 1, stopReason: 'completed', maxIterationsReached: false },
    })
    await page.getByLabel('Message input').fill('Keep my partial response')
    await page.getByLabel('Message input').press('Enter')
    await emitNotification(page, 'agent/text', { text: '## Preserved partial response' })
    await expect(page.getByRole('heading', { name: 'Preserved partial response' })).toBeVisible()

    await page.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect(page.getByTestId('agent-message')).toHaveCount(0)
    await page.getByRole('button', { name: /Session: Keep my partial response/ }).click()
    await expect(page.getByRole('heading', { name: 'Preserved partial response' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await launched.app.close()
  }
})
