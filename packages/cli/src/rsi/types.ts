/**
 * RSI Event Types
 *
 * Shared types for RSI events emitted by the orchestrator
 * and consumed by the agent and CLI.
 */

import type { ReflectionRecord, CrystallizationResult } from './crystallize'
import type { DreamResult } from '@src/memory/dream'

// ── Structured RSI Memory Types ───────────────────────────────────

export type ObservationKind =
  | 'goal'
  | 'constraint'
  | 'decision'
  | 'artifact'
  | 'progress'
  | 'open-loop'
  | 'preference'
  | 'fact'
  | 'warning'
  | 'candidate-durable'
  | 'candidate-skill'

export type ObservationPriority = 'low' | 'normal' | 'high' | 'critical'

export interface ObservationRecord {
  id: string
  sessionId: string
  observedAt: string
  effectiveAt?: string
  kind: ObservationKind
  summary: string
  evidence: string[]
  priority: ObservationPriority
  tags: string[]
  supersedes?: string[]
}

export interface DurableMemoryCandidate {
  title: string
  summary: string
  content: string
  kind: 'fact' | 'preference' | 'constraint' | 'workflow'
  confidence: number
  observedAt: string
  tags: string[]
  evidence: string[]
}

export interface SkillCandidate {
  name: string
  summary: string
  trigger: string
  workflow: string[]
  confidence: number
  sourceObservationIds: string[]
  sourceSessionIds: string[]
}

export interface ReflectionCheckpoint {
  sessionId: string
  updatedAt: string
  goal: string
  currentPlan: string[]
  constraints: string[]
  decisionsMade: string[]
  filesInPlay: string[]
  completedWork: string[]
  openLoops: string[]
  nextBestStep: string
  durableMemoryCandidates: DurableMemoryCandidate[]
  skillCandidates: SkillCandidate[]
}

// ── RSI Events ─────────────────────────────────────────────────────

export type RSIRuntimeReason =
  | 'turn'
  | 'flush'
  | 'compact'
  | 'length-recovery'
  | 'checkpoint-seed'
  | 'dream'
  | 'crystallization'

export interface RSIRuntimeMetrics {
  usageRatio?: number | null
  estimatedTotalTokens?: number
  contextWindowTokens?: number | null
  threshold?: 'within-budget' | 'warn' | 'flush' | 'compact'
  droppedMessageCount?: number
  retainedMessageCount?: number
  tailMessageCount?: number
  repeatedWorkDetected?: boolean
}

export type RSIEvent =
  | { type: 'rsi-reflection'; reflection: ReflectionRecord }
  | { type: 'rsi-crystallization'; result: CrystallizationResult }
  | { type: 'rsi-dream'; result: DreamResult }
  | {
      type: 'rsi-observation-recorded'
      sessionId: string
      reason: RSIRuntimeReason
      observationIds: string[]
      observationKinds: ObservationKind[]
      observationCount: number
    }
  | {
      type: 'rsi-checkpoint-written'
      sessionId: string
      reason: RSIRuntimeReason
      updatedAt: string
      openLoopCount: number
      durableCandidateCount: number
      skillCandidateCount: number
    }
  | {
      type: 'rsi-context-flushed'
      sessionId: string
      reason: Extract<RSIRuntimeReason, 'flush' | 'compact' | 'length-recovery'>
      unseenMessageCount: number
      metrics: RSIRuntimeMetrics
    }
  | {
      type: 'rsi-history-compacted'
      sessionId: string
      reason: Extract<RSIRuntimeReason, 'compact' | 'length-recovery'>
      metrics: RSIRuntimeMetrics
    }
  | {
      type: 'rsi-length-recovery-succeeded'
      sessionId: string
      partialResponseLength: number
      metrics: RSIRuntimeMetrics
    }
  | {
      type: 'rsi-length-recovery-failed'
      sessionId: string
      partialResponseLength: number
      metrics: RSIRuntimeMetrics
    }
  | {
      type: 'rsi-durable-memory-promoted'
      sessionId?: string
      item: string
      kind?: string
      sourceSessionIds: string[]
      reason: Extract<RSIRuntimeReason, 'dream'>
    }
  | {
      type: 'rsi-durable-memory-pruned'
      sessionId?: string
      item: string
      kind?: string
      reason: Extract<RSIRuntimeReason, 'dream'>
    }
  | {
      type: 'rsi-skill-proposed-from-observations'
      skillName: string
      repeatCount: number
      sourceSessionIds: string[]
      reason: Extract<RSIRuntimeReason, 'crystallization'>
    }
  | { type: 'rsi-error'; stage: string; error: Error }

export type RSIEventHandler = (event: RSIEvent) => void
