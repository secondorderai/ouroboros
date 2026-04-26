import { z } from 'zod'
import { ok, err } from '@src/types'
import type { TypedToolExecute } from './types'
import { hardenHtml, DEFAULT_CDN_ALLOWLIST } from '@src/artifacts/csp'
import { nextVersionFor, writeArtifact, type ArtifactMetadata } from '@src/artifacts/storage'
import { DEFAULT_ARTIFACTS_CONFIG } from '@src/config'

export const name = 'create-artifact'

export const description =
  'Create a self-contained HTML5 artifact for the user. The HTML must be a single document; ' +
  'inline <style> and <script> are fine. External <script src> and <link href> may only reference ' +
  'allowlisted CDNs (https://cdn.jsdelivr.net, https://unpkg.com, https://cdnjs.cloudflare.com); ' +
  'all other network access is blocked. The artifact is sandboxed (no same-origin, no fetch, no eval). ' +
  'Do not use \'eval\', dynamic function constructors, or <script type="text/babel"> -- the CSP omits unsafe-eval. ' +
  'Set `supersedes` to an existing artifactId to publish a new version of that artifact.'

export const schema = z.object({
  title: z.string().min(1).max(120).describe('Short title shown in the panel tab'),
  html: z.string().min(1).describe('Complete HTML5 document, self-contained'),
  description: z
    .string()
    .max(500)
    .optional()
    .describe('One-line summary of what the artifact does'),
  supersedes: z.string().optional().describe('Existing artifactId to replace with a new version'),
})

export interface CreateArtifactResult {
  artifactId: string
  version: number
  title: string
  description?: string
  path: string
  bytes: number
  createdAt: string
  warnings: string[]
}

export const execute: TypedToolExecute<typeof schema, CreateArtifactResult> = async (
  args,
  context,
) => {
  const sessionId = context?.sessionId
  if (!sessionId) {
    return err(new Error('create-artifact requires an active session'))
  }

  const artifactsCfg = context?.config?.artifacts ?? DEFAULT_ARTIFACTS_CONFIG
  const allowlist = artifactsCfg.cdnAllowlist ?? DEFAULT_CDN_ALLOWLIST
  const maxBytes = artifactsCfg.maxBytes ?? DEFAULT_ARTIFACTS_CONFIG.maxBytes
  const basePath = context?.basePath

  const inputBytes = Buffer.byteLength(args.html, 'utf-8')
  if (inputBytes > maxBytes) {
    return err(new Error(`Artifact HTML exceeds ${maxBytes}-byte limit (got ${inputBytes} bytes)`))
  }

  const hardened = hardenHtml(args.html, allowlist)
  if (!hardened.ok) return hardened

  const versionResult = nextVersionFor(sessionId, args.supersedes, basePath)
  if (!versionResult.ok) return versionResult
  const { artifactId, version } = versionResult.value

  const written = writeArtifact({
    sessionId,
    artifactId,
    version,
    html: hardened.value.html,
    title: args.title,
    description: args.description,
    basePath,
  })
  if (!written.ok) return written

  const meta: ArtifactMetadata = written.value.metadata

  context?.emitEvent?.({
    type: 'artifact-created',
    artifactId: meta.artifactId,
    version: meta.version,
    sessionId,
    title: meta.title,
    description: meta.description,
    path: written.value.path,
    bytes: meta.bytes,
    createdAt: meta.createdAt,
  })

  return ok({
    artifactId: meta.artifactId,
    version: meta.version,
    title: meta.title,
    description: meta.description,
    path: written.value.path,
    bytes: meta.bytes,
    createdAt: meta.createdAt,
    warnings: hardened.value.warnings,
  })
}
