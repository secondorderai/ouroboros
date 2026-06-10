/**
 * Sandbox policy builder.
 *
 * Pure translation from Ouroboros config + runtime anchors (configDir, cwd,
 * worker write roots) into the filesystem/network policy enforced by the OS
 * sandbox backend. Keeping this pure makes the policy unit-testable without
 * touching the sandbox runtime.
 *
 * The shape returned here is a structural subset of srt's
 * `SandboxRuntimeConfig` so all `@anthropic-ai/sandbox-runtime` imports stay
 * confined to `srt-backend.ts`.
 */

import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { OuroborosConfig } from '@src/config'

export interface SandboxPolicy {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowLocalBinding?: boolean
  }
  filesystem: {
    denyRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

export interface SandboxPolicyAnchors {
  /** Directory holding `.ouroboros`, `memory/`, the transcript DB, etc. */
  configDir: string
  /** Working directory commands run in by default. */
  cwd: string
  /** Extra runtime write roots (e.g. worker worktrees). */
  writeRoots?: string[]
}

/**
 * Domains required for the agent's default workflows (package installs,
 * git/github reads, the Anthropic API, bun tooling). Config
 * `sandbox.network.allowedDomains` entries are merged on top.
 */
export const DEFAULT_ALLOWED_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'api.anthropic.com',
  'bun.sh',
]

/** Credential stores no sandboxed child has any business reading. */
export const DEFAULT_DENY_READ_RELATIVE_TO_HOME = [
  '.ssh',
  '.aws',
  '.gnupg',
  join('.config', 'gh'),
  '.kube',
  join('.docker', 'config.json'),
  // Plaintext token stores for the very destinations the default network
  // policy allows (github.com, registry.npmjs.org): a sandboxed child must
  // not be able to read these and replay the credentials to allowed
  // endpoints. srt's built-in auto-blocks (shell rc, .gitconfig,
  // .git/hooks) do not cover them.
  '.git-credentials',
  join('.config', 'git', 'credentials'),
  '.netrc',
  '.npmrc',
]

/**
 * Resolve a path to its real (symlink-free) form. srt does NOT
 * realpath-resolve policy paths, while the kernel checks resolved paths —
 * e.g. allowWrite `/tmp` fails to permit `/private/tmp` writes on macOS.
 * Paths that do not (fully) exist fall back to the realpath of the nearest
 * existing ancestor plus the remaining segments.
 */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(safeRealpath(parent), basename(path))
  }
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths))
}

/**
 * Build the sandbox policy for the current process.
 *
 * - `allowWrite`: cwd, OS tmpdir (code-exec workdirs), the bun cache,
 *   simple-session workspaces, config extras, and runtime write roots.
 * - `denyWrite` (overrides allow — the kernel-enforced RSI gate): skill
 *   directories, memory directories, `.ouroboros` config, and the transcript
 *   DB. A tier-1 bash command can no longer forge skills/memory/config even
 *   though cwd (which may equal configDir in the desktop) is writable.
 * - `denyRead`: common credential stores.
 */
export function buildSandboxPolicy(
  config: OuroborosConfig,
  anchors: SandboxPolicyAnchors,
): SandboxPolicy {
  const { configDir, cwd, writeRoots = [] } = anchors
  const home = homedir()

  const allowWrite = [
    cwd,
    tmpdir(),
    join(home, '.bun'),
    join(configDir, '.ouroboros-simple-sessions'),
    ...config.sandbox.filesystem.allowWrite.map((path) => resolve(cwd, path)),
    ...writeRoots,
  ]

  // Relative skill directories are anchored at the agent basePath, which can
  // be either the workspace cwd or the config dir depending on the session —
  // deny both resolutions so the RSI gate holds for every anchor.
  const skillDirs = config.skillDirectories.flatMap((dir) =>
    isAbsolute(dir) ? [dir] : [resolve(cwd, dir), resolve(configDir, dir)],
  )

  const denyWrite = [
    ...skillDirs,
    join(configDir, 'memory'),
    join(cwd, 'memory'),
    join(configDir, '.ouroboros'),
    join(configDir, '.ouroboros-transcripts.db'),
    ...config.sandbox.filesystem.denyWrite.map((path) => resolve(cwd, path)),
  ]

  const denyRead = [
    ...DEFAULT_DENY_READ_RELATIVE_TO_HOME.map((path) => join(home, path)),
    ...config.sandbox.filesystem.denyRead.map((path) => resolve(cwd, path)),
  ]

  return {
    network: {
      allowedDomains: dedupe([
        ...DEFAULT_ALLOWED_DOMAINS,
        ...config.sandbox.network.allowedDomains,
      ]),
      deniedDomains: dedupe(config.sandbox.network.deniedDomains),
      allowLocalBinding: config.sandbox.network.allowLocalBinding,
    },
    filesystem: {
      allowWrite: dedupe(allowWrite.map(safeRealpath)),
      denyWrite: dedupe(denyWrite.map(safeRealpath)),
      denyRead: dedupe(denyRead.map(safeRealpath)),
    },
  }
}
