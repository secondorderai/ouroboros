/**
 * Real-sandbox integration tests (no fake backend).
 *
 * Platform-gated: only runs on macOS with the sandbox primitives present
 * (`sandbox-exec` + ripgrep). Exercises the real srt library backend under
 * Bun: kernel-enforced write denials, the denyWrite RSI gate over skills/,
 * the [sandbox] escalation marker, and the approved-bypass path.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSchema } from '@src/config'
import { getSandboxStatus, initializeSandbox, resetSandbox } from '@src/safety/sandbox'
import { execute as bashExecute, schema as bashSchema } from '@src/tools/bash'
import { execute as codeExecExecute, schema as codeExecSchema } from '@src/tools/code-exec'

const SANDBOX_AVAILABLE =
  process.platform === 'darwin' && Bun.which('sandbox-exec') !== null && Bun.which('rg') !== null

const TEST_TIMEOUT = 60_000

describe.skipIf(!SANDBOX_AVAILABLE)('OS sandbox integration (real srt backend)', () => {
  let workspace: string
  let skillsDir: string
  const canaryPaths: string[] = []

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'ouroboros-sandbox-int-'))
    skillsDir = join(workspace, 'skills', 'core')
    mkdirSync(skillsDir, { recursive: true })

    const status = await initializeSandbox(configSchema.parse({}), {
      configDir: workspace,
      cwd: workspace,
    })
    expect(status.mode).toBe('enforcing')
  })

  afterAll(async () => {
    await resetSandbox()
    rmSync(workspace, { recursive: true, force: true })
    for (const canary of canaryPaths) {
      try {
        unlinkSync(canary)
      } catch {
        // Already absent — the denial worked.
      }
    }
  })

  test(
    'writes inside cwd succeed under the sandbox',
    async () => {
      const target = join(workspace, 'allowed.txt')
      const result = await bashExecute(
        bashSchema.parse({ command: `touch ${target}`, cwd: workspace, timeout: 30 }),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.exitCode).toBe(0)
      expect(existsSync(target)).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    'writes outside allowWrite are kernel-denied with the [sandbox] marker',
    async () => {
      const canary = join(homedir(), `ouroboros-sandbox-canary-${process.pid}`)
      canaryPaths.push(canary)

      const result = await bashExecute(
        bashSchema.parse({ command: `touch ${canary}`, cwd: workspace, timeout: 30 }),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.exitCode).not.toBe(0)
      expect(result.value.stderr).toContain('[sandbox]')
      expect(result.value.stderr).toContain('bypassSandbox: true')
      expect(existsSync(canary)).toBe(false)
    },
    TEST_TIMEOUT,
  )

  test(
    'RSI-gate regression: bash cannot write into a configured skills directory',
    async () => {
      const forged = join(skillsDir, 'pwned.md')
      const result = await bashExecute(
        bashSchema.parse({ command: `echo x > ${forged}`, cwd: workspace, timeout: 30 }),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // denyWrite overrides the cwd allowWrite root — the kernel-enforced
      // tier-3 self-modification gate.
      expect(result.value.exitCode).not.toBe(0)
      expect(result.value.stderr).toContain('[sandbox]')
      expect(existsSync(forged)).toBe(false)
    },
    TEST_TIMEOUT,
  )

  test(
    'code-exec can write its temp workdir under the sandbox',
    async () => {
      const result = await codeExecExecute(
        codeExecSchema.parse({
          code: 'await Bun.write("out.txt", "hi"); console.log("workdir-write-ok")',
          timeout: 30,
        }),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.exitCode).toBe(0)
      expect(result.value.stdout).toContain('workdir-write-ok')
    },
    TEST_TIMEOUT,
  )

  test(
    'bypassSandbox: true runs unwrapped and can write outside allowWrite',
    async () => {
      const canary = join(homedir(), `ouroboros-sandbox-bypass-${process.pid}`)
      canaryPaths.push(canary)

      const result = await bashExecute(
        bashSchema.parse({
          command: `touch ${canary}`,
          cwd: workspace,
          timeout: 30,
          bypassSandbox: true,
        }),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.exitCode).toBe(0)
      expect(existsSync(canary)).toBe(true)
      expect(getSandboxStatus().mode).toBe('enforcing')
    },
    TEST_TIMEOUT,
  )
})
