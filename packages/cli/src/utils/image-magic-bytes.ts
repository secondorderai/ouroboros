/**
 * Image magic-byte verification.
 *
 * Used at every site that turns an image-extension path into bytes — both
 * the desktop main-process grant store and the JSON-RPC `agent/run` /
 * `agent/steer` reader — so a renamed binary (e.g. `id_rsa.png`) cannot
 * pass extension-only validation and exfiltrate non-image content.
 */

import { openSync, readSync, closeSync } from 'node:fs'

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export const IMAGE_HEADER_BYTES = 12

/**
 * `null` matches any byte. The first 12 bytes are sufficient to disambiguate
 * the formats we accept.
 */
const MAGIC_BYTE_PATTERNS: Record<ImageMediaType, ReadonlyArray<number | null>> = {
  // FF D8 FF — JPEG SOI
  'image/jpeg': [0xff, 0xd8, 0xff],
  // 89 50 4E 47 0D 0A 1A 0A — PNG signature
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  // RIFF????WEBP — RIFF container with WEBP fourCC at offset 8
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
}

export function matchesImageMagicBytes(buffer: Buffer, mediaType: ImageMediaType): boolean {
  const pattern = MAGIC_BYTE_PATTERNS[mediaType]
  if (!pattern || buffer.length < pattern.length) return false
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]
    if (expected === null) continue
    if (buffer[i] !== expected) return false
  }
  return true
}

/**
 * Reads the first {@link IMAGE_HEADER_BYTES} bytes from `path` and verifies
 * them against the magic-byte signature for `mediaType`. Throws on I/O error
 * so callers can surface a precise rejection reason.
 */
export function verifyImageFileMagicBytes(path: string, mediaType: ImageMediaType): boolean {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES)
    const bytesRead = readSync(fd, buffer, 0, IMAGE_HEADER_BYTES, 0)
    return matchesImageMagicBytes(buffer.subarray(0, bytesRead), mediaType)
  } finally {
    closeSync(fd)
  }
}
