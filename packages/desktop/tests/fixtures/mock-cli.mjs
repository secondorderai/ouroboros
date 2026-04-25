#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const defaultConfig = {
  model: {
    provider: 'anthropic',
    name: 'claude-opus-4-20250514',
  },
  permissions: {
    tier0: true,
    tier1: true,
    tier2: true,
    tier3: false,
    tier4: false,
  },
  skillDirectories: [],
  memory: {
    consolidationSchedule: 'session-end',
  },
  rsi: {
    noveltyThreshold: 0.5,
    autoReflect: true,
  },
}

const testRuntimeDir = join(tmpdir(), 'ouroboros-desktop-tests')
const scenario = loadScenario()
const statePath = process.env.OUROBOROS_TEST_STATE_PATH ?? join(testRuntimeDir, 'mock-state.json')
const logPath = process.env.OUROBOROS_TEST_MOCK_LOG_PATH ?? join(testRuntimeDir, 'mock-cli.log')
logLine(
  'env',
  JSON.stringify({
    hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY),
    hasOpenAICompatibleApiKey: Boolean(process.env.OUROBOROS_OPENAI_COMPATIBLE_API_KEY),
  }),
)
const persistedState = loadState()
persistedState.launchCount += 1
saveState(persistedState)

const launchSpec = scenario.launchBehavior?.[String(persistedState.launchCount)] ?? {}
const runtime = createRuntimeState(scenario)
const activeTimers = new Set()
let agentRunIndex = 0

for (const line of launchSpec.stderrLines ?? []) {
  process.stderr.write(`${line}\n`)
}

scheduleNotifications([
  ...(scenario.startupNotifications ?? []),
  ...(launchSpec.startupNotifications ?? []),
])

if (typeof launchSpec.exitAfterMs === 'number') {
  const timer = setTimeout(() => process.exit(1), launchSpec.exitAfterMs)
  activeTimers.add(timer)
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', (line) => {
  if (!line.trim()) return
  logLine('request', line)

  let request
  try {
    request = JSON.parse(line)
  } catch {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
    return
  }

  void handleRequest(request)
})

rl.on('close', () => {
  clearAllTimers()
  process.exit(0)
})

process.on('SIGTERM', () => {
  clearAllTimers()
  process.exit(0)
})

async function handleRequest(request) {
  const methodError = scenario.methodErrors?.[request.method]
  if (methodError) {
    writeResponse({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: methodError.code ?? -32000,
        message: methodError.message,
      },
    })
    return
  }

  switch (request.method) {
    case 'config/get':
      writeResult(request.id, runtime.config)
      return
    case 'config/set':
      setPath(runtime.config, String(request.params?.path ?? ''), request.params?.value)
      writeResult(request.id, runtime.config)
      return
    case 'config/setApiKey': {
      const provider = String(request.params?.provider ?? '')
      const apiKey = String(request.params?.apiKey ?? '')
      runtime.apiKeys[provider] = apiKey
      writeResult(request.id, { ok: true })
      return
    }
    case 'config/testConnection':
      if (request.params?.provider === 'openai-chatgpt') {
        writeResult(
          request.id,
          runtime.auth.connected
            ? { success: true, models: runtime.auth.models }
            : { success: false, error: 'ChatGPT subscription not connected' },
        )
      } else {
        writeResult(request.id, {
          success: true,
          models: ['claude-opus-4-20250514', 'gpt-5.4'],
        })
      }
      return
    case 'auth/getStatus':
      writeResult(request.id, getAuthStatus(runtime))
      return
    case 'auth/startLogin':
      runtime.auth.pending = true
      runtime.auth.flowId = 'flow-1'
      writeResult(request.id, {
        flowId: runtime.auth.flowId,
        provider: 'openai-chatgpt',
        method: request.params?.method ?? 'browser',
        url: 'https://chatgpt.com/login',
        instructions: 'Open the browser to continue',
        pending: true,
      })
      return
    case 'auth/pollLogin':
      if (request.params?.flowId !== runtime.auth.flowId) {
        writeResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32001, message: 'Auth flow not found' },
        })
        return
      }
      if (runtime.auth.pending) {
        runtime.auth.pending = false
        runtime.auth.connected = true
        runtime.auth.accountId ??= 'acct_test'
      }
      writeResult(request.id, {
        ...getAuthStatus(runtime),
        flowId: runtime.auth.flowId,
        method: 'browser',
        success: runtime.auth.connected,
      })
      return
    case 'auth/cancelLogin':
      runtime.auth.pending = false
      runtime.auth.flowId = null
      writeResult(request.id, { cancelled: true })
      return
    case 'auth/logout':
      runtime.auth.connected = false
      runtime.auth.pending = false
      runtime.auth.accountId = undefined
      runtime.auth.flowId = null
      writeResult(request.id, { ok: true })
      return
    case 'workspace/set':
      runtime.workspace =
        typeof request.params?.directory === 'string' ? request.params.directory : runtime.workspace
      writeResult(request.id, { directory: runtime.workspace })
      return
    case 'workspace/clear':
      runtime.workspace = runtime.initialWorkspace ?? null
      writeResult(request.id, { directory: runtime.workspace ?? '' })
      return
    case 'session/list':
      writeResult(request.id, {
        sessions: runtime.sessions.map((session) => toSessionInfo(session)),
      })
      return
    case 'session/load': {
      const session = runtime.sessions.find((entry) => entry.id === request.params?.id)
      if (!session) {
        writeResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32001, message: 'Session not found' },
        })
        return
      }
      runtime.currentSessionId = session.id
      writeResult(request.id, {
        id: session.id,
        createdAt: session.createdAt,
        workspacePath: session.workspacePath ?? runtime.workspace,
        messages: session.messages,
      })
      return
    }
    case 'session/new': {
      runtime.sessionCounter += 1
      const now = new Date().toISOString()
      const newSession = {
        id: `session-${runtime.sessionCounter}`,
        createdAt: now,
        lastActive: now,
        title: 'New conversation',
        titleSource: 'auto',
        messages: [],
      }
      runtime.sessions.unshift(newSession)
      runtime.currentSessionId = newSession.id
      writeResult(request.id, { sessionId: newSession.id })
      return
    }
    case 'session/delete': {
      const id = request.params?.id
      runtime.sessions = runtime.sessions.filter((entry) => entry.id !== id)
      if (runtime.currentSessionId === id) runtime.currentSessionId = null
      writeResult(request.id, { deleted: true })
      return
    }
    case 'session/rename': {
      const id = request.params?.id
      const title = request.params?.title
      if (typeof id !== 'string' || typeof title !== 'string' || title.trim().length === 0) {
        writeResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32602, message: 'Invalid session rename params' },
        })
        return
      }
      const session = runtime.sessions.find((entry) => entry.id === id)
      if (!session) {
        writeResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32001, message: 'Session not found' },
        })
        return
      }
      session.title = title.trim().replace(/\s+/g, ' ')
      session.titleSource = 'manual'
      writeResult(request.id, { id, title: session.title, titleSource: 'manual' })
      return
    }
    case 'approval/list':
      writeResult(request.id, { approvals: runtime.approvals })
      return
    case 'approval/respond':
      runtime.approvals = runtime.approvals.filter((entry) => entry.id !== request.params?.id)
      writeResult(request.id, { status: 'ok' })
      return
    case 'askUser/respond':
      writeResult(request.id, { ok: true })
      return
    case 'skills/list':
      writeResult(request.id, { skills: runtime.skills })
      return
    case 'skills/get':
      writeResult(request.id, {
        name: request.params?.name ?? 'unknown',
        description: 'Mock skill',
        version: '0.0.0',
        enabled: true,
        instructions: 'Mock instructions',
      })
      return
    case 'evolution/list':
      writeResult(request.id, { entries: runtime.evolutionEntries })
      return
    case 'evolution/stats':
      writeResult(request.id, { stats: runtime.evolutionStats })
      return
    case 'rsi/status':
      writeResult(request.id, { status: 'idle', message: 'No active RSI job' })
      return
    case 'rsi/history':
      writeResult(request.id, { entries: runtime.rsiHistoryEntries })
      return
    case 'rsi/checkpoint': {
      const sessionId = String(request.params?.sessionId ?? '')
      writeResult(request.id, { checkpoint: runtime.rsiCheckpoints[sessionId] ?? null })
      return
    }
    case 'rsi/dream':
      writeResult(request.id, { status: 'ok', message: 'Dreamed successfully' })
      scheduleNotifications([
        {
          delayMs: 20,
          method: 'rsi/dream',
          params: { message: 'Dreamed successfully' },
        },
      ])
      return
    case 'mode/getState':
      writeResult(request.id, runtime.modeState)
      return
    case 'mode/enter': {
      const modeId = typeof request.params?.mode === 'string' ? request.params.mode : 'plan'
      runtime.modeState = {
        status: 'active',
        modeId,
        enteredAt: new Date().toISOString(),
      }
      writeResult(request.id, { displayName: toModeDisplayName(modeId) })
      return
    }
    case 'mode/exit': {
      const modeId = runtime.modeState.status === 'active' ? runtime.modeState.modeId : 'plan'
      runtime.modeState = { status: 'inactive' }
      writeResult(request.id, { displayName: toModeDisplayName(modeId) })
      return
    }
    case 'mode/getPlan':
      writeResult(request.id, runtime.plan)
      return
    case 'agent/run': {
      // Pin the run to its captured session — explicit param wins, else
      // the currently-viewed session. Mirrors the real CLI semantics.
      const runSessionId =
        (typeof request.params?.sessionId === 'string' && request.params.sessionId) ||
        runtime.currentSessionId ||
        null

      const runSpec = scenario.agentRuns?.[agentRunIndex] ??
        scenario.defaultAgentRun ?? {
          response: {
            text: 'Mock final answer',
            iterations: 1,
            stopReason: 'completed',
            maxIterationsReached: false,
          },
          notifications: [
            { delayMs: 10, method: 'agent/text', params: { text: 'Mock final answer' } },
            {
              delayMs: 20,
              method: 'agent/turnComplete',
              params: { text: 'Mock final answer', iterations: 1 },
            },
          ],
        }
      agentRunIndex += 1

      // Persist user message + assistant reply to the captured session so
      // session/load returns the conversation. The "switch back" regression
      // test fails here if persistence is misrouted to the wrong session.
      if (runSessionId) {
        const session = runtime.sessions.find((entry) => entry.id === runSessionId)
        if (session) {
          const now = new Date().toISOString()
          if (typeof request.params?.message === 'string') {
            session.messages.push({
              role: 'user',
              content: request.params.message,
              timestamp: now,
            })
          }
          const responseText =
            typeof runSpec.response?.text === 'string'
              ? runSpec.response.text
              : 'Mock final answer'
          session.messages.push({
            role: 'assistant',
            content: responseText,
            timestamp: now,
          })
          session.lastActive = now
        }
      }

      writeResult(
        request.id,
        runSpec.response ?? {
          text: 'Mock final answer',
          iterations: 1,
          stopReason: 'completed',
          maxIterationsReached: false,
        },
      )
      // Stamp sessionId on every agent/* and skill/activated notification —
      // matches the real CLI bridge so the renderer can route per-session.
      const stampedNotifications = (runSpec.notifications ?? []).map((notif) =>
        notif.method.startsWith('agent/') || notif.method === 'skill/activated'
          ? { ...notif, params: { sessionId: runSessionId, ...(notif.params ?? {}) } }
          : notif,
      )
      scheduleNotifications(stampedNotifications)
      return
    }
    case 'agent/cancel':
      clearScheduledAgentNotifications()
      writeResult(request.id, { cancelled: true })
      return
    case 'agent/steer': {
      // Echo "accepted" so the renderer keeps the bubble in the pending state
      // until the test emits agent/steerInjected (or agent/steerOrphaned)
      // explicitly. The requestId is logged so tests can correlate the wire.
      writeResult(request.id, { accepted: true, duplicate: false })
      return
    }
    default:
      writeResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      })
  }
}

function createRuntimeState(currentScenario) {
  return {
    config: structuredClone(currentScenario.config ?? defaultConfig),
    apiKeys: { ...(currentScenario.apiKeys ?? {}) },
    workspace: currentScenario.workspace ?? null,
    initialWorkspace: currentScenario.workspace ?? null,
    approvals: [...(currentScenario.approvals ?? [])],
    skills: [...(currentScenario.skills ?? [])],
    evolutionEntries: [...(currentScenario.evolutionEntries ?? [])],
    evolutionStats: {
      sessionsAnalyzed: 4,
      successRate: 0.75,
      ...(currentScenario.evolutionStats ?? {}),
    },
    rsiHistoryEntries: [...(currentScenario.rsiHistoryEntries ?? [])],
    rsiCheckpoints: { ...(currentScenario.rsiCheckpoints ?? {}) },
    sessions: [...(currentScenario.sessions ?? [])],
    modeState: structuredClone(currentScenario.modeState ?? { status: 'inactive' }),
    plan: currentScenario.plan ? structuredClone(currentScenario.plan) : null,
    sessionCounter: currentScenario.sessionCounter ?? currentScenario.sessions?.length ?? 0,
    currentSessionId: null,
    auth: {
      connected: currentScenario.authStatus?.connected ?? false,
      pending: false,
      flowId: null,
      accountId: currentScenario.authStatus?.accountId,
      models: currentScenario.authStatus?.models ?? ['gpt-5.4', 'gpt-5.4-mini'],
    },
  }
}

function toModeDisplayName(modeId) {
  if (modeId === 'plan') return 'Plan'
  return modeId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function getAuthStatus(runtime) {
  return {
    provider: 'openai-chatgpt',
    connected: runtime.auth.connected,
    authType: runtime.auth.connected ? 'oauth' : null,
    pending: runtime.auth.pending,
    accountId: runtime.auth.accountId,
    availableMethods: ['browser', 'headless'],
    models: runtime.auth.models,
  }
}

function clearScheduledAgentNotifications() {
  for (const timer of activeTimers) {
    clearTimeout(timer)
  }
  activeTimers.clear()
}

function clearAllTimers() {
  clearScheduledAgentNotifications()
}

function scheduleNotifications(notifications) {
  for (const notification of notifications) {
    const timer = setTimeout(() => {
      activeTimers.delete(timer)
      writeNotification(notification.method, notification.params ?? {})
    }, notification.delayMs ?? 0)
    activeTimers.add(timer)
  }
}

function writeResult(id, result) {
  writeResponse({
    jsonrpc: '2.0',
    id,
    result,
  })
}

function writeNotification(method, params) {
  writeResponse({
    jsonrpc: '2.0',
    method,
    params,
  })
}

function writeResponse(message) {
  const line = JSON.stringify(message)
  logLine('response', line)
  process.stdout.write(`${line}\n`)
}

function loadScenario() {
  const scenarioPath =
    process.env.OUROBOROS_TEST_SCENARIO_PATH ?? join(testRuntimeDir, 'scenario.json')
  if (!scenarioPath) return {}
  try {
    return JSON.parse(readFileSync(scenarioPath, 'utf8'))
  } catch {
    return {}
  }
}

function loadState() {
  if (!statePath) return { launchCount: 0 }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return { launchCount: 0 }
  }
}

function saveState(state) {
  if (!statePath) return
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function logLine(type, line) {
  if (!logPath) return
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `[${type}] ${line}\n`)
}

function toSessionInfo(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
    messageCount: session.messages.length,
    title: session.title,
    titleSource: session.titleSource,
  }
}

function setPath(target, path, value) {
  if (!path) return
  const parts = path.split('.')
  let current = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const next = current[key]
    if (!next || typeof next !== 'object') {
      current[key] = {}
    }
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
}
