import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

type Json = Record<string, unknown>

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Json
}

interface NotificationSpec {
  delayMs?: number
  method: string
  params?: Json
}

interface MethodErrorSpec {
  message: string
  code?: number
}

interface AgentRunSpec {
  response?: Json
  notifications?: NotificationSpec[]
}

interface LaunchSpec {
  exitAfterMs?: number
  stderrLines?: string[]
  startupNotifications?: NotificationSpec[]
}

interface MockSession {
  id: string
  createdAt: string
  lastActive: string
  title?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>
}

interface MockScenario {
  config?: Json
  apiKeys?: Record<string, string>
  authStatus?: {
    connected?: boolean
    accountId?: string
    models?: string[]
  }
  workspace?: string | null
  approvals?: Json[]
  skills?: Json[]
  evolutionEntries?: Json[]
  evolutionStats?: Json
  sessions?: MockSession[]
  modeState?: { status: 'inactive' } | { status: 'active'; modeId: string; enteredAt: string }
  plan?: Json | null
  sessionCounter?: number
  methodErrors?: Record<string, MethodErrorSpec>
  startupNotifications?: NotificationSpec[]
  agentRuns?: AgentRunSpec[]
  defaultAgentRun?: AgentRunSpec
  launchBehavior?: Record<string, LaunchSpec>
}

interface PersistedState {
  launchCount: number
}

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

const scenario = loadScenario()
const statePath = process.env.OUROBOROS_TEST_STATE_PATH
const logPath = process.env.OUROBOROS_TEST_MOCK_LOG_PATH
const persistedState = loadState()
persistedState.launchCount += 1
saveState(persistedState)

const launchSpec = scenario.launchBehavior?.[String(persistedState.launchCount)] ?? {}
const runtime = createRuntimeState(scenario)
const activeTimers = new Set<ReturnType<typeof setTimeout>>()
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

  let request: JsonRpcRequest
  try {
    request = JSON.parse(line) as JsonRpcRequest
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

async function handleRequest(request: JsonRpcRequest): Promise<void> {
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
    case 'auth/startLogin': {
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
    }
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
      runtime.workspace = typeof request.params?.directory === 'string'
        ? request.params.directory
        : runtime.workspace
      writeResult(request.id, { directory: runtime.workspace })
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
      writeResult(request.id, {
        id: session.id,
        createdAt: session.createdAt,
        messages: session.messages,
      })
      return
    }
    case 'session/new': {
      runtime.sessionCounter += 1
      const now = new Date().toISOString()
      const newSession: MockSession = {
        id: `session-${runtime.sessionCounter}`,
        createdAt: now,
        lastActive: now,
        title: 'New conversation',
        messages: [],
      }
      runtime.sessions.unshift(newSession)
      writeResult(request.id, { sessionId: newSession.id })
      return
    }
    case 'session/delete':
      runtime.sessions = runtime.sessions.filter((entry) => entry.id !== request.params?.id)
      writeResult(request.id, { deleted: true })
      return
    case 'approval/list':
      writeResult(request.id, { approvals: runtime.approvals })
      return
    case 'approval/respond':
      runtime.approvals = runtime.approvals.filter((entry) => entry.id !== request.params?.id)
      writeResult(request.id, { status: 'ok' })
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
      const modeId =
        runtime.modeState.status === 'active' ? runtime.modeState.modeId : 'plan'
      runtime.modeState = { status: 'inactive' }
      writeResult(request.id, { displayName: toModeDisplayName(modeId) })
      return
    }
    case 'mode/getPlan':
      writeResult(request.id, runtime.plan)
      return
    case 'agent/run': {
      const runSpec = scenario.agentRuns?.[agentRunIndex] ?? scenario.defaultAgentRun ?? {
        response: {
          text: 'Mock final answer',
          iterations: 1,
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
      writeResult(request.id, runSpec.response ?? {
        text: 'Mock final answer',
        iterations: 1,
        maxIterationsReached: false,
      })
      scheduleNotifications(runSpec.notifications ?? [])
      return
    }
    case 'agent/cancel':
      clearScheduledAgentNotifications()
      writeResult(request.id, { cancelled: true })
      return
    default:
      writeResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      })
  }
}

function createRuntimeState(currentScenario: MockScenario) {
  return {
    config: structuredClone(currentScenario.config ?? defaultConfig),
    apiKeys: { ...(currentScenario.apiKeys ?? {}) },
    workspace: currentScenario.workspace ?? null,
    approvals: [...(currentScenario.approvals ?? [])],
    skills: [...(currentScenario.skills ?? [])],
    evolutionEntries: [...(currentScenario.evolutionEntries ?? [])],
    evolutionStats: {
      sessionsAnalyzed: 4,
      successRate: 0.75,
      ...(currentScenario.evolutionStats ?? {}),
    },
    sessions: [...(currentScenario.sessions ?? [])],
    modeState: structuredClone(currentScenario.modeState ?? { status: 'inactive' }),
    plan: currentScenario.plan ? structuredClone(currentScenario.plan) : null,
    sessionCounter: currentScenario.sessionCounter ?? currentScenario.sessions?.length ?? 0,
    auth: {
      connected: currentScenario.authStatus?.connected ?? false,
      pending: false,
      flowId: null as string | null,
      accountId: currentScenario.authStatus?.accountId,
      models: currentScenario.authStatus?.models ?? ['gpt-5.4', 'gpt-5.4-mini'],
    },
  }
}

function toModeDisplayName(modeId: string): string {
  if (modeId === 'plan') return 'Plan'
  return modeId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function getAuthStatus(runtime: ReturnType<typeof createRuntimeState>): Json {
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

function clearScheduledAgentNotifications(): void {
  for (const timer of activeTimers) {
    clearTimeout(timer)
  }
  activeTimers.clear()
}

function clearAllTimers(): void {
  clearScheduledAgentNotifications()
}

function scheduleNotifications(notifications: NotificationSpec[]): void {
  for (const notification of notifications) {
    const timer = setTimeout(() => {
      activeTimers.delete(timer)
      writeNotification(notification.method, notification.params ?? {})
    }, notification.delayMs ?? 0)
    activeTimers.add(timer)
  }
}

function writeResult(id: number | string, result: unknown): void {
  writeResponse({
    jsonrpc: '2.0',
    id,
    result,
  })
}

function writeNotification(method: string, params: unknown): void {
  writeResponse({
    jsonrpc: '2.0',
    method,
    params,
  })
}

function writeResponse(message: Record<string, unknown>): void {
  const line = JSON.stringify(message)
  logLine('response', line)
  process.stdout.write(`${line}\n`)
}

function loadScenario(): MockScenario {
  const scenarioPath = process.env.OUROBOROS_TEST_SCENARIO_PATH
  if (!scenarioPath) return {}
  try {
    return JSON.parse(readFileSync(scenarioPath, 'utf8')) as MockScenario
  } catch {
    return {}
  }
}

function loadState(): PersistedState {
  if (!statePath) return { launchCount: 0 }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState
  } catch {
    return { launchCount: 0 }
  }
}

function saveState(state: PersistedState): void {
  if (!statePath) return
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function logLine(type: 'request' | 'response', line: string): void {
  if (!logPath) return
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `[${type}] ${line}\n`)
}

function toSessionInfo(session: MockSession): Json {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
    messageCount: session.messages.length,
    title: session.title,
  }
}

function setPath(target: Json, path: string, value: unknown): void {
  if (!path) return
  const parts = path.split('.')
  let current: Json = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const next = current[key]
    if (!next || typeof next !== 'object') {
      current[key] = {}
    }
    current = current[key] as Json
  }
  current[parts[parts.length - 1]] = value
}
