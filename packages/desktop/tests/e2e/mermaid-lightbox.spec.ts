import { expect, test } from '@playwright/test'
import type { LaunchedApp } from './helpers'
import { completeOnboarding, launchTestApp } from './helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

// Regression test for a lightbox layout bug where the expanded Mermaid diagram
// was clipped on the left at fit zoom and whose bottom became unreachable when
// zoomed in. Both symptoms stemmed from `.mermaid-lightbox__diagram-frame`
// being laid out at unscaled dimensions while its visual content was CSS
// transform-scaled from top-left. Flex centering on `.mermaid-lightbox__canvas`
// used the unscaled layout box, so the scaled visual ended up offset relative
// to the container (negative x at fit, positive overflow when zoomed in).
// The frame's layout must match its visual (scaled) dimensions for flex
// centering and body overflow scrolling to behave correctly.

test('mermaid lightbox shows the diagram fully at fit and scrolls fully when zoomed', async ({}, testInfo) => {
  const historicalTimestamp = new Date().toISOString()
  const mermaidContent = [
    'Here is a diagram:',
    '',
    '```mermaid',
    'graph LR',
    '    A[Very long leftmost node label] --> B[Node Bravo]',
    '    B --> C[Node Charlie]',
    '    C --> D[Node Delta]',
    '    D --> E[Node Echo]',
    '    E --> F[Node Foxtrot]',
    '    F --> G[Node Golf]',
    '    G --> H[Node Hotel]',
    '    H --> I[Very long rightmost node label]',
    '```',
  ].join('\n')

  launched = await launchTestApp(testInfo, {
    scenario: {
      sessions: [
        {
          id: 'mermaid-session',
          createdAt: historicalTimestamp,
          lastActive: historicalTimestamp,
          title: 'Mermaid preview',
          messages: [
            { role: 'user', content: 'Show me a diagram', timestamp: historicalTimestamp },
            { role: 'assistant', content: mermaidContent, timestamp: historicalTimestamp },
          ],
        },
      ],
    },
  })

  await completeOnboarding(launched.page)
  await launched.page.getByLabel('Session: Mermaid preview').click()

  const inlineDiagram = launched.page.locator('.mermaid-diagram__svg-shell svg').first()
  await expect(inlineDiagram).toBeVisible({ timeout: 15_000 })

  await launched.page.getByRole('button', { name: 'Open full-size diagram' }).first().click()

  const dialog = launched.page.getByRole('dialog', { name: 'Expanded Mermaid diagram' })
  await expect(dialog).toBeVisible()

  // Give the fit-scale effect a moment to measure the body and apply scale.
  await launched.page.waitForTimeout(250)

  const fitBounds = await launched.page.evaluate(() => {
    const body = document.querySelector('.mermaid-lightbox__body') as HTMLElement | null
    const frame = document.querySelector('.mermaid-lightbox__diagram-frame') as HTMLElement | null
    if (!body || !frame) return null
    const bb = body.getBoundingClientRect()
    const fb = frame.getBoundingClientRect()
    return {
      bodyLeft: bb.left,
      bodyRight: bb.right,
      frameLeft: fb.left,
      frameRight: fb.right,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      frameWidth: fb.width,
      frameHeight: fb.height,
    }
  })

  expect(fitBounds).not.toBeNull()
  if (!fitBounds) throw new Error('unreachable')
  // Fit mode: frame must be entirely inside the body's visible bounds (no clipping).
  expect(fitBounds.frameLeft).toBeGreaterThanOrEqual(fitBounds.bodyLeft - 1)
  expect(fitBounds.frameRight).toBeLessThanOrEqual(fitBounds.bodyRight + 1)
  // And the body should not need horizontal scroll in fit mode.
  expect(fitBounds.bodyScrollWidth).toBeLessThanOrEqual(fitBounds.bodyClientWidth + 2)

  // Zoom in until the diagram exceeds the body both horizontally and vertically.
  const zoomInButton = launched.page.getByRole('button', { name: 'Zoom in' })
  for (let i = 0; i < 8; i++) {
    await zoomInButton.click()
  }
  await launched.page.waitForTimeout(150)

  const zoomedDims = await launched.page.evaluate(() => {
    const body = document.querySelector('.mermaid-lightbox__body') as HTMLElement | null
    const frame = document.querySelector('.mermaid-lightbox__diagram-frame') as HTMLElement | null
    if (!body || !frame) return null
    return {
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      frameHeight: frame.getBoundingClientRect().height,
    }
  })
  expect(zoomedDims).not.toBeNull()
  if (!zoomedDims) throw new Error('unreachable')
  // When zoomed in, the body should expose scrollable overflow that covers the
  // full frame height (plus body padding). Before the fix the scrollHeight
  // equalled the canvas layout box, which was smaller than the transformed
  // visual, making the bottom of the diagram unreachable.
  expect(zoomedDims.bodyScrollHeight).toBeGreaterThanOrEqual(zoomedDims.frameHeight)

  // Scroll to the very bottom and verify the frame's bottom edge is now inside
  // the body's visible viewport.
  await launched.page.evaluate(() => {
    const body = document.querySelector('.mermaid-lightbox__body') as HTMLElement | null
    if (body) body.scrollTop = body.scrollHeight
  })
  await launched.page.waitForTimeout(100)

  const bottomReach = await launched.page.evaluate(() => {
    const body = document.querySelector('.mermaid-lightbox__body') as HTMLElement | null
    const frame = document.querySelector('.mermaid-lightbox__diagram-frame') as HTMLElement | null
    if (!body || !frame) return null
    const bb = body.getBoundingClientRect()
    const fb = frame.getBoundingClientRect()
    return {
      bodyBottom: bb.bottom,
      frameBottom: fb.bottom,
    }
  })
  expect(bottomReach).not.toBeNull()
  if (!bottomReach) throw new Error('unreachable')
  // The frame's bottom edge should now be within the body's viewport (<= bodyBottom + small tolerance).
  expect(bottomReach.frameBottom).toBeLessThanOrEqual(bottomReach.bodyBottom + 2)
})
