import React, { useCallback } from 'react'
import type { OuroborosConfig } from '../../../shared/protocol'

interface MemorySectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

type Schedule = 'session-end' | 'daily' | 'manual'

const SCHEDULE_OPTIONS: Array<{ value: Schedule; label: string; description: string }> = [
  {
    value: 'session-end',
    label: 'Session-end',
    description: 'Consolidate memory when a conversation session ends.',
  },
  {
    value: 'daily',
    label: 'Daily',
    description: 'Consolidate memory once per day automatically.',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Only consolidate memory when triggered manually.',
  },
]

export function MemorySection({
  config,
  onConfigChange,
}: MemorySectionProps): React.ReactElement {
  const currentSchedule = config?.memory?.consolidationSchedule ?? 'session-end'

  const handleScheduleChange = useCallback(
    (schedule: Schedule) => {
      onConfigChange('memory.consolidationSchedule', schedule)
    },
    [onConfigChange]
  )

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Memory</h3>
      <p style={styles.sectionDescription}>
        Configure when the agent consolidates and organizes its memory.
      </p>

      <div style={styles.field}>
        <label style={styles.label}>Consolidation Schedule</label>
        <div className="settings-segment-group">
          {SCHEDULE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className="settings-segment-option"
              data-active={currentSchedule === opt.value}
              onClick={() => handleScheduleChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p style={styles.hint}>
          {SCHEDULE_OPTIONS.find((o) => o.value === currentSchedule)
            ?.description ?? ''}
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  sectionDescription: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: 0,
    lineHeight: 1.5,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  hint: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    margin: 0,
    lineHeight: 1.4,
  },
}
