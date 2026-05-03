/**
 * Image magic-byte verification — desktop-side mirror.
 *
 * Mirrors `packages/cli/src/utils/image-magic-bytes.ts`. Both sides verify
 * the same headers so a renamed binary cannot pass extension-only checks
 * at either the desktop grant store or the CLI read site. The magic-byte
 * sequences are standardized and stable; do not parameterize.
 */

import { openSync, readSync, closeSync } from 'node:fs'

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export const IMAGE_HEADER_BYTES = 12

const MAGIC_BYTE_PATTERNS: Record<ImageMediaType, ReadonlyArray<number | null>> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [
    0x52, 0x49, 0x46, 0x46,
    null, null, null, null,
    0x57, 0x45, 0x42, 0x50,
  ],
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
