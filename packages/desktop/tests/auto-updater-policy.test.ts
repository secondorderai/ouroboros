import { describe, expect, test } from 'bun:test'
import {
  UPDATE_CHECK_INTERVAL_MS,
  formatUpdaterErrorMessage,
  normalizeUpdateMode,
  shouldCheckForUpdatesOnLaunch,
  shouldRunRealUpdater,
} from '../src/main/auto-updater-policy'

describe('macOS auto-updater policy', () => {
  const now = 1_700_000_000_000

  test('runs real updater only for packaged macOS builds without disable override', () => {
    expect(
      shouldRunRealUpdater({
        platform: 'darwin',
        isPackaged: true,
        disabledByEnv: false,
      }),
    ).toBe(true)

    expect(
      shouldRunRealUpdater({
        platform: 'win32',
        isPackaged: true,
        disabledByEnv: false,
      }),
    ).toBe(false)

    expect(
      shouldRunRealUpdater({
        platform: 'darwin',
        isPackaged: false,
        disabledByEnv: false,
      }),
    ).toBe(false)

    expect(
      shouldRunRealUpdater({
        platform: 'darwin',
        isPackaged: true,
        disabledByEnv: true,
      }),
    ).toBe(false)
  })

  test('auto mode checks once per 24 hours on packaged macOS', () => {
    expect(
      shouldCheckForUpdatesOnLaunch({
        mode: 'auto',
        platform: 'darwin',
        isPackaged: true,
        disabledByEnv: false,
        lastUpdateCheck: now - UPDATE_CHECK_INTERVAL_MS,
        now,
      }),
    ).toBe(true)

    expect(
      shouldCheckForUpdatesOnLaunch({
        mode: 'auto',
        platform: 'darwin',
        isPackaged: true,
        disabledByEnv: false,
        lastUpdateCheck: now - UPDATE_CHECK_INTERVAL_MS + 1,
        now,
      }),
    ).toBe(false)
  })

  test('manual and off modes skip launch checks', () => {
    for (const mode of ['manual', 'off'] as const) {
      expect(
        shouldCheckForUpdatesOnLaunch({
          mode,
          platform: 'darwin',
          isPackaged: true,
          disabledByEnv: false,
          lastUpdateCheck: 0,
          now,
        }),
      ).toBe(false)
    }
  })

  test('invalid stored mode falls back to auto', () => {
    expect(normalizeUpdateMode('manual')).toBe('manual')
    expect(normalizeUpdateMode('off')).toBe('off')
    expect(normalizeUpdateMode('unexpected')).toBe('auto')
  })

  test('formats private GitHub release feed failures into actionable copy', () => {
    const message = formatUpdaterErrorMessage(
      new Error(
        '404 "method: GET url: https://github.com/secondorderai/ouroboros/releases.atom\\n\\nPlease double check that your authentication token is correct." Headers: { "set-cookie": ["secret"] }',
      ),
    )

    expect(message).toContain('Could not access GitHub release metadata')
    expect(message).toContain('private or unreachable')
    expect(message).not.toContain('set-cookie')
  })

  test('formats missing macOS metadata failures into artifact guidance', () => {
    const message = formatUpdaterErrorMessage(
      new Error('404 "method: GET url: https://example.com/latest-mac.yml"'),
    )

    expect(message).toContain('latest-mac.yml')
    expect(message).toContain('macOS zip')
  })
})
