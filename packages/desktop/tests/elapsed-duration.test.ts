import { describe, expect, test } from 'bun:test'
import { elapsedDurationMs } from '../src/renderer/hooks/useElapsedDuration'

describe('streaming response duration', () => {
  const now = Date.parse('2026-10-19T06:10:00.000Z')

  test('uses the response start time, including after remounting a long-running turn', () => {
    expect(elapsedDurationMs('2026-10-19T06:02:05.772Z', now)).toBe(474_228)
    expect(elapsedDurationMs('2026-10-19T06:02:05.772Z', now + 1000)).toBe(475_228)
  })

  test('resets to the new turn start and clamps clock skew to zero', () => {
    expect(elapsedDurationMs('2026-10-19T06:09:59.000Z', now)).toBe(1000)
    expect(elapsedDurationMs('2026-10-19T06:10:01.000Z', now)).toBe(0)
  })

  test('omits a duration when the response has no valid start time', () => {
    for (const startedAt of [null, undefined, '', 'invalid']) {
      expect(elapsedDurationMs(startedAt, now)).toBeNull()
    }
  })
})
