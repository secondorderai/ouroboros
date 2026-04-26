import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generateArtifactId,
  loadIndex,
  listArtifacts,
  readArtifact,
  nextVersionFor,
  writeArtifact,
} from '@src/artifacts/storage'
import {
  resolveArtifactPath,
  resolveArtifactsDir,
  resolveArtifactsIndexPath,
  resolveSessionDir,
} from '@src/memory/paths'

describe('artifacts storage', () => {
  let basePath: string
  const sessionId = 'test-session-001'

  beforeEach(() => {
    basePath = join(
      tmpdir(),
      `ouroboros-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(basePath, { recursive: true })
  })

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true })
  })

  test('path helpers compose memory/sessions/<sid>/artifacts/<id>.v<n>.html', () => {
    const sessionDir = resolveSessionDir(sessionId, basePath)
    expect(sessionDir.endsWith(`/memory/sessions/${sessionId}`)).toBe(true)
    const artPath = resolveArtifactPath(sessionId, 'abc', 2, basePath)
    expect(artPath.endsWith(`/artifacts/abc.v2.html`)).toBe(true)
  })

  test('generateArtifactId returns 16-char hex strings', () => {
    const id = generateArtifactId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(generateArtifactId()).not.toBe(id)
  })

  test('writeArtifact creates file, updates index, and returns metadata', () => {
    const html = '<!DOCTYPE html><html><head></head><body>hello</body></html>'
    const result = writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 1,
      html,
      title: 'Hello',
      basePath,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readFileSync(result.value.path, 'utf-8')).toBe(html)
    expect(result.value.metadata.bytes).toBe(Buffer.byteLength(html, 'utf-8'))

    const indexResult = loadIndex(sessionId, basePath)
    expect(indexResult.ok).toBe(true)
    if (!indexResult.ok) return
    expect(indexResult.value.entries['abc'].latestVersion).toBe(1)
    expect(indexResult.value.entries['abc'].versions).toHaveLength(1)
  })

  test('nextVersionFor returns v1 for new id and v(n+1) for known id', () => {
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 1,
      html: '<html><head></head><body>1</body></html>',
      title: 't1',
      basePath,
    })

    const fresh = nextVersionFor(sessionId, undefined, basePath)
    expect(fresh.ok).toBe(true)
    if (fresh.ok) expect(fresh.value.version).toBe(1)

    const next = nextVersionFor(sessionId, 'abc', basePath)
    expect(next.ok).toBe(true)
    if (next.ok) {
      expect(next.value.artifactId).toBe('abc')
      expect(next.value.version).toBe(2)
    }
  })

  test('nextVersionFor errors on unknown supersedes id', () => {
    const result = nextVersionFor(sessionId, 'does-not-exist', basePath)
    expect(result.ok).toBe(false)
  })

  test('listArtifacts returns all versions sorted by createdAt', async () => {
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 1,
      html: '<html><head></head><body>1</body></html>',
      title: 't1',
      basePath,
    })
    await new Promise((r) => setTimeout(r, 10))
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 2,
      html: '<html><head></head><body>2</body></html>',
      title: 't2',
      basePath,
    })

    const list = listArtifacts(sessionId, basePath)
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value.map((a) => a.version)).toEqual([1, 2])
  })

  test('readArtifact returns latest version when version omitted', () => {
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 1,
      html: '<html><head></head><body>v1</body></html>',
      title: 't',
      basePath,
    })
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 2,
      html: '<html><head></head><body>v2</body></html>',
      title: 't',
      basePath,
    })

    const r = readArtifact(sessionId, 'abc', undefined, basePath)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.html).toContain('v2')
    expect(r.value.metadata.version).toBe(2)
  })

  test('readArtifact errors on unknown id', () => {
    const r = readArtifact(sessionId, 'nope', undefined, basePath)
    expect(r.ok).toBe(false)
  })

  test('listArtifacts rebuilds index when index.json is missing but files exist', () => {
    writeArtifact({
      sessionId,
      artifactId: 'abc',
      version: 1,
      html: '<html><head></head><body>v1</body></html>',
      title: 't',
      basePath,
    })

    rmSync(resolveArtifactsIndexPath(sessionId, basePath))
    expect(existsSync(resolveArtifactsIndexPath(sessionId, basePath))).toBe(false)

    const list = listArtifacts(sessionId, basePath)
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value).toHaveLength(1)
    expect(list.value[0].artifactId).toBe('abc')
    expect(existsSync(resolveArtifactsIndexPath(sessionId, basePath))).toBe(true)
  })

  test('listArtifacts skips files whose names do not match the artifact pattern', () => {
    const dir = resolveArtifactsDir(sessionId, basePath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'not an artifact')
    writeFileSync(join(dir, 'random.html'), '<html></html>')

    const list = listArtifacts(sessionId, basePath)
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value).toHaveLength(0)
  })

  test('artifacts from one session are not visible to another session', () => {
    writeArtifact({
      sessionId: 'session-a',
      artifactId: 'abc',
      version: 1,
      html: '<html><head></head><body>a</body></html>',
      title: 't',
      basePath,
    })

    const otherList = listArtifacts('session-b', basePath)
    expect(otherList.ok).toBe(true)
    if (!otherList.ok) return
    expect(otherList.value).toHaveLength(0)
  })
})
