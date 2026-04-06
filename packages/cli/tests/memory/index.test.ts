import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { getMemoryIndex, updateMemoryIndex } from '@src/memory/index'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Layer 1 — MEMORY.md Index', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('returns empty string when MEMORY.md does not exist', () => {
    const result = getMemoryIndex(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('')
  })

  test('reads existing MEMORY.md content', () => {
    const memoryDir = join(tempDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# My Memory\n\nSome content here.')

    const result = getMemoryIndex(tempDir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('# My Memory\n\nSome content here.')
  })

  test('MEMORY.md round-trip: write then read', () => {
    // Setup: write initial content
    const memoryDir = join(tempDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'original content')

    // First read returns original
    const first = getMemoryIndex(tempDir)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value).toBe('original content')

    // Update
    const writeResult = updateMemoryIndex('new content', tempDir)
    expect(writeResult.ok).toBe(true)

    // Second read returns new content
    const second = getMemoryIndex(tempDir)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value).toBe('new content')
  })

  test('updateMemoryIndex creates memory directory if missing', () => {
    const result = updateMemoryIndex('auto-created content', tempDir)
    expect(result.ok).toBe(true)

    const readResult = getMemoryIndex(tempDir)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return
    expect(readResult.value).toBe('auto-created content')
  })
})
