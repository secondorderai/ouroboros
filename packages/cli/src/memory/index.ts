/**
 * Layer 1 — MEMORY.md Index
 *
 * Loads and updates the top-level memory index file (memory/MEMORY.md).
 * This file is always loaded at startup and injected into the system prompt.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { type Result, ok, err } from '@src/types'

const DEFAULT_MEMORY_PATH = 'memory/MEMORY.md'

/**
 * Resolve the absolute path to MEMORY.md given an optional base directory.
 */
function resolveMemoryPath(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, DEFAULT_MEMORY_PATH)
}

/**
 * Read the current MEMORY.md content.
 *
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result containing the file content as a string, or an error
 */
export function getMemoryIndex(basePath?: string): Result<string> {
  try {
    const filePath = resolveMemoryPath(basePath)
    if (!existsSync(filePath)) {
      return ok('')
    }
    const content = readFileSync(filePath, 'utf-8')
    return ok(content)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read MEMORY.md: ${message}`))
  }
}

/**
 * Overwrite MEMORY.md with new content.
 *
 * @param content - New content for MEMORY.md
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result indicating success or failure
 */
export function updateMemoryIndex(content: string, basePath?: string): Result<void> {
  try {
    const filePath = resolveMemoryPath(basePath)
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(filePath, content, 'utf-8')
    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to update MEMORY.md: ${message}`))
  }
}
