/**
 * RSI Event Types
 *
 * Shared types for RSI events emitted by the orchestrator
 * and consumed by the agent and CLI.
 */

import type { ReflectionRecord, CrystallizationResult } from './crystallize'
import type { DreamResult } from '@src/memory/dream'

// ── RSI Events ─────────────────────────────────────────────────────

export type RSIEvent =
  | { type: 'rsi-reflection'; reflection: ReflectionRecord }
  | { type: 'rsi-crystallization'; result: CrystallizationResult }
  | { type: 'rsi-dream'; result: DreamResult }
  | { type: 'rsi-error'; stage: string; error: Error }

export type RSIEventHandler = (event: RSIEvent) => void
