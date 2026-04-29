import { describe, test, expect, beforeEach } from 'bun:test'
import { ModeManager } from '@src/modes/manager'
import { PLAN_MODE } from '@src/modes/plan/definition'
import * as enterModeTool from '@src/modes/tools/enter-mode'
import * as submitPlanTool from '@src/modes/tools/submit-plan'
import * as exitModeTool from '@src/modes/tools/exit-mode'

describe('Mode Tools', () => {
  let manager: ModeManager

  beforeEach(() => {
    manager = new ModeManager()
    manager.registerMode(PLAN_MODE)
    enterModeTool.setModeManager(manager)
    submitPlanTool.setModeManager(manager)
    exitModeTool.setModeManager(manager)
  })

  describe('enter-mode', () => {
    test('has correct tool metadata', () => {
      expect(enterModeTool.name).toBe('enter-mode')
      expect(enterModeTool.description).toBeTruthy()
    })

    test('enters plan mode', async () => {
      const result = await enterModeTool.execute({ mode: 'plan', reason: 'test' })
      expect(result.ok).toBe(true)
      expect(manager.getActiveMode().status).toBe('active')
    })

    test('returns guidance text on success', async () => {
      const result = await enterModeTool.execute({ mode: 'plan' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toContain('Plan mode')
        expect(result.value).toContain('submit-plan')
      }
    })

    test('fails if already in a mode', async () => {
      await enterModeTool.execute({ mode: 'plan' })
      const result = await enterModeTool.execute({ mode: 'plan' })
      expect(result.ok).toBe(false)
    })
  })

  describe('submit-plan', () => {
    test('has correct tool metadata', () => {
      expect(submitPlanTool.name).toBe('submit-plan')
    })

    test('submits a plan in plan mode', async () => {
      await enterModeTool.execute({ mode: 'plan' })

      const result = await submitPlanTool.execute({
        title: 'Test Plan',
        summary: 'A test plan for testing.',
        steps: [
          {
            description: 'Step 1: Do the thing',
            targetFiles: ['src/main.ts'],
            tools: ['file-edit'],
          },
        ],
        exploredFiles: ['src/main.ts'],
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toContain('Test Plan')
        expect(result.value).toContain('Do NOT call ask-user')
      }

      const plan = manager.getCurrentPlan()
      expect(plan).not.toBeNull()
      expect(plan!.status).toBe('submitted')
    })

    test('emits a plan-submitted event', async () => {
      const events: unknown[] = []
      manager = new ModeManager((event) => events.push(event))
      manager.registerMode(PLAN_MODE)
      enterModeTool.setModeManager(manager)
      submitPlanTool.setModeManager(manager)

      await enterModeTool.execute({ mode: 'plan' })
      const result = await submitPlanTool.execute({
        title: 'Event Plan',
        summary: 'A plan that should notify listeners.',
        steps: [{ description: 'Check the event', targetFiles: ['src/main.ts'], tools: [] }],
        exploredFiles: ['src/main.ts'],
      })

      expect(result.ok).toBe(true)
      expect(events).toContainEqual({
        type: 'plan-submitted',
        plan: expect.objectContaining({
          title: 'Event Plan',
          status: 'submitted',
        }),
      })
    })

    test('fails when not in plan mode', async () => {
      const result = await submitPlanTool.execute({
        title: 'Test',
        summary: 'Test',
        steps: [{ description: 'Step', targetFiles: [], tools: [] }],
        exploredFiles: [],
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('exit-mode', () => {
    test('has correct tool metadata', () => {
      expect(exitModeTool.name).toBe('exit-mode')
    })

    test('exits the current mode', async () => {
      await enterModeTool.execute({ mode: 'plan' })
      const result = await exitModeTool.execute({ reason: 'plan approved' })
      expect(result.ok).toBe(true)
      expect(manager.getActiveMode().status).toBe('inactive')
    })

    test('returns guidance text on success', async () => {
      await enterModeTool.execute({ mode: 'plan' })
      const result = await exitModeTool.execute({})
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toContain('Exited')
        expect(result.value).toContain('All tools are now available')
      }
    })

    test('fails when no mode is active', async () => {
      const result = await exitModeTool.execute({})
      expect(result.ok).toBe(false)
    })
  })
})
