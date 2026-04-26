import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type Result, ok, err } from '@src/types'
import {
  resolveArtifactsDir,
  resolveArtifactPath,
  resolveArtifactsIndexPath,
} from '@src/memory/paths'

export interface ArtifactMetadata {
  artifactId: string
  version: number
  title: string
  description?: string
  bytes: number
  createdAt: string
}

interface ArtifactIndexEntry {
  artifactId: string
  latestVersion: number
  versions: ArtifactMetadata[]
}

interface ArtifactIndex {
  version: 1
  entries: Record<string, ArtifactIndexEntry>
}

const ARTIFACT_ID_BYTES = 8
const ARTIFACT_FILE_PATTERN = /^([0-9a-z]+)\.v(\d+)\.html$/i

export function generateArtifactId(): string {
  return randomBytes(ARTIFACT_ID_BYTES).toString('hex')
}

export function loadIndex(sessionId: string, basePath?: string): Result<ArtifactIndex> {
  const indexPath = resolveArtifactsIndexPath(sessionId, basePath)
  if (!existsSync(indexPath)) {
    return ok(emptyIndex())
  }
  try {
    const raw = readFileSync(indexPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isValidIndex(parsed)) {
      return err(new Error('Artifacts index is malformed'))
    }
    return ok(parsed)
  } catch (e) {
    return err(
      new Error(`Failed to read artifacts index: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
}

export function listArtifacts(sessionId: string, basePath?: string): Result<ArtifactMetadata[]> {
  const indexResult = loadIndex(sessionId, basePath)
  if (indexResult.ok) {
    const collected = collectAllVersions(indexResult.value)
    if (collected.length > 0 || !existsSync(resolveArtifactsDir(sessionId, basePath))) {
      return ok(sortByCreatedAt(collected))
    }
  }
  const rebuilt = rebuildIndexFromDisk(sessionId, basePath)
  if (!rebuilt.ok) return rebuilt
  const writeResult = writeIndex(sessionId, rebuilt.value, basePath)
  if (!writeResult.ok) return writeResult
  return ok(sortByCreatedAt(collectAllVersions(rebuilt.value)))
}

export function readArtifact(
  sessionId: string,
  artifactId: string,
  version: number | undefined,
  basePath?: string,
): Result<{ html: string; metadata: ArtifactMetadata }> {
  const indexResult = loadIndex(sessionId, basePath)
  if (!indexResult.ok) return indexResult
  const entry = indexResult.value.entries[artifactId]
  if (!entry) {
    return err(new Error(`Unknown artifactId: ${artifactId}`))
  }
  const targetVersion = version ?? entry.latestVersion
  const metadata = entry.versions.find((v) => v.version === targetVersion)
  if (!metadata) {
    return err(new Error(`Unknown version ${targetVersion} for artifact ${artifactId}`))
  }
  const filePath = resolveArtifactPath(sessionId, artifactId, targetVersion, basePath)
  try {
    const html = readFileSync(filePath, 'utf-8')
    return ok({ html, metadata })
  } catch (e) {
    return err(
      new Error(`Failed to read artifact file: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
}

export function nextVersionFor(
  sessionId: string,
  supersedes: string | undefined,
  basePath?: string,
): Result<{ artifactId: string; version: number }> {
  if (supersedes === undefined || supersedes.trim() === '') {
    return ok({ artifactId: generateArtifactId(), version: 1 })
  }
  const indexResult = loadIndex(sessionId, basePath)
  if (!indexResult.ok) return indexResult
  const entry = indexResult.value.entries[supersedes]
  if (!entry) {
    return err(new Error(`Unknown artifactId: ${supersedes}`))
  }
  return ok({ artifactId: supersedes, version: entry.latestVersion + 1 })
}

export interface WriteArtifactInput {
  sessionId: string
  artifactId: string
  version: number
  html: string
  title: string
  description?: string
  basePath?: string
}

export function writeArtifact(
  input: WriteArtifactInput,
): Result<{ path: string; metadata: ArtifactMetadata }> {
  const { sessionId, artifactId, version, html, title, description, basePath } = input
  const dir = resolveArtifactsDir(sessionId, basePath)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return err(
      new Error(
        `Failed to create artifacts directory: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
  }
  const filePath = resolveArtifactPath(sessionId, artifactId, version, basePath)
  const bytes = Buffer.byteLength(html, 'utf-8')
  try {
    writeFileSync(filePath, html, 'utf-8')
  } catch (e) {
    return err(
      new Error(`Failed to write artifact file: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
  const metadata: ArtifactMetadata = {
    artifactId,
    version,
    title,
    description,
    bytes,
    createdAt: new Date().toISOString(),
  }
  const updateResult = updateIndex(sessionId, metadata, basePath)
  if (!updateResult.ok) return updateResult
  return ok({ path: filePath, metadata })
}

function updateIndex(
  sessionId: string,
  metadata: ArtifactMetadata,
  basePath?: string,
): Result<void> {
  const indexResult = loadIndex(sessionId, basePath)
  const index = indexResult.ok ? indexResult.value : emptyIndex()
  const existing = index.entries[metadata.artifactId]
  if (existing) {
    existing.versions = [
      ...existing.versions.filter((v) => v.version !== metadata.version),
      metadata,
    ].sort((a, b) => a.version - b.version)
    existing.latestVersion = Math.max(existing.latestVersion, metadata.version)
  } else {
    index.entries[metadata.artifactId] = {
      artifactId: metadata.artifactId,
      latestVersion: metadata.version,
      versions: [metadata],
    }
  }
  return writeIndex(sessionId, index, basePath)
}

function writeIndex(sessionId: string, index: ArtifactIndex, basePath?: string): Result<void> {
  const indexPath = resolveArtifactsIndexPath(sessionId, basePath)
  try {
    mkdirSync(resolveArtifactsDir(sessionId, basePath), { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    return ok(undefined)
  } catch (e) {
    return err(
      new Error(`Failed to write artifacts index: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
}

function rebuildIndexFromDisk(sessionId: string, basePath?: string): Result<ArtifactIndex> {
  const dir = resolveArtifactsDir(sessionId, basePath)
  if (!existsSync(dir)) {
    return ok(emptyIndex())
  }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (e) {
    return err(
      new Error(
        `Failed to read artifacts directory: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
  }
  const index = emptyIndex()
  for (const name of entries) {
    const match = ARTIFACT_FILE_PATTERN.exec(name)
    if (!match) continue
    const [, artifactId, versionStr] = match
    const version = Number.parseInt(versionStr, 10)
    if (!Number.isFinite(version) || version < 1) continue
    let bytes = 0
    try {
      const html = readFileSync(join(dir, name), 'utf-8')
      bytes = Buffer.byteLength(html, 'utf-8')
    } catch {
      continue
    }
    const metadata: ArtifactMetadata = {
      artifactId,
      version,
      title: artifactId,
      bytes,
      createdAt: new Date(0).toISOString(),
    }
    const existing = index.entries[artifactId]
    if (existing) {
      existing.versions.push(metadata)
      existing.latestVersion = Math.max(existing.latestVersion, version)
    } else {
      index.entries[artifactId] = {
        artifactId,
        latestVersion: version,
        versions: [metadata],
      }
    }
  }
  for (const entry of Object.values(index.entries)) {
    entry.versions.sort((a, b) => a.version - b.version)
  }
  return ok(index)
}

function emptyIndex(): ArtifactIndex {
  return { version: 1, entries: {} }
}

function isValidIndex(value: unknown): value is ArtifactIndex {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<ArtifactIndex>
  return v.version === 1 && typeof v.entries === 'object' && v.entries !== null
}

function collectAllVersions(index: ArtifactIndex): ArtifactMetadata[] {
  const out: ArtifactMetadata[] = []
  for (const entry of Object.values(index.entries)) {
    for (const meta of entry.versions) {
      out.push(meta)
    }
  }
  return out
}

function sortByCreatedAt(items: ArtifactMetadata[]): ArtifactMetadata[] {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
