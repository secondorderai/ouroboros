/**
 * srt backend — thin adapter over `@anthropic-ai/sandbox-runtime` (the
 * extracted Claude Code sandbox: sandbox-exec/Seatbelt on macOS,
 * bubblewrap + seccomp on Linux, proxy-based network domain filtering).
 *
 * The PR0 spike verified the library backend works under Bun and inside
 * `bun build --compile` binaries, so the library (not the `srt` CLI binary)
 * is the chosen backend. All srt touch-points stay confined to this file so
 * the backend remains swappable behind the `SandboxBackend` interface.
 */

import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { SandboxPolicy } from './policy'
import type { SandboxBackend, SpawnSpec } from './sandbox'

function toRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: policy.network.allowedDomains,
      deniedDomains: policy.network.deniedDomains,
      ...(policy.network.allowLocalBinding !== undefined
        ? { allowLocalBinding: policy.network.allowLocalBinding }
        : {}),
    },
    filesystem: {
      denyRead: policy.filesystem.denyRead,
      allowWrite: policy.filesystem.allowWrite,
      denyWrite: policy.filesystem.denyWrite,
    },
  }
}

export function createSrtBackend(): SandboxBackend {
  return {
    checkDependencies(): { errors: string[]; warnings: string[] } {
      try {
        const result = SandboxManager.checkDependencies()
        return { errors: [...result.errors], warnings: [...result.warnings] }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return { errors: [`sandbox dependency check failed: ${message}`], warnings: [] }
      }
    },

    async initialize(policy: SandboxPolicy): Promise<void> {
      // enableLogMonitor=true wires up the Seatbelt violation store that
      // powers annotateStderrWithSandboxFailures (classifier corroboration).
      await SandboxManager.initialize(toRuntimeConfig(policy), undefined, true)
    },

    async wrapCommand(command: string): Promise<SpawnSpec> {
      const wrapped = await SandboxManager.wrapWithSandbox(command)
      return { command: 'sh', args: ['-c', wrapped] }
    },

    annotateStderr(command: string, stderr: string): string {
      try {
        return SandboxManager.annotateStderrWithSandboxFailures(command, stderr)
      } catch {
        return stderr
      }
    },

    completeCommand(): void {
      // srt's per-command contract: removes the empty placeholder files
      // bwrap creates on the host for non-existent deny paths (Linux) and
      // decrements the active-sandbox count. No-op on macOS.
      SandboxManager.cleanupAfterCommand()
    },

    async reset(): Promise<void> {
      await SandboxManager.reset()
    },
  }
}
