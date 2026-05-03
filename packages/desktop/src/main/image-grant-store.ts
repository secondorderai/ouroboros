/**
 * Image Grant Store
 *
 * Per-window capability set of image paths the user actually attached.
 * Without this, any renderer compromise can hand `validateImageAttachments`
 * or `agent/run` an arbitrary local image path and have its bytes returned.
 *
 * Grants are issued only by main-process flows — `showOpenDialog`,
 * drag-drop registration, session-reload registration — and every grant
 * runs the same checks: image extension, regular file, ≤ 20 MB, magic
 * bytes match the declared format, canonicalized via realpath. A storming
 * renderer can still register many drops, so the per-window set is capped
 * with FIFO eviction.
 */

import type { BrowserWindow } from 'electron'
import { extname, resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { verifyImageFileMagicBytes, type ImageMediaType } from './image-magic-bytes'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_GRANTS_PER_WINDOW = 256

const IMAGE_MEDIA_TYPES_BY_EXT: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export interface GrantRejection {
  path: string
  reason: string
}

export interface GrantResult {
  granted: string[]
  rejected: GrantRejection[]
}

export class ImageGrantStore {
  private readonly grants = new WeakMap<BrowserWindow, Set<string>>()

  /**
   * Verify and register a batch of paths for a window. Returns the canonical
   * paths actually granted plus rejections. Originator paths are returned in
   * `granted` (not the canonical form) so callers can correlate with their
   * own input; both forms are stored for later `has(...)` lookups.
   */
  grant(window: BrowserWindow | null, paths: readonly string[]): GrantResult {
    const granted: string[] = []
    const rejected: GrantRejection[] = []
    if (!window) {
      for (const path of paths) {
        rejected.push({ path: String(path ?? ''), reason: 'no active window' })
      }
      return { granted, rejected }
    }

    const set = this.ensureSet(window)
    for (const original of paths) {
      const verdict = verifyAndCanonicalize(original)
      if ('reason' in verdict) {
        rejected.push({ path: String(original ?? ''), reason: verdict.reason })
        continue
      }
      // Insert both the original-resolved and the canonical form so caller
      // lookups using either succeed. WeakMap of Set<string> uses insertion
      // order; eviction below keeps the most recent MAX_GRANTS_PER_WINDOW.
      addWithEviction(set, verdict.resolved)
      if (verdict.canonical !== verdict.resolved) {
        addWithEviction(set, verdict.canonical)
      }
      granted.push(verdict.resolved)
    }
    return { granted, rejected }
  }

  has(window: BrowserWindow | null, path: string): boolean {
    if (!window) return false
    const set = this.grants.get(window)
    if (!set || typeof path !== 'string' || path.length === 0) return false

    let resolved: string
    try {
      resolved = resolve(path)
    } catch {
      return false
    }
    if (set.has(resolved)) return true

    try {
      const canonical = realpathSync(resolved)
      return set.has(canonical)
    } catch {
      return false
    }
  }

  forget(window: BrowserWindow): void {
    this.grants.delete(window)
  }

  /** Visible for tests. */
  size(window: BrowserWindow): number {
    return this.grants.get(window)?.size ?? 0
  }

  private ensureSet(window: BrowserWindow): Set<string> {
    let set = this.grants.get(window)
    if (!set) {
      set = new Set<string>()
      this.grants.set(window, set)
    }
    return set
  }
}

function addWithEviction(set: Set<string>, value: string): void {
  if (set.has(value)) {
    // Refresh recency by re-inserting at the end of the iteration order.
    set.delete(value)
    set.add(value)
    return
  }
  set.add(value)
  while (set.size > MAX_GRANTS_PER_WINDOW) {
    const first = set.values().next()
    if (first.done) break
    set.delete(first.value)
  }
}

interface CanonicalPath {
  resolved: string
  canonical: string
  mediaType: ImageMediaType
}

function verifyAndCanonicalize(input: unknown): CanonicalPath | { reason: string } {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { reason: 'path must be a non-empty string' }
  }
  let resolved: string
  try {
    resolved = resolve(input)
  } catch (error) {
    return { reason: errorMessage(error) }
  }
  const mediaType = IMAGE_MEDIA_TYPES_BY_EXT[extname(resolved).toLowerCase()]
  if (!mediaType) {
    return { reason: 'unsupported image extension (jpg, jpeg, png, webp only)' }
  }
  let canonical: string
  let stats: ReturnType<typeof statSync>
  try {
    canonical = realpathSync(resolved)
    stats = statSync(canonical)
  } catch (error) {
    return { reason: errorMessage(error) }
  }
  if (!stats.isFile()) {
    return { reason: 'path is not a regular file' }
  }
  if (stats.size > MAX_IMAGE_BYTES) {
    return { reason: 'image is larger than 20 MB' }
  }
  if (stats.size === 0) {
    return { reason: 'image is empty' }
  }
  // Re-check the canonical extension (a symlink might point at a non-image).
  const canonicalMediaType = IMAGE_MEDIA_TYPES_BY_EXT[extname(canonical).toLowerCase()]
  if (!canonicalMediaType || canonicalMediaType !== mediaType) {
    return { reason: 'symlink target has a different image format' }
  }
  let magicOk: boolean
  try {
    magicOk = verifyImageFileMagicBytes(canonical, mediaType)
  } catch (error) {
    return { reason: errorMessage(error) }
  }
  if (!magicOk) {
    return { reason: 'file content does not match the declared image format' }
  }
  return { resolved, canonical, mediaType }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
