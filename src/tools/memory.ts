/**
 * Memory Tool
 *
 * Exposes memory operations (MEMORY.md index, topic files, transcript search)
 * as a tool for the agent. Follows the tool registry interface:
 * name, description, schema (Zod), execute (async fn returning Result).
 */
import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import { getMemoryIndex, updateMemoryIndex } from '@src/memory/index'
import { listTopics, readTopic, writeTopic } from '@src/memory/topics'
// NOTE: TranscriptStore import can be restored when search-transcripts is re-enabled.

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'memory'

export const description =
  'Read and write the memory index (MEMORY.md), manage topic files, and search past session transcripts.'

// NOTE: 'search-transcripts' can be re-enabled when TranscriptStore is wired up at startup.
export const schema = z.object({
  action: z
    .enum([
      'read-index',
      'update-index',
      'list-topics',
      'read-topic',
      'write-topic',
    ])
    .describe('The memory operation to perform'),
  content: z.string().optional().describe('Content for update-index or write-topic actions'),
  name: z.string().optional().describe('Topic name for read-topic or write-topic actions'),
})

export interface MemoryToolInput {
  action:
    | 'read-index'
    | 'update-index'
    | 'list-topics'
    | 'read-topic'
    | 'write-topic'
  content?: string
  name?: string
}

/** Dependencies injected at tool registration time */
export interface MemoryToolDeps {
  basePath?: string
}

/**
 * Create the execute function with injected dependencies.
 * This allows the tool to be configured with a specific base path
 * and transcript store at startup.
 */
export function createExecute(deps: MemoryToolDeps = {}) {
  return async (input: MemoryToolInput): Promise<Result<string>> => {
    switch (input.action) {
      case 'read-index': {
        const result = getMemoryIndex(deps.basePath)
        if (!result.ok) return result
        return ok(result.value || '(empty)')
      }

      case 'update-index': {
        if (!input.content) {
          return err(new Error('update-index requires "content" parameter'))
        }
        const result = updateMemoryIndex(input.content, deps.basePath)
        if (!result.ok) return result
        return ok('MEMORY.md updated successfully')
      }

      case 'list-topics': {
        const result = listTopics(deps.basePath)
        if (!result.ok) return result
        if (result.value.length === 0) {
          return ok('No topics found')
        }
        return ok(result.value.join('\n'))
      }

      case 'read-topic': {
        if (!input.name) {
          return err(new Error('read-topic requires "name" parameter'))
        }
        const result = readTopic(input.name, deps.basePath)
        if (!result.ok) return result
        return ok(result.value)
      }

      case 'write-topic': {
        if (!input.name) {
          return err(new Error('write-topic requires "name" parameter'))
        }
        if (!input.content) {
          return err(new Error('write-topic requires "content" parameter'))
        }
        const result = writeTopic(input.name, input.content, deps.basePath)
        if (!result.ok) return result
        return ok(`Topic "${input.name}" written successfully`)
      }

      default:
        return err(new Error(`Unknown memory action: ${String(input.action)}`))
    }
  }
}

/**
 * Default execute function (uses process.cwd() and no transcript store).
 * In production, use createExecute() with proper dependencies.
 */
export const execute = createExecute()
