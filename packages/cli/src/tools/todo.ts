import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'todo'

export const description =
  'Manage an in-memory task list for the current session. ' +
  'Supports add, list, complete, and remove actions.'

export const schema = z.object({
  action: z.enum(['add', 'list', 'complete', 'remove']).describe('The action to perform'),
  task: z.string().optional().describe('The task description (required for "add")'),
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The task ID (required for "complete" and "remove")'),
})

export interface TodoItem {
  id: number
  task: string
  completed: boolean
}

export interface TodoResult {
  tasks: TodoItem[]
  message: string
}

/** In-memory task list — persists for the lifetime of the process. */
let tasks: TodoItem[] = []
let nextId = 1

/** Reset internal state (useful for testing). */
export function _resetTasks(): void {
  tasks = []
  nextId = 1
}

export const execute: TypedToolExecute<typeof schema, TodoResult> = async (
  args,
): Promise<Result<TodoResult>> => {
  const { action, task, id } = args

  switch (action) {
    case 'add': {
      if (!task) {
        return err(new Error('"task" is required for the "add" action'))
      }
      const item: TodoItem = { id: nextId++, task, completed: false }
      tasks.push(item)
      return ok({ tasks: [...tasks], message: `Added task #${item.id}: "${task}"` })
    }

    case 'list': {
      return ok({ tasks: [...tasks], message: `${tasks.length} task(s)` })
    }

    case 'complete': {
      if (id == null) {
        return err(new Error('"id" is required for the "complete" action'))
      }
      const item = tasks.find((t) => t.id === id)
      if (!item) {
        return err(new Error(`Task #${id} not found`))
      }
      item.completed = true
      return ok({ tasks: [...tasks], message: `Completed task #${id}: "${item.task}"` })
    }

    case 'remove': {
      if (id == null) {
        return err(new Error('"id" is required for the "remove" action'))
      }
      const idx = tasks.findIndex((t) => t.id === id)
      if (idx === -1) {
        return err(new Error(`Task #${id} not found`))
      }
      const removed = tasks.splice(idx, 1)[0]
      return ok({ tasks: [...tasks], message: `Removed task #${id}: "${removed.task}"` })
    }

    default:
      return err(new Error(`Unknown action: "${action}"`))
  }
}
export const tier = 1
