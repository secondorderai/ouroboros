import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { LaunchedApp } from './helpers'
import {
  clearRpcOverrides,
  completeOnboarding,
  emitNotification,
  launchTestApp,
  setRpcOverride,
} from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await clearRpcOverrides(launched.page).catch(() => {})
    await launched.app.close()
  }
  launched = null
})

const SESSION_ID = 'sess-artifact-panel'
const ARTIFACT_ID = 'art-001'

test('artifact panel renders sandboxed iframe and supports versioning + open externally', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)

  await setRpcOverride(launched.page, 'artifacts/list', {
    ok: true,
    result: { artifacts: [] },
  })
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: '<!DOCTYPE html><html><head><title>Hello</title></head><body><h1>Hello artifact</h1></body></html>',
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 1,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: '/tmp/art.v1.html',
        bytes: 80,
        createdAt: '2026-04-26T00:00:00Z',
      },
    },
  })
  await setRpcOverride(launched.page, 'session/new', {
    ok: true,
    result: { sessionId: SESSION_ID },
  })

  // Click "New conversation" in the sidebar to call session/new and update
  // the conversation store, which triggers ArtifactsStore.setSession.
  await launched.page.getByRole('button', { name: 'New conversation' }).click()

  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    title: 'Hello artifact',
    path: '/tmp/art.v1.html',
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })

  await expect(launched.page.getByTestId('artifact-panel')).toBeVisible()
  const frame = launched.page.getByTestId('artifact-frame')
  await expect(frame).toBeVisible()
  const sandboxAttr = await frame.getAttribute('sandbox')
  expect(sandboxAttr).toBe('allow-scripts')
  expect(sandboxAttr).not.toContain('allow-same-origin')

  const inner = launched.page.frameLocator('[data-testid="artifact-frame"]')
  await expect(inner.locator('h1')).toHaveText('Hello artifact')

  // Bump to v2: same artifactId, new version. Version dropdown must appear.
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: '<!DOCTYPE html><html><head><title>Hello v2</title></head><body><h1>Hello v2</h1></body></html>',
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 2,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: '/tmp/art.v2.html',
        bytes: 80,
        createdAt: '2026-04-26T00:00:01Z',
      },
    },
  })
  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 2,
    title: 'Hello artifact',
    path: '/tmp/art.v2.html',
    bytes: 80,
    createdAt: '2026-04-26T00:00:01Z',
  })

  await expect(launched.page.getByTestId('artifact-version-picker')).toBeVisible()
  await expect(inner.locator('h1')).toHaveText('Hello v2')

  // Open externally: clicking the button hits the existing shell:openExternal
  // pipeline, which the test harness logs to externalUrlLogPath.
  await launched.page.getByTestId('artifact-open-external').click()

  await expect
    .poll(async () => {
      try {
        const contents = await readFile(launched!.paths.externalUrlLogPath, 'utf8')
        const records = contents
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { url: string })
        return records.some((r) => r.url.startsWith('file://'))
      } catch {
        return false
      }
    })
    .toBe(true)
})
