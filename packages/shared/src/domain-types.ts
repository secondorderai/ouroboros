/**
 * Domain types shared between CLI and Desktop.
 * These are the shapes returned by JSON-RPC responses.
 */

export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  messageCount: number
}

export interface SkillEntry {
  name: string
  description: string
  status: 'core' | 'generated' | 'staging'
}

export type EvolutionEntryType =
  | 'skill-created'
  | 'skill-promoted'
  | 'skill-failed'
  | 'memory-updated'
  | 'memory-consolidated'
  | 'config-changed'
  | 'skill-proposal'

export interface ApprovalRequest {
  id: string
  description: string
  risk: 'high' | 'medium' | 'low'
  diff?: string
  timestamp: string
}
