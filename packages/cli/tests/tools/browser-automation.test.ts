import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  buildAgentBrowserArgs,
  execute,
  resolveAgentBrowserBinary,
  resolveTier,
  schema,
} from '@src/tools/browser-automation'

const FIXTURES = resolve(import.meta.dir, '../fixtures/browser-automation-test')

describe('BrowserAutomationTool', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    rmSync(FIXTURES, { recursive: true, force: true })
    mkdirSync(FIXTURES, { recursive: true })
    process.env = { ...savedEnv }
  })

  afterEach(() => {
    rmSync(FIXTURES, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  test('builds Agent Browser commands with auto-connect by default', () => {
    expect(
      buildAgentBrowserArgs(schema.parse({ action: 'open', url: 'https://example.com' })),
    ).toEqual(['--auto-connect', 'open', 'https://example.com'])
    expect(buildAgentBrowserArgs(schema.parse({ action: 'snapshot' }))).toEqual([
      '--auto-connect',
      'snapshot',
      '-i',
    ])
    expect(buildAgentBrowserArgs(schema.parse({ action: 'click', ref: '@e1', cdp: 9222 }))).toEqual(
      ['--cdp', '9222', 'click', '@e1'],
    )
    expect(buildAgentBrowserArgs(schema.parse({ action: 'doctor' }))).toEqual([
      'doctor',
      '--offline',
      '--quick',
    ])
  })

  test('prefers explicit CDP then managed Automation Browser CDP before auto-connect', () => {
    process.env.OUROBOROS_AGENT_BROWSER_CDP = '9333'

    expect(
      buildAgentBrowserArgs(schema.parse({ action: 'open', url: 'https://example.com' })),
    ).toEqual(['--cdp', '9333', 'open', 'https://example.com'])
    expect(
      buildAgentBrowserArgs(
        schema.parse({ action: 'open', url: 'https://example.com', cdp: 9444 }),
      ),
    ).toEqual(['--cdp', '9444', 'open', 'https://example.com'])
    expect(buildAgentBrowserArgs(schema.parse({ action: 'connect' }))).toEqual(['connect', '9333'])
  })

  test('uses managed Automation Browser CDP file when live env port is absent', () => {
    const cdpFile = join(FIXTURES, 'automation-browser-cdp.json')
    writeFileSync(cdpFile, JSON.stringify({ port: 9555 }), 'utf8')
    process.env.OUROBOROS_AGENT_BROWSER_CDP_FILE = cdpFile

    expect(
      buildAgentBrowserArgs(schema.parse({ action: 'open', url: 'https://example.com' })),
    ).toEqual(['--cdp', '9555', 'open', 'https://example.com'])
  })

  test('resolves read-only and interactive tiers by action', () => {
    expect(resolveTier({ action: 'snapshot' })).toBe(0)
    expect(resolveTier({ action: 'tab' })).toBe(0)
    expect(resolveTier({ action: 'help' })).toBe(0)
    expect(resolveTier({ action: 'open' })).toBe(1)
    expect(resolveTier({ action: 'click' })).toBe(1)
    expect(resolveTier({ action: 'fill' })).toBe(1)
  })

  test('uses OUROBOROS_AGENT_BROWSER_BIN when present', () => {
    process.env.OUROBOROS_AGENT_BROWSER_BIN = '/app/agent-browser/agent-browser'
    expect(resolveAgentBrowserBinary()).toBe('/app/agent-browser/agent-browser')
  })

  test('returns a graceful unavailable result when configured binary is missing', async () => {
    process.env.OUROBOROS_AGENT_BROWSER_BIN = join(FIXTURES, 'missing-agent-browser')

    const result = await execute(schema.parse({ action: 'snapshot' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(127)
    expect(result.value.stderr).toContain('Bundled Agent Browser executable was not found')
    expect(result.value.remediation).toContain('Update or reinstall Ouroboros')
  })

  test('runs bundled binary with Agent Browser resource directory on PATH', async () => {
    const resourceDir = join(FIXTURES, 'agent-browser')
    const binDir = join(resourceDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakeBin = join(binDir, 'agent-browser')
    writeFileSync(
      fakeBin,
      [
        '#!/bin/sh',
        'printf "ARGV:%s\\n" "$*"',
        'printf "DIR:%s\\n" "$OUROBOROS_AGENT_BROWSER_DIR"',
        'printf "PATH:%s\\n" "$PATH"',
      ].join('\n'),
      'utf-8',
    )
    chmodSync(fakeBin, 0o755)

    process.env.OUROBOROS_AGENT_BROWSER_BIN = fakeBin
    process.env.OUROBOROS_AGENT_BROWSER_DIR = resourceDir
    process.env.OUROBOROS_AGENT_BROWSER_CDP = '9333'
    process.env.PATH = '/usr/bin'

    const result = await execute(schema.parse({ action: 'open', url: 'https://example.com' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toContain('ARGV:--cdp 9333 open https://example.com')
    expect(result.value.stdout).toContain(`DIR:${resourceDir}`)
    const pathLine = result.value.stdout.split('\n').find((line) => line.startsWith('PATH:'))
    expect(pathLine?.slice('PATH:'.length).split(':')[0]).toBe(binDir)
  })

  test('pre-connects to explicit CDP before running browser actions', async () => {
    const resourceDir = join(FIXTURES, 'agent-browser')
    const binDir = join(resourceDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakeBin = join(binDir, 'agent-browser')
    const stateFile = join(FIXTURES, 'connected')
    writeFileSync(
      fakeBin,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$BROWSER_AUTOMATION_TEST_LOG"',
        'if [ "$1" = "connect" ]; then',
        '  printf "connected:%s" "$2" > "$BROWSER_AUTOMATION_TEST_STATE"',
        '  exit 0',
        'fi',
        'if [ ! -f "$BROWSER_AUTOMATION_TEST_STATE" ]; then',
        '  printf "not connected" >&2',
        '  exit 1',
        'fi',
        'printf "ok:%s\\n" "$*"',
      ].join('\n'),
      'utf-8',
    )
    chmodSync(fakeBin, 0o755)

    const logFile = join(FIXTURES, 'calls.log')
    process.env.OUROBOROS_AGENT_BROWSER_BIN = fakeBin
    process.env.OUROBOROS_AGENT_BROWSER_DIR = resourceDir
    process.env.BROWSER_AUTOMATION_TEST_LOG = logFile
    process.env.BROWSER_AUTOMATION_TEST_STATE = stateFile

    const result = await execute(
      schema.parse({ action: 'open', url: 'https://example.com', cdp: 9333 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.command).toEqual([
      fakeBin,
      'connect',
      '9333',
      '&&',
      fakeBin,
      '--cdp',
      '9333',
      'open',
      'https://example.com',
    ])
    expect(readFileSync(logFile, 'utf-8').trim().split('\n')).toEqual([
      'connect 9333',
      '--cdp 9333 open https://example.com',
    ])
  })
})
