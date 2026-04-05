import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { listTopics, readTopic, writeTopic, deleteTopic } from '@src/memory/topics'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-topics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Layer 2 — Topic Files', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
    mkdirSync(join(tempDir, 'memory', 'topics'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('listTopics returns empty array when no topics exist', () => {
    const result = listTopics(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  test('listTopics returns empty array when topics dir does not exist', () => {
    const emptyDir = makeTempDir()
    const result = listTopics(emptyDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
    rmSync(emptyDir, { recursive: true, force: true })
  })

  test('Topic CRUD: write, read, list, delete, list', () => {
    // Write
    const writeResult = writeTopic('testing', 'test content', tempDir)
    expect(writeResult.ok).toBe(true)

    // Read
    const readResult = readTopic('testing', tempDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return
    expect(readResult.value).toBe('test content')

    // List
    const listResult = listTopics(tempDir)
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return
    expect(listResult.value).toContain('testing')

    // Delete
    const deleteResult = deleteTopic('testing', tempDir)
    expect(deleteResult.ok).toBe(true)

    // List again — should be empty
    const listAfterDelete = listTopics(tempDir)
    expect(listAfterDelete.ok).toBe(true)
    if (!listAfterDelete.ok) return
    expect(listAfterDelete.value).not.toContain('testing')
  })

  test('writeTopic creates topics directory if missing', () => {
    const freshDir = makeTempDir()
    const result = writeTopic('auto-created', 'some content', freshDir)
    expect(result.ok).toBe(true)

    const readResult = readTopic('auto-created', freshDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return
    expect(readResult.value).toBe('some content')

    rmSync(freshDir, { recursive: true, force: true })
  })

  test('readTopic returns error for non-existent topic', () => {
    const result = readTopic('nonexistent', tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
  })

  test('deleteTopic returns error for non-existent topic', () => {
    const result = deleteTopic('nonexistent', tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
  })

  test('rejects invalid topic names', () => {
    const result = writeTopic('../escape', 'bad content', tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Invalid topic name')
  })

  test('rejects empty topic name', () => {
    const result = writeTopic('', 'bad content', tempDir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('must not be empty')
  })

  test('writeTopic overwrites existing topic', () => {
    writeTopic('overwrite-test', 'first version', tempDir)
    writeTopic('overwrite-test', 'second version', tempDir)

    const result = readTopic('overwrite-test', tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('second version')
  })

  test('handles topic name with .md extension', () => {
    const writeResult = writeTopic('with-ext.md', 'content with ext', tempDir)
    expect(writeResult.ok).toBe(true)

    const readResult = readTopic('with-ext', tempDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return
    expect(readResult.value).toBe('content with ext')
  })

  test('lists multiple topics', () => {
    writeTopic('topic-a', 'content a', tempDir)
    writeTopic('topic-b', 'content b', tempDir)
    writeTopic('topic-c', 'content c', tempDir)

    const result = listTopics(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(3)
    expect(result.value.sort()).toEqual(['topic-a', 'topic-b', 'topic-c'])
  })
})
