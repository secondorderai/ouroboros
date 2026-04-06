/**
 * Discriminated union Result type used by all tools.
 * Convention: never throw — always return a Result.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

/** Create a successful Result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Create a failed Result */
export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error }
}
