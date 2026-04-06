import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execute, schema } from '@src/tools/file-write'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('FileWriteTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `ouroboros-fwrite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('writes a file and returns bytes written', async () => {
    const filePath = join(tempDir, 'output.txt')
    const content = 'Hello, world!\n'

    const args = schema.parse({ path: filePath, content })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.bytesWritten).toBe(Buffer.byteLength(content))
      expect(result.value.path).toBe(filePath)
    }

    // Verify the file on disk.
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
  })

  test('creates parent directories if they do not exist', async () => {
    const filePath = join(tempDir, 'a', 'b', 'c', 'deep.txt')
    const content = 'deep file'

    const args = schema.parse({ path: filePath, content })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
  })

  test('overwrites existing file', async () => {
    const filePath = join(tempDir, 'overwrite.txt')

    // Write initial content.
    const args1 = schema.parse({ path: filePath, content: 'first' })
    await execute(args1)

    // Overwrite.
    const args2 = schema.parse({ path: filePath, content: 'second' })
    const result = await execute(args2)

    expect(result.ok).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('second')
  })
})
