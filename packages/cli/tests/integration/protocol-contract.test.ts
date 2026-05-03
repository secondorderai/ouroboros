/**
 * Protocol contract test.
 *
 * Guards the CLI ↔ desktop JSON-RPC boundary: if a new method is added to
 * `RpcMethodMap` in `packages/desktop/src/shared/protocol.ts` without a
 * matching handler in `packages/cli/src/json-rpc/handlers.ts` (or vice
 * versa), this test fails — loudly.
 *
 * Also verifies the CLI never emits a notification name that isn't in
 * `NotificationMap`. Catches typos and forgotten-to-type additions.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ToolRegistry } from '@src/tools/registry'
import { Agent, type AgentOptions } from '@src/agent'
import { TranscriptStore } from '@src/memory/transcripts'
import { configSchema } from '@src/config'
import { OpenAIChatGPTAuthManager } from '@src/auth/openai-chatgpt'
import { ModeManager } from '@src/modes/manager'
import { createHandlers, bridgeAgentEvent, type HandlerContext } from '@src/json-rpc/handlers'
import { tmpdir } from 'node:os'
import type { LanguageModel } from 'ai'
import {
  RPC_METHOD_NAMES,
  NOTIFICATION_METHOD_NAMES,
  RPC_RISK_CLASSES,
} from '../../../desktop/src/shared/protocol'

function createContext(): HandlerContext {
  const model: LanguageModel = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unused')
    },
    doStream: async () => ({
      stream: new ReadableStream({ start: (c) => c.close() }),
      warnings: [],
    }),
  } as LanguageModel

  const registry = new ToolRegistry()
  const config = configSchema.parse({})
  const configDir = tmpdir()
  const dbPath = join(configDir, `.ouroboros-contract-${crypto.randomUUID()}.db`)
  const transcriptStore = new TranscriptStore(dbPath)

  const agentOptions: AgentOptions = {
    model,
    toolRegistry: registry,
    systemPromptBuilder: () => '',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
    onEvent: bridgeAgentEvent,
    config,
    basePath: configDir,
  }
  const agent = new Agent(agentOptions)

  let currentRunAbort: AbortController | null = null
  let currentSessionId: string | null = null

  const ctx: HandlerContext = {
    getAgent: () => agent,
    config,
    configDir,
    initialCwd: process.cwd(),
    initialConfigDir: configDir,
    transcriptStore,
    currentRunAbort,
    setCurrentRunAbort: (a) => {
      currentRunAbort = a
      ctx.currentRunAbort = a
    },
    currentSessionId,
    setCurrentSessionId: (s) => {
      currentSessionId = s
      ctx.currentSessionId = s
    },
    setConfig: (c) => {
      ctx.config = c
    },
    authManager: new OpenAIChatGPTAuthManager(),
    modeManager: new ModeManager(),
  }
  return ctx
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** All notification names emitted by the CLI, discovered via static analysis. */
function findEmittedNotificationNames(): Set<string> {
  const srcDir = join(import.meta.dir, '..', '..', 'src')
  const files = walk(srcDir)
  const names = new Set<string>()
  const pattern = /makeNotification\(\s*['"]([^'"]+)['"]/g
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      names.add(match[1]!)
    }
  }
  return names
}

describe('protocol contract', () => {
  test('every RpcMethodMap entry has a registered handler', () => {
    const ctx = createContext()
    const handlers = createHandlers(ctx)
    const registered = new Set(handlers.keys())
    const expected = new Set<string>(RPC_METHOD_NAMES)

    const missingHandlers = [...expected].filter((m) => !registered.has(m))
    const orphanHandlers = [...registered].filter((m) => !expected.has(m))

    expect(missingHandlers).toEqual([])
    expect(orphanHandlers).toEqual([])
  })

  test('every notification emitted by the CLI is typed in NotificationMap', () => {
    const emitted = findEmittedNotificationNames()
    const allowed = new Set<string>(NOTIFICATION_METHOD_NAMES)

    const untyped = [...emitted].filter((n) => !allowed.has(n))
    expect(untyped).toEqual([])
    expect(emitted.size).toBeGreaterThan(0)
  })

  test('every RPC method has a risk class assigned in RPC_RISK_CLASSES', () => {
    const expected = new Set<string>(RPC_METHOD_NAMES)
    const classified = new Set<string>(Object.keys(RPC_RISK_CLASSES))

    const unclassified = [...expected].filter((m) => !classified.has(m))
    const orphans = [...classified].filter((m) => !expected.has(m))

    expect(unclassified).toEqual([])
    expect(orphans).toEqual([])

    const allowedClasses = new Set(['read', 'write-low', 'sensitive', 'critical'])
    for (const [method, risk] of Object.entries(RPC_RISK_CLASSES)) {
      expect(allowedClasses.has(risk as string)).toBe(true)
      expect(typeof method).toBe('string')
    }
  })
})
