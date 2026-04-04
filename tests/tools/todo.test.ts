import { describe, test, expect, beforeEach } from 'bun:test'
import { execute, schema, _resetTasks } from '@src/tools/todo'

describe('TodoTool', () => {
  beforeEach(() => {
    _resetTasks()
  })

  // -----------------------------------------------------------------------
  // Feature test: TodoTool round-trip
  // -----------------------------------------------------------------------
  test('add → list → complete → list round-trip', async () => {
    // Add a task.
    const addResult = await execute(schema.parse({ action: 'add', task: 'Write tests' }))
    expect(addResult.ok).toBe(true)
    if (addResult.ok) {
      expect(addResult.value.tasks).toHaveLength(1)
      expect(addResult.value.tasks[0].task).toBe('Write tests')
      expect(addResult.value.tasks[0].completed).toBe(false)
      expect(addResult.value.tasks[0].id).toBe(1)
    }

    // List tasks.
    const listResult = await execute(schema.parse({ action: 'list' }))
    expect(listResult.ok).toBe(true)
    if (listResult.ok) {
      expect(listResult.value.tasks).toHaveLength(1)
    }

    // Complete task 1.
    const completeResult = await execute(schema.parse({ action: 'complete', id: 1 }))
    expect(completeResult.ok).toBe(true)
    if (completeResult.ok) {
      expect(completeResult.value.tasks[0].completed).toBe(true)
    }

    // List again — task should show as completed.
    const listResult2 = await execute(schema.parse({ action: 'list' }))
    expect(listResult2.ok).toBe(true)
    if (listResult2.ok) {
      expect(listResult2.value.tasks[0].completed).toBe(true)
    }
  })

  test('add requires task parameter', async () => {
    const result = await execute(schema.parse({ action: 'add' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('"task" is required')
    }
  })

  test('complete requires id parameter', async () => {
    const result = await execute(schema.parse({ action: 'complete' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('"id" is required')
    }
  })

  test('remove deletes a task', async () => {
    await execute(schema.parse({ action: 'add', task: 'Task A' }))
    await execute(schema.parse({ action: 'add', task: 'Task B' }))

    const removeResult = await execute(schema.parse({ action: 'remove', id: 1 }))
    expect(removeResult.ok).toBe(true)
    if (removeResult.ok) {
      expect(removeResult.value.tasks).toHaveLength(1)
      expect(removeResult.value.tasks[0].task).toBe('Task B')
    }
  })

  test('complete returns error for unknown id', async () => {
    const result = await execute(schema.parse({ action: 'complete', id: 99 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('not found')
    }
  })

  test('remove returns error for unknown id', async () => {
    const result = await execute(schema.parse({ action: 'remove', id: 99 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('not found')
    }
  })

  test('multiple adds increment IDs', async () => {
    await execute(schema.parse({ action: 'add', task: 'First' }))
    await execute(schema.parse({ action: 'add', task: 'Second' }))
    const result = await execute(schema.parse({ action: 'add', task: 'Third' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tasks.map((t) => t.id)).toEqual([1, 2, 3])
    }
  })
})
