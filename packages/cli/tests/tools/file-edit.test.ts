import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execute, schema } from '@src/tools/file-edit'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('FileEditTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `ouroboros-fedit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('replaces exactly one match', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'hello world\ngoodbye world\n')

    const args = schema.parse({
      path: filePath,
      oldString: 'hello world',
      newString: 'hi world',
    })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.content).toBe('hi world\ngoodbye world\n')
    }
    expect(readFileSync(filePath, 'utf-8')).toBe('hi world\ngoodbye world\n')
  })

  // -----------------------------------------------------------------------
  // Feature test: FileEditTool fails on ambiguous match
  // -----------------------------------------------------------------------
  test('fails when oldString matches multiple locations', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'foo bar\nbaz foo\n')

    const args = schema.parse({
      path: filePath,
      oldString: 'foo',
      newString: 'bar',
    })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('2 matches')
    }

    // File should remain unchanged.
    expect(readFileSync(filePath, 'utf-8')).toBe('foo bar\nbaz foo\n')
  })

  test('fails when oldString has zero matches', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'hello world\n')

    const args = schema.parse({
      path: filePath,
      oldString: 'nonexistent',
      newString: 'replacement',
    })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('No matches')
    }
  })

  test('returns error for non-existent file', async () => {
    const args = schema.parse({
      path: join(tempDir, 'nope.txt'),
      oldString: 'a',
      newString: 'b',
    })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('File not found')
    }
  })
})
