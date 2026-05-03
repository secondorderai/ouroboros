import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LaunchedApp } from './helpers'
import { launchTestApp } from './helpers'

let launched: LaunchedApp | null = null
let workdir: string | null = null

test.afterEach(async () => {
  await launched?.app.close()
  launched = null
  if (workdir) {
    await rm(workdir, { recursive: true, force: true })
    workdir = null
  }
})

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface RpcEnvelope {
  ok: boolean
  result?: unknown
  error?: { name: string; message: string }
}

async function callRpc(
  launchedApp: LaunchedApp,
  method: string,
  params?: unknown,
): Promise<RpcEnvelope> {
  return launchedApp.page.evaluate(
    async ({ currentMethod, currentParams }) => {
      try {
        const response = await (
          window as typeof window & {
            ouroboros: { rpc: (method: string, params?: unknown) => Promise<unknown> }
          }
        ).ouroboros.rpc(currentMethod as never, currentParams as never)
        return { ok: true as const, result: response }
      } catch (error) {
        const err = error as { name?: string; message?: string }
        return {
          ok: false as const,
          error: { name: err.name ?? 'Error', message: err.message ?? '' },
        }
      }
    },
    { currentMethod: method, currentParams: params },
  )
}

async function callValidate(
  launchedApp: LaunchedApp,
  paths: string[],
): Promise<{ accepted: Array<{ path: string }>; rejected: Array<{ path: string; reason: string }> }> {
  return launchedApp.page.evaluate(
    async (currentPaths) =>
      (
        window as typeof window & {
          ouroboros: {
            validateImageAttachments: (
              paths: string[],
            ) => Promise<{
              accepted: Array<{ path: string }>
              rejected: Array<{ path: string; reason: string }>
            }>
          }
        }
      ).ouroboros.validateImageAttachments(currentPaths),
    paths,
  )
}

test('synthetic renderer call to validateImageAttachments without a grant is rejected', async ({}, testInfo) => {
  workdir = await mkdtemp(path.join(tmpdir(), 'ouroboros-img-attach-'))
  const orphan = path.join(workdir, 'orphan.png')
  await writeFile(orphan, PNG_HEADER)

  launched = await launchTestApp(testInfo)

  const result = await callValidate(launched, [orphan])
  expect(result.accepted).toEqual([])
  expect(result.rejected).toHaveLength(1)
  expect(result.rejected[0].reason).toContain('not authorised')
})

test('paths returned by showOpenDialog are auto-granted and validate succeeds', async ({}, testInfo) => {
  workdir = await mkdtemp(path.join(tmpdir(), 'ouroboros-img-attach-'))
  const granted = path.join(workdir, 'photo.png')
  await writeFile(granted, PNG_HEADER)

  launched = await launchTestApp(testInfo, {
    dialogResponses: [granted],
  })

  // Drive the dialog so main grants the path.
  const picked = await launched.page.evaluate(
    async () =>
      window.ouroboros.showOpenDialog({
        title: 'Pick',
        properties: ['openFile'],
      }),
  )
  expect(picked).toBe(granted)

  const result = await callValidate(launched, [granted])
  expect(result.rejected).toEqual([])
  expect(result.accepted).toHaveLength(1)
  expect(result.accepted[0].path).toBe(granted)
})

test('agent/run with an ungranted image path is denied with PolicyError', async ({}, testInfo) => {
  workdir = await mkdtemp(path.join(tmpdir(), 'ouroboros-img-attach-'))
  const orphan = path.join(workdir, 'orphan.png')
  await writeFile(orphan, PNG_HEADER)

  launched = await launchTestApp(testInfo)

  const response = await callRpc(launched, 'agent/run', {
    message: 'Read it',
    images: [
      {
        path: orphan,
        name: 'orphan.png',
        mediaType: 'image/png',
        sizeBytes: PNG_HEADER.byteLength,
      },
    ],
  })

  expect(response.ok).toBe(false)
  if (!response.ok) {
    expect(response.error.message.startsWith('PolicyError:')).toBe(true)
    expect(response.error.message).toContain('not authorised')
  }
})

test('renamed binary registered via drop is rejected by magic-byte verification', async ({}, testInfo) => {
  workdir = await mkdtemp(path.join(tmpdir(), 'ouroboros-img-attach-'))
  const fake = path.join(workdir, 'id_rsa.png')
  await writeFile(fake, '-----BEGIN OPENSSH PRIVATE KEY-----\n')

  launched = await launchTestApp(testInfo)

  const result = await launched.page.evaluate(
    async (path) =>
      window.ouroboros.registerDroppedImagePaths([path]),
    fake,
  )
  expect(result.granted).toEqual([])
  expect(result.rejected).toHaveLength(1)
  expect(result.rejected[0].reason).toContain('does not match the declared image format')
})
