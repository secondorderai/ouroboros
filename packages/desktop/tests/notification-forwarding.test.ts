/**
 * Forwarding-list contract test.
 *
 * The main process forwards CLI JSON-RPC notifications to the renderer only
 * for methods listed in FORWARDED_NOTIFICATION_METHODS (ipc-handlers.ts).
 * The test-only EMIT_NOTIFICATION bridge used by E2E specs sends
 * CLI_NOTIFICATION to the renderer directly, bypassing that list — so an
 * emitNotification-driven spec stays green even when a method is missing
 * from the list while the real app silently drops the notification. This
 * test pins the list itself.
 */
import { describe, expect, mock, test } from 'bun:test'
import { NOTIFICATION_METHOD_NAMES } from '../src/shared/protocol'

// ipc-handlers.ts has value imports from electron (ipcMain, dialog); stub
// them out so the module can load under bun test. Registration functions
// are never called here — only the exported list is inspected.
mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
}))

const { FORWARDED_NOTIFICATION_METHODS } = await import('../src/main/ipc-handlers')

describe('FORWARDED_NOTIFICATION_METHODS', () => {
  test('forwards the completion-gate verifier notifications', () => {
    expect(FORWARDED_NOTIFICATION_METHODS).toContain('agent/verifierStarted')
    expect(FORWARDED_NOTIFICATION_METHODS).toContain('agent/verifierVerdict')
    expect(FORWARDED_NOTIFICATION_METHODS).toContain('agent/verifierError')
  })

  test('covers every protocol notification except documented exclusions', () => {
    // MCP server lifecycle notifications have no renderer surface yet. If a
    // new notification method is added to protocol.ts, either forward it in
    // ipc-handlers.ts or add it here with a reason.
    const exclusions = new Set<string>([
      'mcp/serverConnected',
      'mcp/serverDisconnected',
      'mcp/serverError',
    ])

    const forwarded = new Set<string>(FORWARDED_NOTIFICATION_METHODS)
    const missing = NOTIFICATION_METHOD_NAMES.filter(
      (method) => !forwarded.has(method) && !exclusions.has(method),
    )
    expect(missing).toEqual([])
  })

  test('contains no stale or duplicate entries', () => {
    const known = new Set<string>(NOTIFICATION_METHOD_NAMES)
    for (const method of FORWARDED_NOTIFICATION_METHODS) {
      expect(known.has(method)).toBe(true)
    }
    expect(new Set(FORWARDED_NOTIFICATION_METHODS).size).toBe(
      FORWARDED_NOTIFICATION_METHODS.length,
    )
  })
})
