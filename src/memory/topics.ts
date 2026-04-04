/**
 * Layer 2 — Topic Files
 *
 * CRUD operations for topic files stored in memory/topics/.
 * Topic files are markdown documents referenced from MEMORY.md by the agent.
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { type Result, ok, err } from '@src/types'

const DEFAULT_TOPICS_DIR = 'memory/topics'

/**
 * Resolve the absolute path to the topics directory.
 */
function resolveTopicsDir(basePath?: string): string {
  const base = basePath ?? process.cwd()
  return resolve(base, DEFAULT_TOPICS_DIR)
}

/**
 * Ensure a topic name is safe for use as a filename.
 * Allows alphanumeric, hyphens, underscores, and dots.
 */
function validateTopicName(name: string): Result<string> {
  if (!name || name.trim().length === 0) {
    return err(new Error('Topic name must not be empty'))
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return err(new Error(`Invalid topic name "${name}": only alphanumeric, hyphens, underscores, and dots are allowed`))
  }
  if (name.startsWith('.') || name.includes('..')) {
    return err(new Error(`Invalid topic name "${name}": must not start with a dot or contain path traversal`))
  }
  return ok(name)
}

/**
 * Resolve the path to a specific topic file, adding .md extension if needed.
 */
function resolveTopicPath(name: string, basePath?: string): string {
  const dir = resolveTopicsDir(basePath)
  const filename = name.endsWith('.md') ? name : `${name}.md`
  return join(dir, filename)
}

/**
 * List all .md files in the topics directory.
 *
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result containing an array of topic names (without .md extension)
 */
export function listTopics(basePath?: string): Result<string[]> {
  try {
    const dir = resolveTopicsDir(basePath)
    if (!existsSync(dir)) {
      return ok([])
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    const names = files.map(f => f.replace(/\.md$/, ''))
    return ok(names)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to list topics: ${message}`))
  }
}

/**
 * Read a specific topic file.
 *
 * @param name - Topic name (with or without .md extension)
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result containing the file content as a string
 */
export function readTopic(name: string, basePath?: string): Result<string> {
  const validation = validateTopicName(name.replace(/\.md$/, ''))
  if (!validation.ok) return validation

  try {
    const filePath = resolveTopicPath(name, basePath)
    if (!existsSync(filePath)) {
      return err(new Error(`Topic "${name}" not found`))
    }
    const content = readFileSync(filePath, 'utf-8')
    return ok(content)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read topic "${name}": ${message}`))
  }
}

/**
 * Create or update a topic file.
 *
 * @param name - Topic name (with or without .md extension)
 * @param content - Content to write
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result indicating success or failure
 */
export function writeTopic(name: string, content: string, basePath?: string): Result<void> {
  const validation = validateTopicName(name.replace(/\.md$/, ''))
  if (!validation.ok) return validation

  try {
    const dir = resolveTopicsDir(basePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const filePath = resolveTopicPath(name, basePath)
    writeFileSync(filePath, content, 'utf-8')
    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write topic "${name}": ${message}`))
  }
}

/**
 * Delete a topic file.
 *
 * @param name - Topic name (with or without .md extension)
 * @param basePath - Working directory (defaults to process.cwd())
 * @returns Result indicating success or failure
 */
export function deleteTopic(name: string, basePath?: string): Result<void> {
  const validation = validateTopicName(name.replace(/\.md$/, ''))
  if (!validation.ok) return validation

  try {
    const filePath = resolveTopicPath(name, basePath)
    if (!existsSync(filePath)) {
      return err(new Error(`Topic "${name}" not found`))
    }
    unlinkSync(filePath)
    return ok(undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to delete topic "${name}": ${message}`))
  }
}
