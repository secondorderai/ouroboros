import { describe, expect, test } from 'bun:test'
import {
  categorizeEvolutionEntry,
  historyDateGroup,
  historyEntryFromCheckpoint,
  historyEntryFromEvolution,
} from '../src/renderer/hooks/useRSI'
import type { EvolutionEntry, RSIHistorySummary } from '../src/shared/protocol'

describe('RSI history helpers', () => {
  test('categorizeEvolutionEntry maps RSI types into browser filters', () => {
    expect(categorizeEvolutionEntry('reflection')).toBe('reflections')
    expect(categorizeEvolutionEntry('crystallization')).toBe('crystallizations')
    expect(categorizeEvolutionEntry('dream')).toBe('dream')
    expect(categorizeEvolutionEntry('history-compacted')).toBe('memory')
    expect(categorizeEvolutionEntry('error')).toBe('errors')
  })

  test('historyEntryFromCheckpoint builds checkpoint browser cards', () => {
    const summary: RSIHistorySummary = {
      sessionId: 'session-1',
      updatedAt: '2026-04-18T09:00:00.000Z',
      goal: 'Improve the RSI drawer',
      nextBestStep: 'Render a detail pane',
      openLoopCount: 2,
      durableCandidateCount: 1,
      skillCandidateCount: 1,
    }

    const entry = historyEntryFromCheckpoint(summary)
    expect(entry.id).toBe('checkpoint:session-1')
    expect(entry.category).toBe('reflections')
    expect(entry.title).toBe('Improve the RSI drawer')
    expect(entry.chips.map((chip) => chip.label)).toEqual(['2 open loops', '1 durable', '1 skills'])
  })

  test('historyEntryFromEvolution preserves metadata for detail rendering', () => {
    const entry: EvolutionEntry = {
      id: 'evo-1',
      timestamp: '2026-04-18T09:30:00.000Z',
      type: 'skill-promoted',
      description: 'Promoted a reusable pattern into a skill',
      sessionId: 'session-2',
      skillName: 'generated/review',
      details: {
        sourceSessionIds: ['session-1', 'session-2'],
      },
    }

    const view = historyEntryFromEvolution(entry)
    expect(view.id).toBe('evolution:evo-1')
    expect(view.category).toBe('crystallizations')
    expect(view.skillName).toBe('generated/review')
    expect(view.details).toEqual({
      sourceSessionIds: ['session-1', 'session-2'],
    })
  })

  test('historyDateGroup buckets timestamps for timeline sections', () => {
    expect(historyDateGroup(new Date().toISOString())).toBe('Today')
    expect(historyDateGroup(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString())).toBe(
      'This Week',
    )
  })
})
