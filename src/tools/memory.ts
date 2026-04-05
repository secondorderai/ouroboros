/**
 * Memory Tool
 *
 * Exposes memory operations (MEMORY.md index, topic files, transcript search)
 * as a tool for the agent. Follows the tool registry interface:
 * name, description, schema (JSON Schema), execute (async fn returning Result).
 */
import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import { getMemoryIndex, updateMemoryIndex } from '@src/memory/index'
import { listTopics, readTopic, writeTopic } from '@src/memory/topics'
import { type TranscriptStore } from '@src/memory/transcripts'

// ── Tool interface ─────────────────────────────────────────────────

export const name = 'memory'

export const description =
  'Read and write the memory index (MEMORY.md), manage topic files, and search past session transcripts.'

export const schema = z.object({
  action: z
    .enum([
      'read-index',
      'update-index',
      'list-topics',
      'read-topic',
      'write-topic',
      'search-transcripts',
    ])
    .describe('The memory operation to perform'),
  content: z.string().optional().describe('Content for update-index or write-topic actions'),
  name: z.string().optional().describe('Topic name for read-topic or write-topic actions'),
  query: z.string().optional().describe('Search query for search-transcripts action'),
})

export interface MemoryToolInput {
  action:
    | 'read-index'
    | 'update-index'
    | 'list-topics'
    | 'read-topic'
    | 'write-topic'
    | 'search-transcripts'
  content?: string
  name?: string
  query?: string
}

/** Dependencies injected at tool registration time */
export interface MemoryToolDeps {
  basePath?: string
  transcriptStore?: TranscriptStore
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

      case 'search-transcripts': {
        if (!input.query) {
          return err(new Error('search-transcripts requires "query" parameter'))
        }
        if (!deps.transcriptStore) {
          return err(new Error('Transcript store not initialized'))
        }
        const result = deps.transcriptStore.searchTranscripts(input.query)
        if (!result.ok) return result
        if (result.value.length === 0) {
          return ok('No matching transcripts found')
        }
        const formatted = result.value
          .map((r) => `[${r.sessionId.slice(0, 8)}] ${r.role}: ${r.content.slice(0, 200)}`)
          .join('\n---\n')
        return ok(formatted)
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
