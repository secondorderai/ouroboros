import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { name, description, schema, createExecute } from '@src/tools/memory'
import { TranscriptStore } from '@src/memory/transcripts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ouroboros-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Memory Tool', () => {
  let tempDir: string
  let store: TranscriptStore

  beforeEach(() => {
    tempDir = makeTempDir()
    mkdirSync(join(tempDir, 'memory', 'topics'), { recursive: true })
    writeFileSync(join(tempDir, 'memory', 'MEMORY.md'), '# Test Memory Index')
    store = new TranscriptStore(join(tempDir, 'memory', 'transcripts.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('exports correct tool interface', () => {
    expect(name).toBe('memory')
    expect(typeof description).toBe('string')
    expect(description.length).toBeGreaterThan(0)
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('action')
    expect(schema.properties.action.enum).toContain('read-index')
    expect(schema.properties.action.enum).toContain('update-index')
    expect(schema.properties.action.enum).toContain('list-topics')
    expect(schema.properties.action.enum).toContain('read-topic')
    expect(schema.properties.action.enum).toContain('write-topic')
    expect(schema.properties.action.enum).toContain('search-transcripts')
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

  test('search-transcripts finds matching messages', async () => {
    const execute = createExecute({ basePath: tempDir, transcriptStore: store })

    // Add some transcript data
    const session = store.createSession()
    expect(session.ok).toBe(true)
    if (!session.ok) return
    store.addMessage(session.value, { role: 'user', content: 'Tell me about database migration' })
    store.addMessage(session.value, { role: 'assistant', content: 'Migration is straightforward' })

    const result = await execute({ action: 'search-transcripts', query: 'migration' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContain('migration')
  })

  test('search-transcripts without query returns error', async () => {
    const execute = createExecute({ basePath: tempDir, transcriptStore: store })
    const result = await execute({ action: 'search-transcripts' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('requires "query"')
  })

  test('search-transcripts without store returns error', async () => {
    const execute = createExecute({ basePath: tempDir })
    const result = await execute({ action: 'search-transcripts', query: 'test' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not initialized')
  })
})
