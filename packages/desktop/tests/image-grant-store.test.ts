import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { ImageGrantStore, MAX_GRANTS_PER_WINDOW } from '../src/main/image-grant-store'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46,
  0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
])

function fakeWindow(): BrowserWindow {
  // Only WeakMap identity matters for the store.
  return {} as unknown as BrowserWindow
}

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'image-grant-store-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function writeFixture(name: string, body: Buffer | string = PNG_MAGIC): string {
  const fullPath = join(workdir, name)
  writeFileSync(fullPath, body)
  return fullPath
}

describe('ImageGrantStore.grant', () => {
  test('grants paths whose extension and magic bytes both match', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const png = writeFixture('a.png', PNG_MAGIC)
    const jpg = writeFixture('b.jpg', JPEG_MAGIC)
    const webp = writeFixture('c.webp', WEBP_MAGIC)

    const result = store.grant(window, [png, jpg, webp])

    expect(result.granted).toEqual([png, jpg, webp])
    expect(result.rejected).toEqual([])
    expect(store.has(window, png)).toBe(true)
    expect(store.has(window, webp)).toBe(true)
  })

  test('rejects paths with non-image extensions', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const txt = writeFixture('secret.txt', 'plain text')

    const result = store.grant(window, [txt])

    expect(result.granted).toEqual([])
    expect(result.rejected[0].reason).toContain('unsupported image extension')
    expect(store.has(window, txt)).toBe(false)
  })

  test('rejects renamed binaries that fail magic-byte verification', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    // PNG header is 89 50 4E 47 ..., this file is plain text saved as .png.
    const renamed = writeFixture('id_rsa.png', '-----BEGIN OPENSSH PRIVATE KEY-----')

    const result = store.grant(window, [renamed])

    expect(result.granted).toEqual([])
    expect(result.rejected[0].reason).toContain('does not match the declared image format')
    expect(store.has(window, renamed)).toBe(false)
  })

  test('rejects empty files even when extension is allowed', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const empty = writeFixture('empty.png', Buffer.alloc(0))

    const result = store.grant(window, [empty])

    expect(result.granted).toEqual([])
    expect(result.rejected[0].reason).toContain('empty')
  })

  test('canonicalises symlinks so a granted path is reachable via either name', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const real = writeFixture('real.png', PNG_MAGIC)
    const link = join(workdir, 'link.png')
    symlinkSync(real, link)

    store.grant(window, [link])

    expect(store.has(window, real)).toBe(true)
    expect(store.has(window, link)).toBe(true)
  })

  test('rejects symlink whose target has a different image format', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const realJpg = writeFixture('real.jpg', JPEG_MAGIC)
    const linkPng = join(workdir, 'link.png')
    symlinkSync(realJpg, linkPng)

    const result = store.grant(window, [linkPng])

    expect(result.granted).toEqual([])
    expect(result.rejected[0].reason).toContain('symlink target')
  })

  test('returns rejection when no window is provided', () => {
    const store = new ImageGrantStore()
    const png = writeFixture('a.png', PNG_MAGIC)

    const result = store.grant(null, [png])

    expect(result.granted).toEqual([])
    expect(result.rejected[0].reason).toBe('no active window')
  })
})

describe('ImageGrantStore.has', () => {
  test('returns false for paths that were never granted', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const png = writeFixture('a.png', PNG_MAGIC)

    expect(store.has(window, png)).toBe(false)
    expect(store.has(window, '/etc/passwd')).toBe(false)
  })

  test('returns false for empty or non-string lookup paths', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    expect(store.has(window, '')).toBe(false)
    expect(store.has(window, undefined as unknown as string)).toBe(false)
  })
})

describe('ImageGrantStore.forget', () => {
  test('clears all grants for a window', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const png = writeFixture('a.png', PNG_MAGIC)

    store.grant(window, [png])
    expect(store.has(window, png)).toBe(true)

    store.forget(window)
    expect(store.has(window, png)).toBe(false)
    expect(store.size(window)).toBe(0)
  })
})

describe('ImageGrantStore eviction', () => {
  test('caps grants at MAX_GRANTS_PER_WINDOW with FIFO eviction', () => {
    const store = new ImageGrantStore()
    const window = fakeWindow()
    const overflow = MAX_GRANTS_PER_WINDOW + 5
    const paths: string[] = []
    for (let i = 0; i < overflow; i++) {
      paths.push(writeFixture(`img-${i}.png`, PNG_MAGIC))
    }

    store.grant(window, paths)

    expect(store.size(window)).toBeLessThanOrEqual(MAX_GRANTS_PER_WINDOW)
    // First five inserted should have been evicted; tail entries remain.
    expect(store.has(window, paths[0])).toBe(false)
    expect(store.has(window, paths[overflow - 1])).toBe(true)
  })
})
