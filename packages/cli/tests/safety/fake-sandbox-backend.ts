/**
 * Shared fake SandboxBackend for sandbox facade / bash / code-exec tests.
 * Records initialize/wrap calls so tests can assert against the policy and
 * the exact commands routed through the sandbox.
 */

import type { SandboxBackend, SpawnSpec } from '@src/safety/sandbox'
import type { SandboxPolicy } from '@src/safety/policy'

export interface FakeBackendOptions {
  /** Non-empty → initializeSandbox reports mode 'unavailable'. */
  dependencyErrors?: string[]
  /** Custom wrap output; defaults to an identity `sh -c <command>` spec. */
  wrap?: (command: string) => SpawnSpec
  /** Make initialize() throw. */
  failInitialize?: boolean
  /** Make wrapCommand() throw. */
  failWrap?: boolean
  /** Custom stderr annotation (defaults to identity). */
  annotate?: (command: string, stderr: string) => string
  /**
   * Awaited inside initialize() — lets tests hold a (re)initialization in
   * flight to exercise the facade's state-lock queueing.
   */
  onInitialize?: () => Promise<void> | void
}

export interface FakeSandboxBackend extends SandboxBackend {
  wrappedCommands: string[]
  initializedPolicies: SandboxPolicy[]
  resetCount: number
  /** Number of completeCommand() (per-command cleanup) notifications. */
  completedCommands: number
}

export function makeFakeBackend(options: FakeBackendOptions = {}): FakeSandboxBackend {
  const backend: FakeSandboxBackend = {
    wrappedCommands: [],
    initializedPolicies: [],
    resetCount: 0,
    completedCommands: 0,

    checkDependencies() {
      return { errors: [...(options.dependencyErrors ?? [])], warnings: [] }
    },

    async initialize(policy: SandboxPolicy) {
      if (options.failInitialize) throw new Error('fake backend initialize failure')
      await options.onInitialize?.()
      backend.initializedPolicies.push(policy)
    },

    async wrapCommand(command: string): Promise<SpawnSpec> {
      if (options.failWrap) throw new Error('fake backend wrap failure')
      backend.wrappedCommands.push(command)
      return options.wrap ? options.wrap(command) : { command: 'sh', args: ['-c', command] }
    },

    annotateStderr(command: string, stderr: string): string {
      return options.annotate ? options.annotate(command, stderr) : stderr
    },

    completeCommand() {
      backend.completedCommands += 1
    },

    async reset() {
      backend.resetCount += 1
    },
  }
  return backend
}
