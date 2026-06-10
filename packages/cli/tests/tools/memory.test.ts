import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { name, description, schema, createExecute } from '@src/tools/memory'
import type { ToolExecutionContext } from '@src/tools/types'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Memory Tool', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = makeTempDir()
    mkdirSync(join(tempDir, 'memory', 'topics'), { recursive: true })
    writeFileSync(join(tempDir, 'memory', 'MEMORY.md'), '# Test Memory Index')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('memory')
    expect(typeof description).toBe('string')
    expect(description.length).toBeGreaterThan(0)
    expect(schema.safeParse({ action: 'read-index' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.shape.action).toBeDefined()
    expect(schema.shape.content).toBeDefined()
    expect(schema.shape.name).toBeDefined()
  })

  test('read-index returns MEMORY.md content', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'read-index' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('# Test Memory Index')
  })

  test('update-index writes new MEMORY.md content', async () => {
    const execute = createExecute({ basePath: tempDir })
    const updateResult = await execute({ action: 'update-index', content: '# Updated Index' })
    expect(updateResult.ok).toBe(true)

    const readResult = await execute({ action: 'read-index' })
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return
    expect(readResult.value).toBe('# Updated Index')
  })

  test('update-index without content returns error', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'update-index' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires "content"')
  })

  test('list-topics returns topic names', async () => {
    const execute = createExecute({ basePath: tempDir })

    // No topics yet
    const emptyResult = await execute({ action: 'list-topics' })
    expect(emptyResult.ok).toBe(true)
    if (!emptyResult.ok) return
    expect(emptyResult.value).toBe('No topics found')

    // Write a topic
    await execute({ action: 'write-topic', name: 'my-topic', content: 'topic content' })

    const listResult = await execute({ action: 'list-topics' })
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return
    expect(listResult.value).toContain('my-topic')
  })

  test('read-topic returns topic content', async () => {
    const execute = createExecute({ basePath: tempDir })
    await execute({ action: 'write-topic', name: 'test-read', content: 'readable content' })

    const result = await execute({ action: 'read-topic', name: 'test-read' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('readable content')
  })

  test('read-topic without name returns error', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'read-topic' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires "name"')
  })

  test('write-topic without name returns error', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'write-topic', content: 'orphan content' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires "name"')
  })

  test('write-topic without content returns error', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'write-topic', name: 'no-content' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires "content"')
  })

  // NOTE: search-transcripts tests removed — action was removed from schema
  // (TranscriptStore not wired up at startup; can be re-enabled in Phase 2)
})

describe('Memory Tool — global memoryBasePath', () => {
  let memDir: string
  let wsDir: string

  beforeEach(() => {
    memDir = makeTempDir()
    wsDir = makeTempDir()
    mkdirSync(join(memDir, 'memory'), { recursive: true })
    writeFileSync(join(memDir, 'memory', 'MEMORY.md'), '# Global Memory')
    mkdirSync(join(wsDir, 'memory'), { recursive: true })
    writeFileSync(join(wsDir, 'memory', 'MEMORY.md'), '# Workspace Memory')
  })

  afterEach(() => {
    rmSync(memDir, { recursive: true, force: true })
    rmSync(wsDir, { recursive: true, force: true })
  })

  // The tool only reads basePath fields off the context.
  const ctx = (overrides: Partial<ToolExecutionContext>): ToolExecutionContext =>
    overrides as ToolExecutionContext

  test('reads from context.memoryBasePath when no dep is injected', async () => {
    const execute = createExecute()
    const result = await execute({ action: 'read-index' }, ctx({ memoryBasePath: memDir }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('# Global Memory')
  })

  test('memoryBasePath takes precedence over the workspace basePath', async () => {
    const execute = createExecute()
    const result = await execute(
      { action: 'read-index' },
      ctx({ memoryBasePath: memDir, basePath: wsDir }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('# Global Memory')
  })

  test('write-topic lands under memoryBasePath, not the workspace basePath', async () => {
    const execute = createExecute()
    const result = await execute(
      { action: 'write-topic', name: 'prefs', content: 'remembered' },
      ctx({ memoryBasePath: memDir, basePath: wsDir }),
    )
    expect(result.ok).toBe(true)

    expect(readFileSync(join(memDir, 'memory', 'topics', 'prefs.md'), 'utf-8')).toBe('remembered')
    expect(existsSync(join(wsDir, 'memory', 'topics', 'prefs.md'))).toBe(false)
  })
})
