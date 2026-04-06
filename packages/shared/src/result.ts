/**
 * Result type — used across all Ouroboros packages.
 * Represents either a success value or an error, never throws.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: Error }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(error: Error): Result<T> {
  return { ok: false, error }
}
