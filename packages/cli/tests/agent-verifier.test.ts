/**
 * Completion-gate verifier — agent loop integration tests.
 *
 * Uses a dual mock: a streaming actor model (`doStream`, sequenced turns) and
 * a non-streaming verifier model (`doGenerate`, sequenced responses) passed as
 * `AgentOptions.verifierModel`. Kept separate from agent.test.ts on purpose.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent, type AgentOptions, type EnqueueSteerResult } from '@src/agent'
import { ToolRegistry } from '@src/tools/registry'
import { configSchema, type OuroborosConfig } from '@src/config'
import { resolveCheckpointPath } from '@src/memory/paths'
import { readLog } from '@src/rsi/evolution-log'
import { setTierApprovalHandler, type TierApprovalExtras } from '@src/tier-approval'
import { z } from 'zod'
import { ok, err } from '@src/types'
import type { ToolTier } from '@src/tools/types'
import type { ToolDefinition } from '@src/tools/types'
import type { AgentDefinition } from '@src/types'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

// ── Actor mock (streaming) ───────────────────────────────────────────

function createActorModel(turns: LanguageModelV3StreamPart[][]): LanguageModel {
  let turnIndex = 0
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-actor',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not used by the actor — use doStream')
    },
    doStream: async () => {
      const parts = turns[turnIndex] ?? []
      turnIndex++
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
        warnings: [],
      }
    },
  } as LanguageModel
}

function toolCallTurn(count: number, iteration = 1): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = []
  for (let i = 0; i < count; i++) {
    const id = `call_${iteration}_${i + 1}`
    parts.push({ type: 'tool-input-start', id, toolName: 'echo' })
    parts.push({ type: 'tool-input-end', id })
    parts.push({ type: 'tool-call', toolCallId: id, toolName: 'echo', input: '{}' })
  }
  parts.push({
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
  })
  return parts
}

function textTurn(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id: 'tx1' },
    { type: 'text-delta', id: 'tx1', delta: text },
    { type: 'text-end', id: 'tx1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 12, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
    },
  ]
}

// ── Verifier mock (non-streaming) ────────────────────────────────────

type VerifierResponse = string | Error | (() => Promise<string>)

/** Default done-contract extraction response (Phase 2: the gate extracts a contract first). */
const DEFAULT_CONTRACT_JSON = JSON.stringify({
  criteria: ['The requested task outcome is delivered.'],
})

/**
 * Dual-purpose non-streaming mock. The completion gate makes two kinds of
 * `doGenerate` calls against the verifier model: done-contract extraction
 * (first gate hit of a run) and verification. They are told apart by the
 * verify prompt's distinctive role line; `responses` sequences ONLY the
 * verification calls so `callCount()`/`prompts` keep their Phase 1 meaning,
 * while extraction is answered from `options.contract` (default: a one-item
 * contract).
 */
function createVerifierModel(
  responses: VerifierResponse[],
  options?: { contract?: VerifierResponse },
): {
  model: LanguageModel
  prompts: string[]
  callCount: () => number
  contractPrompts: string[]
  contractCallCount: () => number
} {
  const prompts: string[] = []
  const contractPrompts: string[] = []
  const contractResponse = options?.contract ?? DEFAULT_CONTRACT_JSON
  let index = 0
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-verifier',
    supportedUrls: {},
    doGenerate: async (callOptions: {
      prompt: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    }) => {
      const userMessage = callOptions.prompt.find((message) => message.role === 'user')
      const promptText =
        userMessage?.content.map((part) => ('text' in part ? (part.text ?? '') : '')).join('') ?? ''

      const respond = async (response: VerifierResponse) => {
        if (response instanceof Error) throw response
        const text = typeof response === 'function' ? await response() : response
        return {
          content: [{ type: 'text' as const, text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: 10, outputTokens: 20 },
          warnings: [],
        }
      }

      if (!promptText.includes('strict completion verifier')) {
        // Done-contract extraction call.
        contractPrompts.push(promptText)
        return respond(contractResponse)
      }

      prompts.push(promptText)
      const response = responses[Math.min(index, responses.length - 1)]
      index++
      return respond(response)
    },
    doStream: async () => {
      throw new Error('Streaming not used by the verifier')
    },
  } as unknown as LanguageModel
  return {
    model,
    prompts,
    callCount: () => prompts.length,
    contractPrompts,
    contractCallCount: () => contractPrompts.length,
  }
}

/** Verifier model that fails the test if it is ever invoked. */
function createForbiddenVerifierModel(): { model: LanguageModel; callCount: () => number } {
  let calls = 0
  const model = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-verifier-forbidden',
    supportedUrls: {},
    doGenerate: async () => {
      calls++
      throw new Error('verifier must not be called in this scenario')
    },
    doStream: async () => {
      throw new Error('Streaming not used by the verifier')
    },
  } as unknown as LanguageModel
  return { model, callCount: () => calls }
}

// ── Shared fixtures ──────────────────────────────────────────────────

const PASS_JSON = JSON.stringify({ verdict: 'pass', failures: [], reason: 'Evidence supports it.' })
const UNKNOWN_JSON = JSON.stringify({ verdict: 'unknown', failures: [], reason: 'Cannot tell.' })

function failJson(criteria: string[]): string {
  return JSON.stringify({
    verdict: 'fail',
    failures: criteria.map((criterion) => ({
      criterion,
      evidence: `no evidence for ${criterion}`,
      suggestion: `do ${criterion}`,
    })),
    reason: 'Unmet criteria remain.',
  })
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  const echoTool: ToolDefinition = {
    name: 'echo',
    description: 'echoes',
    schema: z.object({}),
    execute: async () => ok({ echoed: true }),
  }
  registry.register(echoTool)
  return registry
}

function makeConfig(verifier?: Partial<OuroborosConfig['verifier']>): OuroborosConfig {
  return configSchema.parse(verifier ? { verifier } : {})
}

function makeAgent(options: {
  actorTurns: LanguageModelV3StreamPart[][]
  verifierModel: LanguageModel
  verifier?: Partial<OuroborosConfig['verifier']>
  events?: AgentEvent[]
  agentDefinition?: AgentDefinition
  overrides?: Partial<AgentOptions>
}): Agent {
  const events = options.events ?? []
  return new Agent({
    model: createActorModel(options.actorTurns),
    verifierModel: options.verifierModel,
    toolRegistry: makeRegistry(),
    systemPromptBuilder: () => 'You are a test assistant.',
    memoryProvider: () => '',
    skillCatalogProvider: () => [],
    config: makeConfig(options.verifier),
    onEvent: (event) => events.push(event),
    agentDefinition: options.agentDefinition,
    ...options.overrides,
  })
}

function verifierEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter(
    (event) =>
      event.type === 'verifier-started' ||
      event.type === 'verifier-verdict' ||
      event.type === 'verifier-error',
  )
}

// ── Tests ────────────────────────────────────────────────────────────

describe('completion gate — gating predicate', () => {
  test('trigger "off": verifier is never called even on long runs', async () => {
    const events: AgentEvent[] = []
    const forbidden = createForbiddenVerifierModel()
    const agent = makeAgent({
      actorTurns: [toolCallTurn(6), textTurn('done')],
      verifierModel: forbidden.model,
      verifier: { trigger: 'off' },
      events,
    })

    const result = await agent.run('do the long task')

    expect(result.stopReason).toBe('completed')
    expect(result.verification).toBeUndefined()
    expect(forbidden.callCount()).toBe(0)
    expect(verifierEvents(events)).toEqual([])
  })

  test('long-tasks: gates when the tool-call count reaches minToolCalls', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(5), textTurn('done')],
      verifierModel: verifier.model,
      events, // default config: long-tasks, minToolCalls 5
    })

    const result = await agent.run('do the long task')

    expect(result.stopReason).toBe('completed')
    expect(verifier.callCount()).toBe(1)
    expect(result.verification).toEqual({ verdict: 'pass', attempts: 1 })
    const started = events.find((event) => event.type === 'verifier-started')
    expect(started).toMatchObject({ toolCallCount: 5, attempt: 1, trigger: 'long-tasks' })
  })

  test('long-tasks: does not gate below the minToolCalls threshold (default config)', async () => {
    const events: AgentEvent[] = []
    const forbidden = createForbiddenVerifierModel()
    const agent = makeAgent({
      actorTurns: [toolCallTurn(4), textTurn('done')],
      verifierModel: forbidden.model,
      events, // defaults — guards that existing low-tool-count runs stay ungated
    })

    const result = await agent.run('do the short task')

    expect(result.stopReason).toBe('completed')
    expect(result.verification).toBeUndefined()
    expect(forbidden.callCount()).toBe(0)
    expect(verifierEvents(events)).toEqual([])
  })

  test('zero-tool runs are never gated, even with trigger "always"', async () => {
    const events: AgentEvent[] = []
    const forbidden = createForbiddenVerifierModel()
    const agent = makeAgent({
      actorTurns: [textTurn('just an answer')],
      verifierModel: forbidden.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('what is 2+2?')

    expect(result.stopReason).toBe('completed')
    expect(result.verification).toBeUndefined()
    expect(forbidden.callCount()).toBe(0)
    expect(verifierEvents(events)).toEqual([])
  })

  test('subagent runs are never gated', async () => {
    const events: AgentEvent[] = []
    const forbidden = createForbiddenVerifierModel()
    const subagentDefinition: AgentDefinition = {
      id: 'worker-test',
      description: 'test subagent',
      mode: 'subagent',
      prompt: 'do the assigned task',
    }
    const agent = makeAgent({
      actorTurns: [toolCallTurn(6), textTurn('done')],
      verifierModel: forbidden.model,
      verifier: { trigger: 'always' },
      events,
      agentDefinition: subagentDefinition,
    })

    const result = await agent.run('subagent task')

    expect(result.stopReason).toBe('completed')
    expect(result.verification).toBeUndefined()
    expect(forbidden.callCount()).toBe(0)
    expect(verifierEvents(events)).toEqual([])
  })

  test('max-steps exits are not gated and emit no verifier events', async () => {
    const events: AgentEvent[] = []
    const forbidden = createForbiddenVerifierModel()
    const agent = makeAgent({
      // Turn 1 consumes the only step with tool calls; the post-limit summary
      // stream returns the handoff text.
      actorTurns: [toolCallTurn(6), textTurn('handoff summary')],
      verifierModel: forbidden.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('long task', { maxSteps: 1 })

    expect(result.stopReason).toBe('max_steps')
    expect(result.maxIterationsReached).toBe(true)
    expect(result.verification).toBeUndefined()
    expect(forbidden.callCount()).toBe(0)
    expect(verifierEvents(events)).toEqual([])
  })
})

describe('completion gate — verdict handling', () => {
  test('pass: events in order verifier-started → verifier-verdict → turn-complete', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('final answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('final answer')
    expect(result.verification).toEqual({ verdict: 'pass', attempts: 1 })

    const types = events.map((event) => event.type)
    const startedIndex = types.indexOf('verifier-started')
    const verdictIndex = types.indexOf('verifier-verdict')
    const completeIndex = types.indexOf('turn-complete')
    expect(startedIndex).toBeGreaterThanOrEqual(0)
    expect(verdictIndex).toBeGreaterThan(startedIndex)
    expect(completeIndex).toBeGreaterThan(verdictIndex)

    const verdict = events[verdictIndex]
    expect(verdict).toMatchObject({
      verdict: 'pass',
      attempt: 1,
      willRetry: false,
      escalated: false,
    })

    // The verifier prompt carries the verbatim task snapshot and the evidence.
    expect(verifier.prompts[0]).toContain('do it')
    expect(verifier.prompts[0]).toContain('echo')
  })

  test('unknown verdict: accepted with a warning', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([UNKNOWN_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.verification?.verdict).toBe('unknown')
    expect(result.verification?.warning).toContain('accepted unverified')
  })

  test('fail → feedback injection → pass on retry', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([failJson(['Tests must pass']), PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft answer'), textTurn('fixed answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('fixed answer')
    expect(result.verification).toEqual({ verdict: 'pass', attempts: 2 })
    expect(verifier.callCount()).toBe(2)

    // The failing verdict announced the retry; the passing one did not.
    const verdicts = events.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({ verdict: 'fail', attempt: 1, willRetry: true })
    expect(verdicts[1]).toMatchObject({ verdict: 'pass', attempt: 2, willRetry: false })

    // The candidate answer stayed in history and the numbered feedback was
    // injected as a user-role message.
    const history = agent.getConversationHistory()
    const feedback = history.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith('[System: A completion verifier'),
    )
    expect(feedback).toBeDefined()
    expect(feedback && (feedback.content as string)).toContain('1. Tests must pass')
    expect(feedback && (feedback.content as string)).toContain('Suggestion: do Tests must pass')
    const draftIndex = history.findIndex(
      (message) => message.role === 'assistant' && message.content === 'draft answer',
    )
    expect(draftIndex).toBeGreaterThanOrEqual(0)
  })

  test('retries exhausted with no approval handler: accepts with a warning', async () => {
    const events: AgentEvent[] = []
    // No tier-approval handler is registered here, so this also covers the
    // escalation "no handler" branch: exhaustion must accept with a warning
    // instead of attempting (and failing) a tier-4 approval request.
    // Different criteria each time so oscillation detection does not kick in.
    const verifier = createVerifierModel([failJson(['criterion A']), failJson(['criterion B'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft 1'), textTurn('draft 2')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 1 },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('draft 2')
    expect(result.verification?.verdict).toBe('fail')
    expect(result.verification?.attempts).toBe(2)
    expect(result.verification?.warning).toContain('retries exhausted')

    const verdicts = events.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts[0]).toMatchObject({ attempt: 1, willRetry: true })
    expect(verdicts[1]).toMatchObject({ attempt: 2, willRetry: false })
  })

  test('identical-failure oscillation aborts retries early', async () => {
    const events: AgentEvent[] = []
    // Same criteria both times (order shuffled — the signature is order-independent).
    const verifier = createVerifierModel([
      failJson(['criterion A', 'criterion B']),
      failJson(['criterion B', 'criterion A']),
    ])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft 1'), textTurn('draft 2')],
      verifierModel: verifier.model,
      // Generous budget: only oscillation can stop the retries at attempt 2.
      verifier: { trigger: 'always', maxRetries: 5 },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.verification?.verdict).toBe('fail')
    expect(result.verification?.attempts).toBe(2)
    expect(result.verification?.warning).toContain('identical failures')
    expect(verifier.callCount()).toBe(2)

    const verdicts = events.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts[1]).toMatchObject({ attempt: 2, willRetry: false })
  })

  test('verifier error: emits verifier-error and accepts as unknown', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([new Error('verifier exploded')])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('answer')
    expect(result.verification?.verdict).toBe('unknown')
    expect(result.verification?.warning).toContain('Verifier error')

    const errorEvent = events.find((event) => event.type === 'verifier-error')
    expect(errorEvent).toMatchObject({ attempt: 1 })
    expect(events.find((event) => event.type === 'verifier-verdict')).toBeUndefined()
    // The loop still completed normally.
    expect(events.find((event) => event.type === 'turn-complete')).toBeDefined()
  })

  test('garbage verifier output degrades to unknown-accept, not a crash', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel(['this is not json at all'])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.verification?.verdict).toBe('unknown')
    expect(events.find((event) => event.type === 'verifier-error')).toBeDefined()
  })

  test('abort during verification returns cancelled', async () => {
    const events: AgentEvent[] = []
    const abort = new AbortController()
    const verifier = createVerifierModel([
      async () => {
        // Slow verifier: the abort fires while this call is in flight.
        abort.abort()
        await new Promise((resolve) => setTimeout(resolve, 20))
        return PASS_JSON
      },
    ])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it', { abortSignal: abort.signal })

    expect(result.stopReason).toBe('cancelled')
    expect(result.verification).toBeUndefined()
    expect(events.find((event) => event.type === 'turn-aborted')).toBeDefined()
    expect(events.find((event) => event.type === 'turn-complete')).toBeUndefined()
    expect(events.find((event) => event.type === 'verifier-verdict')).toBeUndefined()
  })

  test('mid-run steers are threaded into the verifier prompt and reset per run', async () => {
    const verifier = createVerifierModel([PASS_JSON, PASS_JSON])
    let agentRef: Agent | undefined
    let steered = false
    let steerResult: EnqueueSteerResult | undefined
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echoes',
      schema: z.object({}),
      execute: async () => {
        // Enqueue the steer from inside a tool call so it lands mid-run,
        // exactly like the JSON-RPC `agent/steer` handler would.
        if (!steered && agentRef) {
          steered = true
          steerResult = agentRef.enqueueSteer({ id: 'steer-1', text: 'Also update the changelog.' })
        }
        return ok({ echoed: true })
      },
    })
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('done'), toolCallTurn(1, 2), textTurn('done again')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { toolRegistry: registry },
    })
    agentRef = agent

    const first = await agent.run('do the task')

    expect(first.stopReason).toBe('completed')
    expect(steerResult).toEqual({ accepted: true })
    // The verifier judges against the original task PLUS the steer text.
    expect(verifier.prompts[0]).toContain('## Mid-run User Steering')
    expect(verifier.prompts[0]).toContain('Also update the changelog.')

    // Second run on the same agent: steer texts must not leak across runs.
    const second = await agent.run('next task')

    expect(second.stopReason).toBe('completed')
    expect(verifier.prompts[1]).not.toContain('## Mid-run User Steering')
    expect(verifier.prompts[1]).not.toContain('Also update the changelog.')
  })

  test('per-run verifier state resets when the same agent runs again', async () => {
    const events: AgentEvent[] = []
    // Run 1: identical failures → oscillation accept (this also leaves a stale
    // failure signature and verifierAttempt=2 behind if the reset is broken).
    // Run 2: fails once with the SAME criterion — which must read as a fresh
    // failure (retry), not an oscillation — then passes.
    const verifier = createVerifierModel([
      failJson(['criterion A']),
      failJson(['criterion A']),
      failJson(['criterion A']),
      PASS_JSON,
    ])
    const agent = makeAgent({
      actorTurns: [
        // Run 1: 5 tool calls, then two failing candidates.
        toolCallTurn(5),
        textTurn('draft 1'),
        textTurn('draft 2'),
        // Run 2: 2 tool calls, one failing candidate, then the accepted one.
        toolCallTurn(2, 2),
        textTurn('draft 3'),
        textTurn('final answer'),
      ],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 3 },
      events,
    })

    const first = await agent.run('first long task')

    expect(first.stopReason).toBe('completed')
    expect(first.verification?.verdict).toBe('fail')
    expect(first.verification?.attempts).toBe(2)
    expect(first.verification?.warning).toContain('identical failures')

    const firstRunEventCount = events.length
    const second = await agent.run('second task')

    expect(second.stopReason).toBe('completed')
    expect(second.text).toBe('final answer')
    // verifierAttempt reset: run 2 counts attempts from 1 again. Without the
    // reset the first failure would land at attempt 3 > maxRetries and count
    // as "retries exhausted".
    expect(second.verification).toEqual({ verdict: 'pass', attempts: 2 })

    const secondRunEvents = events.slice(firstRunEventCount)
    const started = secondRunEvents.find((event) => event.type === 'verifier-started')
    // runToolCallCount reset: only run 2's two calls are counted, not 5 + 2.
    expect(started).toMatchObject({ attempt: 1, toolCallCount: 2 })
    // lastVerifierFailureSignature reset: run 2's first failure repeats run 1's
    // criterion but is NOT an oscillation, so it still retries.
    const verdicts = secondRunEvents.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts[0]).toMatchObject({ verdict: 'fail', attempt: 1, willRetry: true })

    // Evidence ledger + task snapshot reset: run 2's prompt presents only
    // run 2's task and its two evidence entries — no stale run 1 evidence.
    const promptRun2 = verifier.prompts[2]
    expect(promptRun2).toContain('second task')
    expect(promptRun2).not.toContain('first long task')
    expect(promptRun2).toContain('2 tool call(s) were executed')
    expect(promptRun2).not.toContain('3. [echo')
  })

  test('evidence ledger keeps only the most recent 60 entries and notes the elision', async () => {
    const verifier = createVerifierModel([PASS_JSON])
    let seq = 0
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echoes',
      schema: z.object({}),
      // Distinguishable results so the test can tell WHICH entries survived.
      execute: async () => ok({ seq: ++seq }),
    })
    const agent = makeAgent({
      // 65 tool calls across two iterations, 5 over the cap of 60.
      actorTurns: [toolCallTurn(40, 1), toolCallTurn(25, 2), textTurn('done')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { toolRegistry: registry },
    })

    const result = await agent.run('do a very long task')

    expect(result.stopReason).toBe('completed')
    const prompt = verifier.prompts[0]
    expect(prompt).toContain('65 tool call(s) were executed')
    expect(prompt).toContain('[... 5 earlier tool call(s) elided ...]')
    // The cap keeps the LAST 60 entries: the earliest five results are gone,
    // the most recent survives, and numbering accounts for the elision.
    expect(prompt).not.toContain('{"seq":1}')
    expect(prompt).not.toContain('{"seq":5}')
    expect(prompt).toContain('6. [echo] {"seq":6}')
    expect(prompt).toContain('65. [echo] {"seq":65}')
    expect((prompt.match(/\[echo\]/g) ?? []).length).toBe(60)
  })

  test('verifier retries consume the maxSteps budget', async () => {
    const events: AgentEvent[] = []
    // Always fail with fresh criteria so retries keep going until maxSteps.
    const verifier = createVerifierModel(
      Array.from({ length: 10 }, (_, i) => failJson([`criterion ${i}`])),
    )
    const agent = makeAgent({
      actorTurns: [
        toolCallTurn(1),
        textTurn('draft 1'),
        textTurn('draft 2'),
        textTurn('handoff summary'),
      ],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 10 },
      events,
    })

    // 3 steps: tool turn + 2 candidate turns; the second retry hits maxSteps.
    const result = await agent.run('do it', { maxSteps: 3 })

    expect(result.stopReason).toBe('max_steps')
    expect(result.maxIterationsReached).toBe(true)
  })
})

describe('completion gate — done contract', () => {
  test('contract is extracted exactly once per run, including across retries, and re-extracted per run', async () => {
    const verifier = createVerifierModel([failJson(['criterion A']), PASS_JSON])
    const agent = makeAgent({
      actorTurns: [
        // Run 1: tool call, failing draft, passing retry.
        toolCallTurn(1),
        textTurn('draft answer'),
        textTurn('fixed answer'),
        // Run 2: tool call, accepted answer (responses clamp to PASS_JSON).
        toolCallTurn(1, 2),
        textTurn('second answer'),
      ],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
    })

    const first = await agent.run('do it')

    expect(first.stopReason).toBe('completed')
    expect(first.verification).toEqual({ verdict: 'pass', attempts: 2 })
    // Two verification calls (fail, then pass) but a single extraction: the
    // contract is cached for the retry instead of re-extracted.
    expect(verifier.callCount()).toBe(2)
    expect(verifier.contractCallCount()).toBe(1)

    const second = await agent.run('next task')

    expect(second.stopReason).toBe('completed')
    // The per-run cache resets: a new run extracts a fresh contract.
    expect(verifier.contractCallCount()).toBe(2)
    expect(verifier.contractPrompts[1]).toContain('next task')
    expect(verifier.contractPrompts[1]).not.toContain('do it')
  })

  test('extracted contract and standing criteria appear in the verifier prompt', async () => {
    const verifier = createVerifierModel([PASS_JSON], {
      contract: JSON.stringify({
        criteria: ['Custom criterion one', 'Custom criterion two'],
      }),
    })
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' }, // default standingCriteria apply
    })

    const result = await agent.run('build the widget')

    expect(result.stopReason).toBe('completed')
    // The extraction prompt carries the task but never the standing criteria
    // (they are appended verbatim, not sent for rewriting).
    expect(verifier.contractPrompts[0]).toContain('build the widget')
    expect(verifier.contractPrompts[0]).not.toContain(
      'No existing test was deleted, skipped, or weakened.',
    )
    // The verifier judges against the extracted criteria plus the standing
    // criteria from config.
    const prompt = verifier.prompts[0]
    expect(prompt).toContain('## Done Criteria')
    expect(prompt).toContain('Custom criterion one')
    expect(prompt).toContain('Custom criterion two')
    expect(prompt).toContain('Matching automated tests exist and pass for any behavior change.')
    expect(prompt).toContain('No existing test was deleted, skipped, or weakened.')
    expect(prompt).not.toContain('No explicit criteria were provided')
  })

  test('extraction failure degrades to criteria-free verification with a warning, without re-extracting', async () => {
    const events: AgentEvent[] = []
    const verifier = createVerifierModel([failJson(['criterion A']), PASS_JSON], {
      contract: new Error('extractor down'),
    })
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft answer'), textTurn('fixed answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      events,
    })

    const result = await agent.run('do it')

    // The gate still ran to a verdict — extraction failure never bricks it.
    expect(result.stopReason).toBe('completed')
    expect(result.verification?.verdict).toBe('pass')
    expect(result.verification?.warning).toContain('Done-contract extraction failed')
    // The failed extraction is cached as "no criteria" — the retry must not
    // trigger a second extraction attempt.
    expect(verifier.contractCallCount()).toBe(1)
    expect(verifier.callCount()).toBe(2)
    // Both verification prompts fell back to deriving criteria from the task.
    expect(verifier.prompts[0]).toContain('No explicit criteria were provided')
    expect(verifier.prompts[1]).toContain('No explicit criteria were provided')
  })

  test('extraction-failure warning does not leak into a later run on the same agent', async () => {
    // Run 1's extraction fails; run 2's succeeds. The stale warning must be
    // reset at run entry or it would surface on run 2's clean verification.
    let extractionCalls = 0
    const verifier = createVerifierModel([PASS_JSON, PASS_JSON], {
      contract: async () => {
        extractionCalls++
        if (extractionCalls === 1) throw new Error('extractor down')
        return DEFAULT_CONTRACT_JSON
      },
    })
    const agent = makeAgent({
      actorTurns: [
        toolCallTurn(1),
        textTurn('first answer'),
        toolCallTurn(1, 2),
        textTurn('second answer'),
      ],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
    })

    const first = await agent.run('first task')

    expect(first.stopReason).toBe('completed')
    expect(first.verification?.verdict).toBe('pass')
    expect(first.verification?.warning).toContain('Done-contract extraction failed')

    const second = await agent.run('second task')

    expect(second.stopReason).toBe('completed')
    expect(extractionCalls).toBe(2)
    // A clean pass with a fresh contract: no stale warning from run 1.
    expect(second.verification).toEqual({ verdict: 'pass', attempts: 1 })
    expect(second.verification?.warning).toBeUndefined()
  })

  test('extracted done contract is persisted into the session checkpoint', async () => {
    const tempDir = join(
      tmpdir(),
      `ouroboros-agent-verifier-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })
    try {
      const sessionId = 'verifier-checkpoint-session'
      const verifier = createVerifierModel([PASS_JSON], {
        contract: JSON.stringify({ criteria: ['Custom checkpoint criterion'] }),
      })
      const agent = makeAgent({
        actorTurns: [toolCallTurn(1), textTurn('answer')],
        verifierModel: verifier.model,
        verifier: { trigger: 'always' },
        overrides: { memoryBasePath: tempDir, sessionId },
      })

      const result = await agent.run('persist my contract')

      expect(result.stopReason).toBe('completed')
      expect(verifier.contractCallCount()).toBe(1)

      // shutdown() runs the same captureObservationsAndRefreshCheckpoint path
      // that mid-run flush/compact uses; it must thread lastDoneContract into
      // reflectCheckpoint so completion criteria survive compaction.
      await agent.shutdown()

      const checkpointPath = resolveCheckpointPath(sessionId, tempDir)
      expect(existsSync(checkpointPath)).toBe(true)
      const markdown = readFileSync(checkpointPath, 'utf-8')
      expect(markdown).toContain('## Done Contract')
      expect(markdown).toContain('Custom checkpoint criterion')
      // Standing criteria ride along — they are part of the extracted contract.
      expect(markdown).toContain('Matching automated tests exist and pass for any behavior change.')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('completion gate — tier-4 escalation', () => {
  afterEach(() => {
    // The tier-approval handler is module-global state — always reset.
    setTierApprovalHandler(null)
  })

  test('retries exhausted: approval accepts the failing answer and the report reaches the handler', async () => {
    const events: AgentEvent[] = []
    const received: Array<{
      toolName: string
      toolTier: ToolTier
      args: unknown
      extras?: TierApprovalExtras
    }> = []
    setTierApprovalHandler(async (toolName, toolTier, args, extras) => {
      received.push({ toolName, toolTier, args, extras })
      return ok(undefined)
    })

    const verifier = createVerifierModel([failJson(['criterion A'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('the answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('the answer')
    expect(result.verification?.verdict).toBe('fail')
    expect(result.verification?.attempts).toBe(1)
    expect(result.verification?.warning).toContain('human reviewer approved')

    // Exactly one escalation, addressed to the completion-override pseudo-tool
    // at tier 4, carrying the task, an answer preview, and the verifier report.
    expect(received).toHaveLength(1)
    expect(received[0].toolName).toBe('verifier-completion-override')
    expect(received[0].toolTier).toBe(4)
    expect(received[0].args).toMatchObject({ task: 'do it', answerPreview: 'the answer' })
    expect(received[0].extras?.verifierReport).toMatchObject({
      verdict: 'fail',
      attempt: 1,
      toolCallCount: 1,
    })
    expect(typeof received[0].extras?.verifierReport?.checkedAt).toBe('string')

    // The final verdict event reports the escalation.
    const verdicts = events.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({
      verdict: 'fail',
      attempt: 1,
      willRetry: false,
      escalated: true,
    })
  })

  test('denial grants exactly one extra retry batch; second exhaustion accepts without re-prompting', async () => {
    const events: AgentEvent[] = []
    let handlerCalls = 0
    setTierApprovalHandler(async () => {
      handlerCalls++
      return err(new Error('Reviewer says: docs missing'))
    })

    // Different criteria so the second batch is a fresh failure, not oscillation.
    const verifier = createVerifierModel([failJson(['criterion A']), failJson(['criterion B'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft 1'), textTurn('draft 2')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
      events,
    })

    const result = await agent.run('do it')

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('draft 2')
    // The second exhaustion accepted with a warning instead of re-prompting.
    expect(handlerCalls).toBe(1)
    expect(result.verification?.verdict).toBe('fail')
    expect(result.verification?.warning).toContain('retries exhausted')

    // The denial reason was injected into the retry feedback.
    const feedback = agent
      .getConversationHistory()
      .find(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('A human reviewer declined to accept the current answer'),
      )
    expect(feedback).toBeDefined()
    expect(feedback && (feedback.content as string)).toContain('Reviewer says: docs missing')

    // First verdict: escalated denial → retry. Second: fresh batch (attempt
    // counter reset) exhausting again → plain accept, no escalation.
    const verdicts = events.filter((event) => event.type === 'verifier-verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toMatchObject({ attempt: 1, willRetry: true, escalated: true })
    expect(verdicts[1]).toMatchObject({ attempt: 1, willRetry: false, escalated: false })
  })

  test('escalation availability resets per run: a second run on the same agent can escalate again', async () => {
    // Run 1 escalates and is approved, marking verifierEscalationUsed. Without
    // the per-run reset at run() entry, run 2's exhaustion could never reach
    // the handler and would degrade to a plain "retries exhausted" accept.
    let handlerCalls = 0
    setTierApprovalHandler(async () => {
      handlerCalls++
      return ok(undefined)
    })

    const verifier = createVerifierModel([failJson(['criterion A']), failJson(['criterion B'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('answer 1'), toolCallTurn(1, 2), textTurn('answer 2')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
    })

    const first = await agent.run('first task')

    expect(first.stopReason).toBe('completed')
    expect(handlerCalls).toBe(1)
    expect(first.verification?.warning).toContain('human reviewer approved')

    const second = await agent.run('second task')

    expect(second.stopReason).toBe('completed')
    expect(second.text).toBe('answer 2')
    // The once-per-run guard reset: run 2's exhaustion escalates again.
    expect(handlerCalls).toBe(2)
    expect(second.verification?.verdict).toBe('fail')
    expect(second.verification?.warning).toContain('human reviewer approved')
    expect(second.verification?.warning).not.toContain('retries exhausted')
  })

  test('abort while waiting for the escalation approval returns cancelled', async () => {
    const events: AgentEvent[] = []
    const abort = new AbortController()
    setTierApprovalHandler(() => {
      // Simulate a human who never answers; the cancel must win the race.
      abort.abort()
      return new Promise(() => {})
    })

    const verifier = createVerifierModel([failJson(['criterion A'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('the answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
      events,
    })

    const result = await agent.run('do it', { abortSignal: abort.signal })

    expect(result.stopReason).toBe('cancelled')
    expect(result.verification).toBeUndefined()
    expect(events.find((event) => event.type === 'turn-aborted')).toBeDefined()
    expect(events.find((event) => event.type === 'turn-complete')).toBeUndefined()
  })
})

describe('completion gate — RSI integration', () => {
  const tempDirs: string[] = []

  function makeMemoryDir(): string {
    const dir = join(
      tmpdir(),
      `ouroboros-verifier-rsi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    setTierApprovalHandler(null)
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a final pass verdict writes a verifier-verdict evolution entry to the memory base path', async () => {
    const memoryDir = makeMemoryDir()
    const verifier = createVerifierModel([PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('done')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { memoryBasePath: memoryDir, sessionId: 'sess-rsi' },
    })

    const result = await agent.run('do the task')

    expect(result.verification?.verdict).toBe('pass')
    const log = readLog(memoryDir)
    expect(log.ok).toBe(true)
    if (!log.ok) return
    expect(log.value).toHaveLength(1)
    expect(log.value[0].type).toBe('verifier-verdict')
    expect(log.value[0].summary).toContain('pass')
    expect(log.value[0].details).toMatchObject({
      sessionId: 'sess-rsi',
      verdict: 'pass',
      failureCount: 0,
    })
  })

  test('retried runs log only the final verdict, not intermediate failures', async () => {
    const memoryDir = makeMemoryDir()
    const verifier = createVerifierModel([failJson(['criterion A']), PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('draft'), textTurn('final')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { memoryBasePath: memoryDir },
    })

    const result = await agent.run('do the task')

    expect(result.verification).toEqual({ verdict: 'pass', attempts: 2 })
    const log = readLog(memoryDir)
    expect(log.ok).toBe(true)
    if (!log.ok) return
    expect(log.value).toHaveLength(1)
    expect(log.value[0].details.verdict).toBe('pass')
  })

  test('an exhausted fail without an approval handler logs the failure count', async () => {
    const memoryDir = makeMemoryDir()
    const verifier = createVerifierModel([failJson(['criterion A', 'criterion B'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('the answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
      overrides: { memoryBasePath: memoryDir },
    })

    const result = await agent.run('do the task')

    expect(result.verification?.verdict).toBe('fail')
    const log = readLog(memoryDir)
    expect(log.ok).toBe(true)
    if (!log.ok) return
    expect(log.value).toHaveLength(1)
    expect(log.value[0].details).toMatchObject({ verdict: 'fail', failureCount: 2 })
  })

  test('an escalated human-approved completion logs a fail verdict', async () => {
    const memoryDir = makeMemoryDir()
    setTierApprovalHandler(async () => ok(undefined))
    const verifier = createVerifierModel([failJson(['criterion A'])])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('the answer')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always', maxRetries: 0 },
      overrides: { memoryBasePath: memoryDir },
    })

    const result = await agent.run('do the task')

    expect(result.verification?.warning).toContain('human reviewer approved')
    const log = readLog(memoryDir)
    expect(log.ok).toBe(true)
    if (!log.ok) return
    expect(log.value).toHaveLength(1)
    expect(log.value[0].details).toMatchObject({ verdict: 'fail', failureCount: 1 })
  })

  test('ungated runs write no evolution entry and leave getLastVerifierReport null', async () => {
    const memoryDir = makeMemoryDir()
    const forbidden = createForbiddenVerifierModel()
    const agent = makeAgent({
      actorTurns: [toolCallTurn(6), textTurn('done')],
      verifierModel: forbidden.model,
      verifier: { trigger: 'off' },
      overrides: { memoryBasePath: memoryDir },
    })

    const result = await agent.run('do the long task')

    expect(result.stopReason).toBe('completed')
    expect(agent.getLastVerifierReport()).toBeNull()
    expect(existsSync(join(memoryDir, 'evolution.log.json'))).toBe(false)
  })

  test('getLastVerifierReport returns the final verdict and survives run() exit', async () => {
    const verifier = createVerifierModel([failJson(['criterion A']), PASS_JSON])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(2), textTurn('draft'), textTurn('final')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { memoryBasePath: makeMemoryDir() },
    })

    expect(agent.getLastVerifierReport()).toBeNull()

    await agent.run('do the task')

    const report = agent.getLastVerifierReport()
    expect(report).toMatchObject({
      verdict: 'pass',
      attempt: 2,
      toolCallCount: 2,
      failureCount: 0,
    })
    expect(typeof report?.checkedAt).toBe('string')
  })

  test('a verifier error records no final verdict', async () => {
    const memoryDir = makeMemoryDir()
    const verifier = createVerifierModel([new Error('verifier transport down')])
    const agent = makeAgent({
      actorTurns: [toolCallTurn(1), textTurn('done')],
      verifierModel: verifier.model,
      verifier: { trigger: 'always' },
      overrides: { memoryBasePath: memoryDir },
    })

    const result = await agent.run('do the task')

    expect(result.verification?.verdict).toBe('unknown')
    expect(result.verification?.warning).toContain('Verifier error')
    // Errors are not verdicts: nothing cached, nothing logged.
    expect(agent.getLastVerifierReport()).toBeNull()
    expect(existsSync(join(memoryDir, 'evolution.log.json'))).toBe(false)
  })
})
