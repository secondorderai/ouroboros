import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'
import { DEFAULT_MEMORY_CONFIG, DEFAULT_VERIFIER_CONFIG } from '@src/config'
import { hardenHtml } from '@src/artifacts/csp'

type Options = Record<string, unknown>
type Policy = Record<string, string | number | boolean>
interface ExplorerModel {
  defaults: Record<string, number>
  topics: string[]
  assemblePrompt: (options?: Options) => { parts: string[][]; text: string }
  contextPolicy: (usage: unknown, saved?: boolean) => Policy
  harnessPolicy: (options: Options) => Policy
  evidenceVerdict: (options: Options) => Policy
  completionGate: (options: Options) => Policy
  loopStage: (
    mode: string,
    index: number,
    success?: boolean,
  ) => { index: number; title: string; body: string; labels: string[]; last: boolean }
  move: (index: number, delta: number, length: number) => number
}

const htmlPath = fileURLToPath(
  new URL('../../../../docs/ouroboros-engineering.html', import.meta.url),
)
const html = readFileSync(htmlPath, 'utf8')
const modelSource = html.match(/<script id="engineering-model">([\s\S]*?)<\/script>/)?.[1]
if (!modelSource) throw new Error('The actual standalone app must contain its testable model')
const context = createContext({})
new Script(modelSource, { filename: 'engineering-model.js' }).runInContext(context)
const model = context.EngineeringModel as ExplorerModel
const validCall = { action: 'edit', mode: 'primary', valid: true, scoped: true, approval: false }
const completeEvidence = { output: 'passing', patch: true, regression: true, preserved: true }
const gate = { verdict: 'fail', calls: 6, trigger: 'long-tasks', attempt: 1, approval: true }

describe('engineering explorer standalone document', () => {
  test('contains all five explanations, accessible panels, and an offline Mermaid export', () => {
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('<html lang="en"')
    expect(html.match(/role="tabpanel"/g)).toHaveLength(5)
    expect(html.match(/role="tab"/g)).toHaveLength(5)
    for (const name of [
      'Prompt Engineering',
      'Context Engineering',
      'Agent Harness Engineering',
      'Agent Evals Engineering',
      'Loop Engineering',
    ]) {
      expect(html).toContain(name)
    }
    expect(html).toContain('id="architecture-mermaid"')
    expect(html).toContain('aria-labelledby="map-title"')
    expect(html).toContain('<noscript>')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toContain('f732fd3a0ed67030b87294fe5b1e86ec5111993c')
  })

  test('is under the artifact limit with no runtime network or dynamic evaluation dependencies', () => {
    expect(Buffer.byteLength(html)).toBeLessThan(1_048_576)
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i)
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i)
    expect(html).not.toMatch(/\b(?:fetch|eval)\s*\(|\bnew\s+Function\s*\(/)
    expect(html).not.toContain('localStorage')
  })

  test('passes the real artifact hardener without warnings', () => {
    const result = hardenHtml(html, [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings).toEqual([])
    expect(result.value.html).toContain("connect-src 'none'")
    expect(result.value.html).toContain("script-src 'unsafe-inline'")
    expect(result.value.html).toContain(modelSource!)
  })
})

describe('actual inline prompt and context model', () => {
  test('includes base guidance and progressively activates optional sections in source order', () => {
    const base = model.assemblePrompt()
    expect(base.text).toContain('Base instructions')
    expect(base.text).toContain('Skill catalog')
    expect(base.text).not.toContain('Activated skill:')
    const full = model.assemblePrompt({ agents: true, memory: true, skill: true, plan: true })
    expect(Array.from(full.parts, (part) => part[0])).toEqual([
      'Base instructions',
      'Response format',
      'Active mode: Plan',
      'Available tools',
      'Skill catalog',
      'Activated skill: testing-workflow',
      'Memory Context',
      'AGENTS.md Instructions',
      'Self-Improvement',
    ])
    expect(full.text).toContain('native tool definitions')
  })

  test('toggling context and instructions does not remove base safety guidance', () => {
    const output = model.assemblePrompt({ agents: false, memory: false, skill: false, plan: false })
    expect(output.text).not.toContain('## Memory Context')
    expect(output.text).not.toContain('## AGENTS.md Instructions')
    expect(output.text).toContain('Respect permission tiers')
  })

  test('teaching defaults match real configurable runtime defaults', () => {
    expect(model.defaults.warn).toBe(DEFAULT_MEMORY_CONFIG.warnRatio * 100)
    expect(model.defaults.flush).toBe(DEFAULT_MEMORY_CONFIG.flushRatio * 100)
    expect(model.defaults.compact).toBe(DEFAULT_MEMORY_CONFIG.compactRatio * 100)
    expect(model.defaults.minToolCalls).toBe(DEFAULT_VERIFIER_CONFIG.minToolCalls)
    expect(model.defaults.maxRetries).toBe(DEFAULT_VERIFIER_CONFIG.maxRetries)
  })

  test.each([
    [0, 'Within budget'],
    [69, 'Within budget'],
    [70, 'Warning'],
    [79, 'Warning'],
    [80, 'Flush state'],
    [89, 'Flush state'],
    [90, 'Compact'],
    [100, 'Compact'],
  ])('context utilization %p maps to %p', (usage, phase) => {
    expect(model.contextPolicy(usage).phase).toBe(phase)
  })

  test('normal compaction retains history when checkpoint refresh fails', () => {
    const result = model.contextPolicy(90, false)
    expect(result.phase).toBe('Compaction blocked')
    expect(result.run).toContain('raw history retained')
    expect(model.contextPolicy(80).run).toContain('Raw history remains intact')
  })

  test('normalizes malformed and out-of-range context inputs', () => {
    expect(model.contextPolicy('bad').phase).toBe('Within budget')
    expect(model.contextPolicy(-1).phase).toBe('Within budget')
    expect(model.contextPolicy(101).phase).toBe('Compact')
  })
})

describe('actual inline harness and evaluator models', () => {
  test('matches representative actual tool tiers', () => {
    for (const [action, tier] of Object.entries({
      read: 0,
      edit: 1,
      skill: 2,
      memory: 3,
      install: 4,
    })) {
      expect(model.harnessPolicy({ ...validCall, action }).tier).toBe(tier)
    }
  })

  test('read-only role and Plan mode cannot be overridden by a tier approval', () => {
    for (const mode of ['plan', 'explore']) {
      const result = model.harnessPolicy({ ...validCall, mode, approval: true })
      expect(result.decision).toBe('Blocked before execution')
      expect(result.auth).toBe('Not reached')
      expect(model.harnessPolicy({ ...validCall, mode, action: 'read' }).tone).toBe('green')
    }
  })

  test('invalid arguments are rejected before authorization', () => {
    const result = model.harnessPolicy({ ...validCall, valid: false, scoped: false })
    expect(result.decision).toBe('Invalid tool arguments')
    expect(result.auth).toBe('Not reached')
  })

  test('disabled tiers await approval, and approval authorizes only that route', () => {
    expect(model.harnessPolicy({ ...validCall, action: 'memory' }).decision).toBe(
      'Wait for human approval',
    )
    expect(model.harnessPolicy({ ...validCall, action: 'memory', approval: true }).tone).toBe(
      'green',
    )
    expect(model.harnessPolicy({ ...validCall, scoped: false }).decision).toBe(
      'Wait for human approval',
    )
    expect(model.harnessPolicy({ ...validCall, action: 'bypass', approval: true }).decision).toBe(
      'Approved unsandboxed route',
    )
  })

  test('a generic approval does not erase protected child-process writes', () => {
    const result = model.harnessPolicy({ ...validCall, action: 'protected', approval: true })
    expect(result.decision).toBe('Blocked by OS sandbox')
    expect(result.detail).toContain('separately authorized tier-4')
  })

  test('distinguishes supporting, contradictory, and missing evidence', () => {
    expect(model.evidenceVerdict(completeEvidence).verdict).toBe('pass')
    expect(model.evidenceVerdict({ ...completeEvidence, output: 'failing' }).verdict).toBe('fail')
    expect(model.evidenceVerdict({ ...completeEvidence, preserved: false }).verdict).toBe('fail')
    for (const missing of [{ output: 'missing' }, { patch: false }, { regression: false }]) {
      expect(model.evidenceVerdict({ ...completeEvidence, ...missing }).verdict).toBe('unknown')
    }
    expect(model.evidenceVerdict({ ...completeEvidence, output: 'error' }).error).toBe(true)
  })

  test('gates on trigger and tool-call count without labeling skipped work a pass', () => {
    expect(model.completionGate({ ...gate, calls: 4 }).action).toBe('skip')
    expect(model.completionGate({ ...gate, calls: 5 }).action).toBe('retry')
    expect(model.completionGate({ ...gate, trigger: 'off' }).action).toBe('skip')
    expect(model.completionGate({ ...gate, trigger: 'always', calls: 0 }).action).toBe('skip')
    expect(model.completionGate({ ...gate, trigger: 'always', calls: 1 }).action).toBe('retry')
  })

  test('allows two retries, then escalates when possible or returns warnings', () => {
    expect(model.completionGate({ ...gate, attempt: 1 }).action).toBe('retry')
    expect(model.completionGate({ ...gate, attempt: 2 }).action).toBe('retry')
    expect(model.completionGate({ ...gate, attempt: 3 }).action).toBe('escalate')
    expect(model.completionGate({ ...gate, repeated: true }).action).toBe('escalate')
    expect(model.completionGate({ ...gate, attempt: 3, approval: false }).action).toBe('warn')
    expect(model.completionGate({ ...gate, verdict: 'unknown' }).action).toBe('warn')
    expect(model.completionGate({ ...gate, error: true }).action).toBe('warn')
    expect(model.completionGate({ ...gate, verdict: 'pass' }).action).toBe('accept')
  })
})

describe('actual inline loop and walkthrough transitions', () => {
  test('bounds previous, next, and terminal walkthrough stages', () => {
    expect(model.move(0, -1, 5)).toBe(0)
    expect(model.move(0, 1, 5)).toBe(1)
    expect(model.move(4, 1, 5)).toBe(4)
    expect(model.move(4, -4, 5)).toBe(0)
  })

  test('task and learning loops have separate states and terminal boundaries', () => {
    expect(model.loopStage('task', 0).title).toBe('Plan')
    expect(model.loopStage('learning', 0).title).toBe('Observe')
    expect(model.loopStage('task', 5).last).toBe(true)
    expect(model.loopStage('learning', 5).title).toBe('Reuse')
    expect(model.loopStage('learning', 5).body).toContain('not model weights')
  })

  test('failing observations do not become a successful handoff or safe skill adoption', () => {
    expect(model.loopStage('task', 5, false).title).toBe('Hand off incomplete')
    const failed = model.loopStage('learning', 3, false)
    expect(failed.title).toBe('Skill tests failed')
    expect(failed.body).toContain('no automatic rollback')
  })
})
