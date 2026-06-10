import { beforeEach, describe, expect, test } from 'bun:test'
import {
  addSandboxUnavailableNotice,
  addSandboxViolationNotice,
  clearSandboxNotices,
  dismissSandboxNotice,
  getSandboxNoticesSnapshot,
} from '../src/renderer/stores/sandboxNoticeStore'

describe('sandboxNoticeStore', () => {
  beforeEach(() => {
    clearSandboxNotices()
  })

  test('violation notices accumulate with distinct ids', () => {
    addSandboxViolationNotice({
      sessionId: null,
      toolName: 'bash',
      commandSummary: 'touch /denied/a',
      indicator: 'file-write denial reported by the OS sandbox',
      cwd: '/tmp',
      platform: 'darwin',
    })
    addSandboxViolationNotice({
      sessionId: null,
      toolName: 'code-exec',
      commandSummary: 'bun run main.ts',
      cwd: '/tmp',
      platform: 'darwin',
    })

    const notices = getSandboxNoticesSnapshot()
    expect(notices).toHaveLength(2)
    expect(notices[0]!.kind).toBe('violation')
    expect(notices[0]!.toolName).toBe('bash')
    expect(notices[0]!.commandSummary).toBe('touch /denied/a')
    expect(notices[0]!.indicator).toBe('file-write denial reported by the OS sandbox')
    expect(notices[1]!.toolName).toBe('code-exec')
    expect(notices[0]!.id).not.toBe(notices[1]!.id)
  })

  test('unavailable notices are deduped to one per store lifetime', () => {
    addSandboxUnavailableNotice({ sessionId: null, reason: 'ripgrep missing', platform: 'darwin' })
    addSandboxUnavailableNotice({ sessionId: null, reason: 'ripgrep missing', platform: 'darwin' })

    let notices = getSandboxNoticesSnapshot()
    expect(notices.filter((notice) => notice.kind === 'unavailable')).toHaveLength(1)
    expect(notices[0]!.reason).toBe('ripgrep missing')

    // Even after dismissal the warn-once semantics hold: a CLI restart would
    // otherwise re-toast the same condition mid-session.
    dismissSandboxNotice(notices[0]!.id)
    addSandboxUnavailableNotice({ sessionId: null, reason: 'ripgrep missing', platform: 'darwin' })
    notices = getSandboxNoticesSnapshot()
    expect(notices).toHaveLength(0)
  })

  test('dismiss removes only the targeted notice', () => {
    addSandboxViolationNotice({
      sessionId: null,
      toolName: 'bash',
      commandSummary: 'touch /denied/a',
      cwd: '/tmp',
      platform: 'linux',
    })
    addSandboxUnavailableNotice({ sessionId: null, reason: 'bwrap missing', platform: 'linux' })

    let notices = getSandboxNoticesSnapshot()
    expect(notices).toHaveLength(2)

    dismissSandboxNotice(notices[0]!.id)
    notices = getSandboxNoticesSnapshot()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.kind).toBe('unavailable')
  })

  test('clear resets notices and the unavailable dedupe flag', () => {
    addSandboxUnavailableNotice({ sessionId: null, reason: 'first', platform: 'darwin' })
    clearSandboxNotices()
    expect(getSandboxNoticesSnapshot()).toHaveLength(0)

    addSandboxUnavailableNotice({ sessionId: null, reason: 'second', platform: 'darwin' })
    const notices = getSandboxNoticesSnapshot()
    expect(notices).toHaveLength(1)
    expect(notices[0]!.reason).toBe('second')
  })
})
