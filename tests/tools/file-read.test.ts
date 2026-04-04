import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execute, schema } from '@src/tools/file-read'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('FileReadTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `ouroboros-fread-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('reads a file with line numbers', async () => {
    const filePath = join(tempDir, 'hello.txt')
    writeFileSync(filePath, 'line1\nline2\nline3\n')

    const args = schema.parse({ path: filePath })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.content).toContain('1\tline1')
      expect(result.value.content).toContain('2\tline2')
      expect(result.value.content).toContain('3\tline3')
      expect(result.value.path).toBe(filePath)
    }
  })

  // -----------------------------------------------------------------------
  // Feature test: FileReadTool reads with line range
  // -----------------------------------------------------------------------
  test('reads file with line range', async () => {
    const filePath = join(tempDir, 'ten-lines.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(filePath, lines)

    const args = schema.parse({ path: filePath, startLine: 3, endLine: 5 })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lines).toBe(3)
      expect(result.value.content).toContain('3\tline 3')
      expect(result.value.content).toContain('4\tline 4')
      expect(result.value.content).toContain('5\tline 5')
      // Should NOT contain other lines.
      expect(result.value.content).not.toContain('2\tline 2')
      expect(result.value.content).not.toContain('6\tline 6')
    }
  })

  test('returns error for non-existent file', async () => {
    const args = schema.parse({ path: join(tempDir, 'nope.txt') })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('File not found')
    }
  })

  test('returns error for binary file', async () => {
    const filePath = join(tempDir, 'binary.bin')
    const buf = Buffer.alloc(100)
    buf[50] = 0 // null byte
    buf[0] = 0x89 // PNG-like header
    writeFileSync(filePath, buf)

    const args = schema.parse({ path: filePath })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('binary')
    }
  })

  test('handles invalid line range (start > end)', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'a\nb\nc\n')

    const args = schema.parse({ path: filePath, startLine: 5, endLine: 2 })
    const result = await execute(args)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid line range')
    }
  })
})
