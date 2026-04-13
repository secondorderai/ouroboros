import { describe, test, expect, beforeEach } from 'bun:test'
import { ModeManager } from '@src/modes/manager'
import type { ModeDefinition, ModeEvent } from '@src/modes/types'
import type { Plan } from '@src/modes/plan/types'
import type { ToolMetadata } from '@src/tools/types'

// ── Helpers ──────────────────────────────────────────────────────────

function makePlanMode(overrides?: Partial<ModeDefinition>): ModeDefinition {
  return {
    id: 'plan',
    displayName: 'Plan',
    systemPromptSection: '## Active Mode: Plan\n\nYou are in plan mode.',
    allowedTools: ['file-read', 'bash', 'ask-user', 'submit-plan', 'exit-mode'],
    blockedTools: ['file-write', 'file-edit'],
    autoDetectable: true,
    autoDetectionHint: 'Use plan mode for complex tasks.',
    bashInterceptor: (cmd) => (cmd.includes('rm') ? 'Blocked: destructive command' : null),
    ...overrides,
  }
}

function makeTool(name: string): ToolMetadata {
  return { name, description: `Test: ${name}`, parameters: {} }
}

function collectEvents(): { events: ModeEvent[]; handler: (e: ModeEvent) => void } {
  const events: ModeEvent[] = []
  return { events, handler: (e: ModeEvent) => events.push(e) }
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    title: 'Test Plan',
    summary: 'A test plan.',
    steps: [{ description: 'Step 1', targetFiles: ['a.ts'], tools: ['file-edit'], dependsOn: [] }],
    exploredFiles: ['a.ts'],
    status: 'draft',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ModeManager', () => {
  let manager: ModeManager
  let events: ModeEvent[]

  beforeEach(() => {
    const collected = collectEvents()
    events = collected.events
    manager = new ModeManager(collected.handler)
    manager.registerMode(makePlanMode())
  })

  describe('enterMode', () => {
    test('enters a registered mode', () => {
      const result = manager.enterMode('plan', 'complex task')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe('Plan')

      const state = manager.getActiveMode()
      expect(state.status).toBe('active')
      if (state.status === 'active') {
        expect(state.modeId).toBe('plan')
      }
    })

    test('emits mode-entered event', () => {
      manager.enterMode('plan', 'testing')
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('mode-entered')
      if (events[0].type === 'mode-entered') {
        expect(events[0].modeId).toBe('plan')
        expect(events[0].displayName).toBe('Plan')
        expect(events[0].reason).toBe('testing')
      }
    })

    test('fails if already in a mode', () => {
      manager.enterMode('plan')
      const result = manager.enterMode('plan')
      expect(result.ok).toBe(false)
    })

    test('fails for unknown mode', () => {
      const result = manager.enterMode('unknown' as any)
      expect(result.ok).toBe(false)
    })
  })

  describe('exitMode', () => {
    test('exits the current mode', () => {
      manager.enterMode('plan')
      const result = manager.exitMode('done')
      expect(result.ok).toBe(true)
      expect(manager.getActiveMode().status).toBe('inactive')
    })

    test('emits mode-exited event', () => {
      manager.enterMode('plan')
      events.length = 0
      manager.exitMode('done')
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('mode-exited')
    })

    test('fails when no mode is active', () => {
      const result = manager.exitMode()
      expect(result.ok).toBe(false)
    })

    test('clears the current plan on exit', () => {
      manager.enterMode('plan')
      manager.submitPlan(makePlan())
      expect(manager.getCurrentPlan()).not.toBeNull()
      manager.exitMode()
      expect(manager.getCurrentPlan()).toBeNull()
    })
  })

  describe('getPromptOverlay', () => {
    test('returns auto-detection hints when no mode is active', () => {
      const overlay = manager.getPromptOverlay()
      expect(overlay.section).toBeUndefined()
      expect(overlay.autoDetectionHints).toHaveLength(1)
      expect(overlay.autoDetectionHints[0]).toContain('plan mode')
    })

    test('returns section when mode is active', () => {
      manager.enterMode('plan')
      const overlay = manager.getPromptOverlay()
      expect(overlay.section).toContain('Active Mode: Plan')
      expect(overlay.autoDetectionHints).toHaveLength(0)
    })
  })

  describe('filterTools', () => {
    test('shows enter-mode when inactive, hides submit-plan and exit-mode', () => {
      const tools = [
        makeTool('file-read'),
        makeTool('file-write'),
        makeTool('enter-mode'),
        makeTool('submit-plan'),
        makeTool('exit-mode'),
      ]
      const filtered = manager.filterTools(tools)
      const names = filtered.map((t) => t.name)
      expect(names).toContain('enter-mode')
      expect(names).not.toContain('submit-plan')
      expect(names).not.toContain('exit-mode')
      expect(names).toContain('file-read')
      expect(names).toContain('file-write')
    })

    test('applies allow/block lists when mode is active', () => {
      manager.enterMode('plan')
      const tools = [
        makeTool('file-read'),
        makeTool('file-write'),
        makeTool('bash'),
        makeTool('ask-user'),
        makeTool('enter-mode'),
        makeTool('submit-plan'),
        makeTool('exit-mode'),
      ]
      const filtered = manager.filterTools(tools)
      const names = filtered.map((t) => t.name)

      // Allowed tools
      expect(names).toContain('file-read')
      expect(names).toContain('bash')
      expect(names).toContain('ask-user')
      expect(names).toContain('submit-plan')
      expect(names).toContain('exit-mode')

      // Blocked tools
      expect(names).not.toContain('file-write')
      expect(names).not.toContain('enter-mode')
    })
  })

  describe('interceptBash', () => {
    test('returns null when no mode is active', () => {
      expect(manager.interceptBash('rm -rf /')).toBeNull()
    })

    test('blocks matching commands in active mode', () => {
      manager.enterMode('plan')
      const result = manager.interceptBash('rm -rf /')
      expect(result).not.toBeNull()
      expect(result).toContain('Blocked')
    })

    test('allows non-matching commands in active mode', () => {
      manager.enterMode('plan')
      expect(manager.interceptBash('ls -la')).toBeNull()
    })
  })

  describe('plan lifecycle', () => {
    test('submit, approve, and retrieve plan', () => {
      manager.enterMode('plan')
      const plan = makePlan()
      manager.submitPlan(plan)

      const current = manager.getCurrentPlan()
      expect(current).not.toBeNull()
      expect(current!.status).toBe('submitted')
      expect(current!.title).toBe('Test Plan')

      const approved = manager.approvePlan()
      expect(approved.ok).toBe(true)
      if (approved.ok) {
        expect(approved.value.status).toBe('approved')
      }
    })

    test('reject plan stores feedback', () => {
      manager.enterMode('plan')
      manager.submitPlan(makePlan())
      manager.rejectPlan('Needs more detail')

      const current = manager.getCurrentPlan()
      expect(current!.status).toBe('rejected')
      expect(current!.feedback).toBe('Needs more detail')
    })

    test('approvePlan fails when no plan submitted', () => {
      manager.enterMode('plan')
      const result = manager.approvePlan()
      expect(result.ok).toBe(false)
    })
  })
})
