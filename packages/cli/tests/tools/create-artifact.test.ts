import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute, schema } from '@src/tools/create-artifact'
import { resolveArtifactPath } from '@src/memory/paths'
import type { ToolExecutionContext } from '@src/tools/types'
import type { OuroborosConfig } from '@src/config'

function makeContext(
  basePath: string,
  sessionId: string | undefined,
  emitted: unknown[],
  configOverride?: Partial<OuroborosConfig['artifacts']>,
): ToolExecutionContext {
  const artifacts = {
    cdnAllowlist: ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com'],
    maxBytes: 1_048_576,
    ...configOverride,
  }
  return {
    model: undefined as never,
    toolRegistry: undefined as never,
    config: { artifacts } as unknown as OuroborosConfig,
    basePath,
    sessionId,
    agentId: 'test-agent',
    emitEvent: (event) => {
      emitted.push(event)
    },
  } as ToolExecutionContext
}

describe('create-artifact tool', () => {
  let basePath: string
  const sessionId = 'sess-create-artifact'

  beforeEach(() => {
    basePath = join(
      tmpdir(),
      `ouroboros-create-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(basePath, { recursive: true })
  })

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true })
  })

  test('happy path: writes file with CSP, returns metadata, emits event', async () => {
    const emitted: unknown[] = []
    const args = schema.parse({
      title: 'Sine wave',
      html: '<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>',
    })
    const result = await execute(args, makeContext(basePath, sessionId, emitted))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(1)
    expect(result.value.title).toBe('Sine wave')
    expect(result.value.warnings).toEqual([])
    expect(existsSync(result.value.path)).toBe(true)

    const fileContent = readFileSync(result.value.path, 'utf-8')
    expect(fileContent).toContain('Content-Security-Policy')
    expect(fileContent.indexOf('Content-Security-Policy')).toBeLessThan(
      fileContent.indexOf('<title>'),
    )

    expect(emitted).toHaveLength(1)
    const event = emitted[0] as { type: string; sessionId: string; version: number }
    expect(event.type).toBe('artifact-created')
    expect(event.sessionId).toBe(sessionId)
    expect(event.version).toBe(1)
  })

  test('errors when sessionId is missing', async () => {
    const emitted: unknown[] = []
    const args = schema.parse({
      title: 't',
      html: '<html><head></head><body>hi</body></html>',
    })
    const result = await execute(args, makeContext(basePath, undefined, emitted))
    expect(result.ok).toBe(false)
    expect(emitted).toHaveLength(0)
  })

  test('errors when html exceeds maxBytes', async () => {
    const emitted: unknown[] = []
    const ctx = makeContext(basePath, sessionId, emitted, { maxBytes: 100, cdnAllowlist: [] })
    const big = '<html><head></head><body>' + 'x'.repeat(200) + '</body></html>'
    const result = await execute(schema.parse({ title: 't', html: big }), ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('exceeds')
    }
  })

  test('errors on unknown supersedes id', async () => {
    const emitted: unknown[] = []
    const result = await execute(
      schema.parse({
        title: 't',
        html: '<html><head></head><body>hi</body></html>',
        supersedes: 'nope',
      }),
      makeContext(basePath, sessionId, emitted),
    )
    expect(result.ok).toBe(false)
  })

  test('versioning: supersedes bumps version on the same artifactId', async () => {
    const emitted: unknown[] = []
    const ctx = makeContext(basePath, sessionId, emitted)
    const v1 = await execute(
      schema.parse({ title: 't', html: '<html><head></head><body>1</body></html>' }),
      ctx,
    )
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    const id = v1.value.artifactId

    const v2 = await execute(
      schema.parse({
        title: 't',
        html: '<html><head></head><body>2</body></html>',
        supersedes: id,
      }),
      ctx,
    )
    expect(v2.ok).toBe(true)
    if (!v2.ok) return
    expect(v2.value.artifactId).toBe(id)
    expect(v2.value.version).toBe(2)
    expect(existsSync(resolveArtifactPath(sessionId, id, 1, basePath))).toBe(true)
    expect(existsSync(resolveArtifactPath(sessionId, id, 2, basePath))).toBe(true)
  })

  test('warns on non-allowlisted CDN script', async () => {
    const emitted: unknown[] = []
    const html =
      '<html><head><script src="https://evil.example/x.js"></script></head><body></body></html>'
    const result = await execute(
      schema.parse({ title: 't', html }),
      makeContext(basePath, sessionId, emitted),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.some((w) => w.includes('https://evil.example'))).toBe(true)
  })

  test('rejects forbidden tag (<base>)', async () => {
    const emitted: unknown[] = []
    const html = '<html><head><base href="//x"></head><body></body></html>'
    const result = await execute(
      schema.parse({ title: 't', html }),
      makeContext(basePath, sessionId, emitted),
    )
    expect(result.ok).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})
