import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
// V1 includes an INLINE SCRIPT that wires a click handler. This is the load-bearing
// test fixture: when the renderer's CSP is inherited into the iframe (the bug fix
// guards against), inline scripts are blocked and the button never becomes
// interactive — the click assertion below would then fail.
const ARTIFACT_HTML_V1 = `<!DOCTYPE html><html><head><title>Hello</title></head>
<body>
<h1>Hello artifact</h1>
<button id="hit" type="button">Hit me</button>
<p id="status">idle</p>
<script>
document.getElementById('hit').addEventListener('click', function () {
  document.getElementById('status').textContent = 'clicked'
})
</script>
</body></html>`
const ARTIFACT_HTML_V2 =
  '<!DOCTYPE html><html><head><title>Hello v2</title></head><body><h1>Hello v2</h1></body></html>'

async function makeArtifactFile(
  version: number,
  html: string,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ouroboros-artifact-fixture-'))
  const artifactsDir = path.join(root, 'memory', 'sessions', SESSION_ID, 'artifacts')
  await mkdir(artifactsDir, { recursive: true })
  const filePath = path.join(artifactsDir, `${ARTIFACT_ID}.v${version}.html`)
  await writeFile(filePath, html)
  return filePath
}

test('artifact panel renders sandboxed iframe and supports versioning + open externally', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)

  const artifactPathV1 = await makeArtifactFile(1, ARTIFACT_HTML_V1)
  const artifactPathV2 = await makeArtifactFile(2, ARTIFACT_HTML_V2)

  await setRpcOverride(launched.page, 'artifacts/list', {
    ok: true,
    result: { artifacts: [] },
  })
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: ARTIFACT_HTML_V1,
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 1,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: artifactPathV1,
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
    path: artifactPathV1,
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })

  await expect(launched.page.getByTestId('artifact-panel')).toBeVisible()
  const frame = launched.page.getByTestId('artifact-frame')
  await expect(frame).toBeVisible()
  const sandboxAttr = await frame.getAttribute('sandbox')
  // Loading via the `ouroboros-artifact://` scheme means the iframe is in its
  // own origin, so `allow-same-origin` is safe and required for storage APIs
  // many real artifacts depend on.
  expect(sandboxAttr?.split(/\s+/).sort()).toEqual(
    [
      'allow-downloads',
      'allow-forms',
      'allow-modals',
      'allow-pointer-lock',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-same-origin',
      'allow-scripts',
    ].sort(),
  )
  const srcAttr = await frame.getAttribute('src')
  expect(srcAttr).toMatch(/^ouroboros-artifact:\/\//)
  expect(srcAttr).toContain(encodeURIComponent(artifactPathV1))

  const inner = launched.page.frameLocator('[data-testid="artifact-frame"]')
  await expect(inner.locator('h1')).toHaveText('Hello artifact')

  // Regression guard: clicking a button whose handler is registered by an
  // INLINE script must mutate the page. If the parent renderer's CSP ever
  // re-inherits into the iframe, inline scripts will be blocked and this
  // assertion fails before any user notices the breakage.
  await expect(inner.locator('#status')).toHaveText('idle')
  await inner.getByRole('button', { name: 'Hit me' }).click()
  await expect(inner.locator('#status')).toHaveText('clicked')

  // Bump to v2: same artifactId, new version. Version dropdown must appear.
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: ARTIFACT_HTML_V2,
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 2,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: artifactPathV2,
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
    path: artifactPathV2,
    bytes: 80,
    createdAt: '2026-04-26T00:00:01Z',
  })

  await expect(launched.page.getByTestId('artifact-version-picker')).toBeVisible()
  await expect(inner.locator('h1')).toHaveText('Hello v2')

  // Open externally: clicking the button should hit the new shell:openArtifact
  // pipeline. The main process validates the path (must live under
  // memory/sessions/*/artifacts/<id>.v<n>.html) and logs the call to
  // openArtifactLogPath. The previous file:// URL path was silently blocked.
  await launched.page.getByTestId('artifact-open-external').click()

  await expect
    .poll(async () => {
      try {
        const contents = await readFile(launched!.paths.openArtifactLogPath, 'utf8')
        const records = contents
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { path: string; allowed: boolean })
        return records.find((r) => r.path === artifactPathV2)?.allowed ?? false
      } catch {
        return false
      }
    })
    .toBe(true)
})

test('resizing the artifact panel changes its width and persists across reload', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)

  const artifactPath = await makeArtifactFile(1, ARTIFACT_HTML_V1)

  await setRpcOverride(launched.page, 'artifacts/list', { ok: true, result: { artifacts: [] } })
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: ARTIFACT_HTML_V1,
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 1,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: artifactPath,
        bytes: 80,
        createdAt: '2026-04-26T00:00:00Z',
      },
    },
  })
  await setRpcOverride(launched.page, 'session/new', {
    ok: true,
    result: { sessionId: SESSION_ID },
  })

  await launched.page.getByRole('button', { name: 'New conversation' }).click()
  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    title: 'Hello artifact',
    path: artifactPath,
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })

  const panel = launched.page.getByTestId('artifact-panel')
  await expect(panel).toBeVisible()
  const handle = launched.page.getByTestId('artifact-panel-resize-handle')
  await expect(handle).toBeVisible()

  const startBox = await panel.boundingBox()
  expect(startBox).not.toBeNull()
  const startWidth = startBox!.width

  const handleBox = await handle.boundingBox()
  expect(handleBox).not.toBeNull()
  const startX = handleBox!.x + handleBox!.width / 2
  const startY = handleBox!.y + handleBox!.height / 2

  // Drag the handle 120px to the LEFT to widen the panel by ~120px.
  await launched.page.mouse.move(startX, startY)
  await launched.page.mouse.down()
  await launched.page.mouse.move(startX - 120, startY, { steps: 10 })
  await launched.page.mouse.up()

  await expect
    .poll(async () => {
      const box = await panel.boundingBox()
      return box?.width ?? 0
    })
    .toBeGreaterThan(startWidth + 50)

  const widthAfterDrag = (await panel.boundingBox())!.width
  const persistedWidth = await launched.page.evaluate(() =>
    Number.parseInt(window.localStorage.getItem('ouroboros:artifact-panel-width') ?? '0', 10),
  )
  expect(persistedWidth).toBeGreaterThan(0)
  expect(Math.abs(persistedWidth - widthAfterDrag)).toBeLessThan(8)

  // Reload and confirm the panel comes back at roughly the persisted width.
  await launched.page.reload()
  await launched.page.getByRole('button', { name: 'New conversation' }).click()
  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    title: 'Hello artifact',
    path: artifactPath,
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })
  const reloadedPanel = launched.page.getByTestId('artifact-panel')
  await expect(reloadedPanel).toBeVisible()
  const restoredBox = await reloadedPanel.boundingBox()
  expect(restoredBox).not.toBeNull()
  expect(Math.abs(restoredBox!.width - widthAfterDrag)).toBeLessThan(16)
})

test('fullscreen toggle hides sidebar and chat, ESC restores them', async ({}, testInfo) => {
  launched = await launchTestApp(testInfo)
  await completeOnboarding(launched.page)

  const artifactPath = await makeArtifactFile(1, ARTIFACT_HTML_V1)

  await setRpcOverride(launched.page, 'artifacts/list', { ok: true, result: { artifacts: [] } })
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: ARTIFACT_HTML_V1,
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 1,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: artifactPath,
        bytes: 80,
        createdAt: '2026-04-26T00:00:00Z',
      },
    },
  })
  await setRpcOverride(launched.page, 'session/new', {
    ok: true,
    result: { sessionId: SESSION_ID },
  })

  await launched.page.getByRole('button', { name: 'New conversation' }).click()
  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    title: 'Hello artifact',
    path: artifactPath,
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })

  await expect(launched.page.getByTestId('artifact-panel')).toBeVisible()
  const sidebar = launched.page.getByText('Sessions', { exact: true })
  await expect(sidebar).toBeVisible()

  const toggle = launched.page.getByTestId('artifact-fullscreen-toggle')
  await expect(toggle).toBeVisible()
  await toggle.click()

  await expect(sidebar).toBeHidden()
  // The InputBar is part of the chat column — it should be gone too.
  await expect(launched.page.getByPlaceholder(/Message/i)).toBeHidden()

  const fsBox = await launched.page.getByTestId('artifact-panel').boundingBox()
  const viewport = launched.page.viewportSize()
  if (fsBox && viewport) {
    expect(fsBox.width).toBeGreaterThan(viewport.width * 0.7)
  }

  // Esc exits fullscreen.
  await launched.page.keyboard.press('Escape')
  await expect(sidebar).toBeVisible()
  await expect(launched.page.getByPlaceholder(/Message/i)).toBeVisible()
})

test('download artifact writes HTML to chosen path', async ({}, testInfo) => {
  const runtime = await mkdtemp(path.join(tmpdir(), 'ouroboros-artifact-save-'))
  const savePath = path.join(runtime, 'hello-artifact.html')

  launched = await launchTestApp(testInfo, {
    dialogResponses: [savePath],
  })
  await completeOnboarding(launched.page)

  const artifactPath = await makeArtifactFile(1, ARTIFACT_HTML_V1)

  await setRpcOverride(launched.page, 'artifacts/list', { ok: true, result: { artifacts: [] } })
  await setRpcOverride(launched.page, 'artifacts/read', {
    ok: true,
    result: {
      html: ARTIFACT_HTML_V1,
      artifact: {
        artifactId: ARTIFACT_ID,
        version: 1,
        sessionId: SESSION_ID,
        title: 'Hello artifact',
        path: artifactPath,
        bytes: 80,
        createdAt: '2026-04-26T00:00:00Z',
      },
    },
  })
  await setRpcOverride(launched.page, 'session/new', {
    ok: true,
    result: { sessionId: SESSION_ID },
  })

  await launched.page.getByRole('button', { name: 'New conversation' }).click()
  await emitNotification(launched.page, 'agent/artifactCreated', {
    sessionId: SESSION_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    title: 'Hello artifact',
    path: artifactPath,
    bytes: 80,
    createdAt: '2026-04-26T00:00:00Z',
  })

  await expect(launched.page.getByTestId('artifact-panel')).toBeVisible()
  await launched.page.getByTestId('artifact-download').click()

  await expect(launched.page.getByTestId('artifact-save-status')).toHaveText('Saved')

  const written = await readFile(savePath, 'utf8')
  expect(written).toBe(ARTIFACT_HTML_V1)
})
