import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { configSchema, type OuroborosConfig } from '@src/config'
import { buildSandboxPolicy, safeRealpath, DEFAULT_ALLOWED_DOMAINS } from '@src/safety/policy'
import {
  addSandboxWriteRoot,
  classifySandboxFailure,
  consumeUnavailableWarning,
  getSandboxStatus,
  initializeSandbox,
  notifySandboxedCommandComplete,
  reinitializeSandbox,
  resetSandbox,
  setSandboxBackendForTesting,
  wrapCommand,
} from '@src/safety/sandbox'
import { makeFakeBackend } from './fake-sandbox-backend'

function makeConfig(sandbox?: Record<string, unknown>): OuroborosConfig {
  return configSchema.parse(sandbox ? { sandbox } : {})
}

describe('sandbox facade', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ouroboros-sandbox-facade-'))
  })

  afterEach(async () => {
    setSandboxBackendForTesting(null)
    await resetSandbox()
    rmSync(workDir, { recursive: true, force: true })
  })

  function initOptions() {
    return { configDir: workDir, cwd: workDir }
  }

  test('wrapCommand is a passthrough before any initialization', async () => {
    expect(getSandboxStatus().mode).toBe('uninitialized')

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(false)
    expect(result.value.spec).toEqual({ command: 'sh', args: ['-c', 'echo hi'] })
  })

  test('wrapCommand is a passthrough when sandbox.enabled is false', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)

    const status = await initializeSandbox(makeConfig({ enabled: false }), initOptions())
    expect(status.mode).toBe('disabled')

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(false)
    expect(backend.wrappedCommands).toEqual([])
    // A disabled sandbox is not "unavailable" — no warn-once note.
    expect(consumeUnavailableWarning()).toBe(false)
  })

  test('dependency errors degrade to unavailable with passthrough', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['ripgrep not found'] }))

    const status = await initializeSandbox(makeConfig(), initOptions())
    expect(status.mode).toBe('unavailable')
    expect(status.reason).toContain('ripgrep not found')

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(false)
  })

  test('initialize failures degrade to unavailable, never throw', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ failInitialize: true }))

    const status = await initializeSandbox(makeConfig(), initOptions())
    expect(status.mode).toBe('unavailable')
    expect(status.reason).toContain('fake backend initialize failure')
  })

  test('consumeUnavailableWarning fires exactly once per process', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ dependencyErrors: ['no sandbox-exec'] }))
    await initializeSandbox(makeConfig(), initOptions())

    expect(consumeUnavailableWarning()).toBe(true)
    expect(consumeUnavailableWarning()).toBe(false)

    // Still consumed after another unavailable re-init.
    await initializeSandbox(makeConfig(), initOptions())
    expect(consumeUnavailableWarning()).toBe(false)
  })

  test('enforcing mode wraps commands through the backend', async () => {
    const backend = makeFakeBackend({
      wrap: (command) => ({ command: 'sh', args: ['-c', `wrapped: ${command}`] }),
    })
    setSandboxBackendForTesting(backend)

    const status = await initializeSandbox(makeConfig(), initOptions())
    expect(status.mode).toBe('enforcing')

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(true)
    expect(result.value.spec.args[1]).toBe('wrapped: echo hi')
    expect(backend.wrappedCommands).toEqual(['echo hi'])
  })

  test('a wrap failure degrades to unavailable and passes the command through', async () => {
    setSandboxBackendForTesting(makeFakeBackend({ failWrap: true }))
    await initializeSandbox(makeConfig(), initOptions())
    expect(getSandboxStatus().mode).toBe('enforcing')

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(false)
    expect(getSandboxStatus().mode).toBe('unavailable')
    expect(getSandboxStatus().reason).toContain('fake backend wrap failure')
    expect(consumeUnavailableWarning()).toBe(true)
  })

  test('addSandboxWriteRoot re-initializes with the accumulated root', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())
    expect(backend.initializedPolicies).toHaveLength(1)

    const worktree = join(workDir, 'worktrees', 'task-1')
    mkdirSync(worktree, { recursive: true })
    const status = await addSandboxWriteRoot(worktree)
    expect(status.mode).toBe('enforcing')

    expect(backend.initializedPolicies).toHaveLength(2)
    const latest = backend.initializedPolicies[1]!
    expect(latest.filesystem.allowWrite).toContain(realpathSync(worktree))

    // Adding the same root twice is a no-op (no third re-init).
    await addSandboxWriteRoot(worktree)
    expect(backend.initializedPolicies).toHaveLength(2)
  })

  test('addSandboxWriteRoot is a no-op before initialization', async () => {
    const status = await addSandboxWriteRoot(join(workDir, 'never-initialized'))
    expect(status.mode).toBe('uninitialized')
  })

  test('reinitializeSandbox applies new config (live disable)', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())
    expect(getSandboxStatus().mode).toBe('enforcing')

    const status = await reinitializeSandbox(makeConfig({ enabled: false }), initOptions())
    expect(status.mode).toBe('disabled')
    expect(backend.resetCount).toBeGreaterThanOrEqual(1)

    const result = await wrapCommand('echo hi')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sandboxed).toBe(false)
  })

  test('reinitializeSandbox preserves runtime write roots added via addSandboxWriteRoot', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())

    const worktree = join(workDir, 'worktrees', 'live-worker')
    mkdirSync(worktree, { recursive: true })
    await addSandboxWriteRoot(worktree)

    // The server's re-init hooks (config/set, workspace/set, workspace/clear)
    // call reinitializeSandbox with NO extraWriteRoots while workers may
    // still be running — their worktree roots must survive the re-anchor.
    const status = await reinitializeSandbox(makeConfig(), initOptions())
    expect(status.mode).toBe('enforcing')

    const latest = backend.initializedPolicies.at(-1)!
    expect(latest.filesystem.allowWrite).toContain(realpathSync(worktree))
  })

  test('initializeSandbox (fresh init) starts from a clean write-root slate', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())

    const worktree = join(workDir, 'worktrees', 'stale-worker')
    mkdirSync(worktree, { recursive: true })
    await addSandboxWriteRoot(worktree)

    await initializeSandbox(makeConfig(), initOptions())
    const latest = backend.initializedPolicies.at(-1)!
    expect(latest.filesystem.allowWrite).not.toContain(realpathSync(worktree))
  })

  test('concurrent addSandboxWriteRoot calls keep both roots', async () => {
    const backend = makeFakeBackend()
    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())

    const rootA = join(workDir, 'worktrees', 'worker-a')
    const rootB = join(workDir, 'worktrees', 'worker-b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })

    // Two spawn-agent tool calls in one assistant step race via Promise.all;
    // neither worker's worktree may be dropped from the final policy.
    await Promise.all([addSandboxWriteRoot(rootA), addSandboxWriteRoot(rootB)])

    const latest = backend.initializedPolicies.at(-1)!
    expect(latest.filesystem.allowWrite).toContain(realpathSync(rootA))
    expect(latest.filesystem.allowWrite).toContain(realpathSync(rootB))
  })

  test('concurrent (re)initializations are serialized — backend init never overlaps', async () => {
    let active = 0
    let maxActive = 0
    const backend = makeFakeBackend({
      onInitialize: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(5)
        active -= 1
      },
    })
    setSandboxBackendForTesting(backend)

    await Promise.all([
      initializeSandbox(makeConfig(), initOptions()),
      initializeSandbox(makeConfig(), initOptions()),
      reinitializeSandbox(makeConfig(), initOptions()),
    ])

    expect(maxActive).toBe(1)
    expect(getSandboxStatus().mode).toBe('enforcing')
  })

  test('wrapCommand queues behind an in-flight re-initialization (fail-closed)', async () => {
    const first = makeFakeBackend()
    setSandboxBackendForTesting(first)
    await initializeSandbox(makeConfig(), initOptions())
    expect(getSandboxStatus().mode).toBe('enforcing')

    let releaseInit!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseInit = resolve
    })
    const second = makeFakeBackend({ onInitialize: () => gate })
    setSandboxBackendForTesting(second)

    const reinit = reinitializeSandbox(makeConfig(), initOptions())
    // Let the re-init reach the gated backend.initialize().
    await Bun.sleep(10)

    // Mid-re-init the facade must NOT claim to be enforcing (the old
    // backend is torn down and the new one is not ready)...
    expect(getSandboxStatus().mode).toBe('uninitialized')

    // ...and a concurrent command must wait for the new backend instead of
    // silently passing through unsandboxed.
    let settled = false
    const pendingWrap = wrapCommand('echo hi').then((result) => {
      settled = true
      return result
    })
    await Bun.sleep(20)
    expect(settled).toBe(false)

    releaseInit()
    await reinit
    const wrapped = await pendingWrap
    expect(wrapped.ok).toBe(true)
    if (!wrapped.ok) return
    expect(wrapped.value.sandboxed).toBe(true)
    expect(second.wrappedCommands).toEqual(['echo hi'])
  })

  test('notifySandboxedCommandComplete forwards to the backend only when one is active', async () => {
    const backend = makeFakeBackend()
    // No backend yet: must be a silent no-op.
    notifySandboxedCommandComplete()
    expect(backend.completedCommands).toBe(0)

    setSandboxBackendForTesting(backend)
    await initializeSandbox(makeConfig(), initOptions())
    notifySandboxedCommandComplete()
    notifySandboxedCommandComplete()
    expect(backend.completedCommands).toBe(2)
  })
})

describe('classifySandboxFailure', () => {
  describe('macOS signatures', () => {
    test('flags "Operation not permitted" filesystem denials', () => {
      const result = classifySandboxFailure({
        exitCode: 1,
        stderr: 'touch: /Users/henry/srt-spike-denied-73459.txt: Operation not permitted\n',
        platform: 'darwin',
      })
      expect(result.likelyViolation).toBe(true)
      expect(result.indicator).toContain('Operation not permitted')
    })

    test('flags shell-redirection and mkdir denial variants', () => {
      expect(
        classifySandboxFailure({
          exitCode: 1,
          stderr: '/bin/bash: /Users/henry/srt-spike-redirect.txt: Operation not permitted\n',
          platform: 'darwin',
        }).likelyViolation,
      ).toBe(true)
      expect(
        classifySandboxFailure({
          exitCode: 1,
          stderr: 'mkdir: /Users/henry/srt-spike-dir: Operation not permitted\n',
          platform: 'darwin',
        }).likelyViolation,
      ).toBe(true)
    })

    test('does not flag ordinary failures on darwin', () => {
      expect(
        classifySandboxFailure({
          exitCode: 1,
          stderr: 'cat: /nope: No such file or directory\n',
          platform: 'darwin',
        }).likelyViolation,
      ).toBe(false)
      // Plain "Permission denied" is an ordinary unix error on darwin, not a
      // seatbelt denial shape.
      expect(
        classifySandboxFailure({
          exitCode: 1,
          stderr: 'sh: /etc/secret: Permission denied\n',
          platform: 'darwin',
        }).likelyViolation,
      ).toBe(false)
    })
  })

  describe('Linux signatures', () => {
    test('flags bwrap, EACCES, read-only, and permission-denied shapes', () => {
      for (const stderr of [
        'bwrap: Could not bind mount /x: Permission denied\n',
        'Error: EACCES: permission denied, open /denied/file\n',
        'touch: cannot touch /denied/file: Read-only file system\n',
        'touch: cannot touch /denied/file: Permission denied\n',
      ]) {
        expect(
          classifySandboxFailure({ exitCode: 1, stderr, platform: 'linux' }).likelyViolation,
        ).toBe(true)
      }
    })

    test('does not flag ordinary failures on linux', () => {
      expect(
        classifySandboxFailure({
          exitCode: 2,
          stderr: 'ls: cannot access /nope: No such file or directory\n',
          platform: 'linux',
        }).likelyViolation,
      ).toBe(false)
    })
  })

  describe('proxy-shaped network denials (both platforms)', () => {
    test('flags HTTPS CONNECT 403 rejections', () => {
      const result = classifySandboxFailure({
        exitCode: 56,
        stderr: 'curl: (56) CONNECT tunnel failed, response 403\n',
        platform: 'darwin',
      })
      expect(result.likelyViolation).toBe(true)
      expect(result.indicator).toContain('CONNECT')
    })

    test('flags plain-HTTP 403 (curl -f) rejections', () => {
      expect(
        classifySandboxFailure({
          exitCode: 22,
          stderr: 'curl: (22) The requested URL returned error: 403\n',
          platform: 'linux',
        }).likelyViolation,
      ).toBe(true)
    })
  })

  describe('seatbelt log-monitor corroboration block', () => {
    test('flags file-write denial lines', () => {
      const stderr =
        'boom\n<sandbox_violations>\ntouch(123) deny(1) file-write-create /Users/henry/x.txt\n</sandbox_violations>'
      const result = classifySandboxFailure({ exitCode: 1, stderr, platform: 'darwin' })
      expect(result.likelyViolation).toBe(true)
      expect(result.indicator).toContain('file-write')
    })

    test('flags network denial lines', () => {
      const stderr =
        'boom\n<sandbox_violations>\ncurl(99) deny(1) network-outbound example.com:443\n</sandbox_violations>'
      expect(
        classifySandboxFailure({ exitCode: 1, stderr, platform: 'darwin' }).likelyViolation,
      ).toBe(true)
    })

    test('ignores sysctl-read and mach-lookup false-positive noise', () => {
      const stderr =
        'boom\n<sandbox_violations>\n' +
        'node(1) deny(1) sysctl-read kern.iossupportversion\n' +
        'node(1) deny(1) mach-lookup com.apple.SystemConfiguration.configd\n' +
        '</sandbox_violations>'
      expect(
        classifySandboxFailure({ exitCode: 1, stderr, platform: 'darwin' }).likelyViolation,
      ).toBe(false)
    })
  })

  test('exit code 0 is never a violation for plain-stderr heuristics', () => {
    expect(
      classifySandboxFailure({
        exitCode: 0,
        stderr: 'something: Operation not permitted\n',
        platform: 'darwin',
      }).likelyViolation,
    ).toBe(false)
  })
})

describe('buildSandboxPolicy', () => {
  let workDir: string
  let configDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ouroboros-sandbox-policy-cwd-'))
    configDir = mkdtempSync(join(tmpdir(), 'ouroboros-sandbox-policy-cfg-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  function policyFor(sandbox?: Record<string, unknown>, writeRoots?: string[]) {
    return buildSandboxPolicy(makeConfig(sandbox), { configDir, cwd: workDir, writeRoots })
  }

  test('allowWrite includes cwd, tmpdir, bun cache, and simple-session dir (realpathed)', () => {
    const policy = policyFor()
    expect(policy.filesystem.allowWrite).toContain(realpathSync(workDir))
    expect(policy.filesystem.allowWrite).toContain(realpathSync(tmpdir()))
    expect(policy.filesystem.allowWrite).toContain(safeRealpath(join(homedir(), '.bun')))
    expect(policy.filesystem.allowWrite).toContain(
      safeRealpath(join(configDir, '.ouroboros-simple-sessions')),
    )
  })

  test('denyWrite kernel-enforces the RSI gate: skills, memory, .ouroboros, transcript DB', () => {
    const policy = policyFor()
    // Relative skill dirs are denied under both anchors.
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(workDir, 'skills/core')))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(configDir, 'skills/core')))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(workDir, 'skills/generated')))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(workDir, 'memory')))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(configDir, 'memory')))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(configDir, '.ouroboros')))
    expect(policy.filesystem.denyWrite).toContain(
      safeRealpath(join(configDir, '.ouroboros-transcripts.db')),
    )
  })

  test('denyRead covers common credential stores', () => {
    const policy = policyFor()
    for (const path of ['.ssh', '.aws', '.gnupg', '.kube']) {
      expect(policy.filesystem.denyRead).toContain(safeRealpath(join(homedir(), path)))
    }
    expect(policy.filesystem.denyRead).toContain(safeRealpath(join(homedir(), '.config', 'gh')))
    expect(policy.filesystem.denyRead).toContain(
      safeRealpath(join(homedir(), '.docker', 'config.json')),
    )
  })

  test('denyRead covers plaintext token stores for allowed network destinations', () => {
    // ~/.git-credentials, ~/.netrc, and ~/.npmrc hold replayable tokens for
    // github.com / registry.npmjs.org — domains the default network policy
    // allows. A sandboxed child must not be able to read-and-exfiltrate them.
    const policy = policyFor()
    for (const path of ['.git-credentials', '.netrc', '.npmrc']) {
      expect(policy.filesystem.denyRead).toContain(safeRealpath(join(homedir(), path)))
    }
    expect(policy.filesystem.denyRead).toContain(
      safeRealpath(join(homedir(), '.config', 'git', 'credentials')),
    )
  })

  test('config extras and runtime write roots are merged in', () => {
    const extraDir = join(workDir, 'extra-writable')
    mkdirSync(extraDir, { recursive: true })
    const worktree = join(workDir, 'wt')
    mkdirSync(worktree, { recursive: true })

    const policy = policyFor(
      {
        filesystem: {
          allowWrite: [extraDir],
          denyWrite: ['protected-zone'],
          denyRead: ['secret-zone'],
        },
        network: {
          allowedDomains: ['example.com'],
          deniedDomains: ['evil.example'],
          allowLocalBinding: false,
        },
      },
      [worktree],
    )

    expect(policy.filesystem.allowWrite).toContain(realpathSync(extraDir))
    expect(policy.filesystem.allowWrite).toContain(realpathSync(worktree))
    expect(policy.filesystem.denyWrite).toContain(safeRealpath(join(workDir, 'protected-zone')))
    expect(policy.filesystem.denyRead).toContain(safeRealpath(join(workDir, 'secret-zone')))

    expect(policy.network.allowedDomains).toContain('example.com')
    for (const domain of DEFAULT_ALLOWED_DOMAINS) {
      expect(policy.network.allowedDomains).toContain(domain)
    }
    expect(policy.network.deniedDomains).toEqual(['evil.example'])
    expect(policy.network.allowLocalBinding).toBe(false)
  })

  test('allowLocalBinding defaults to true', () => {
    expect(policyFor().network.allowLocalBinding).toBe(true)
  })

  test('safeRealpath falls back to the nearest existing ancestor for missing paths', () => {
    const missing = join(workDir, 'does', 'not', 'exist')
    expect(safeRealpath(missing)).toBe(join(realpathSync(workDir), 'does', 'not', 'exist'))
  })
})
