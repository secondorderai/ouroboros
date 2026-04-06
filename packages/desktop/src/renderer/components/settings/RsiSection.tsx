import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { OuroborosConfig } from '../../../shared/protocol'

interface RsiSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

export function RsiSection({
  config,
  onConfigChange,
}: RsiSectionProps): React.ReactElement {
  const autoReflect = config?.rsi?.autoReflect ?? true
  const configThreshold = config?.rsi?.noveltyThreshold ?? 0.7
  const [localThreshold, setLocalThreshold] = useState(configThreshold)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync local state when config changes externally
  useEffect(() => {
    setLocalThreshold(configThreshold)
  }, [configThreshold])

  const handleAutoReflectToggle = useCallback(() => {
    onConfigChange('rsi.autoReflect', !autoReflect)
  }, [autoReflect, onConfigChange])

  const handleThresholdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value)
      setLocalThreshold(value)

      // Debounce the RPC call by 300ms
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        onConfigChange('rsi.noveltyThreshold', value)
      }, 300)
    },
    [onConfigChange]
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>RSI Behavior</h3>
      <p style={styles.sectionDescription}>
        Configure the agent's self-improvement behavior.
      </p>

      {/* Auto-reflect toggle */}
      <div style={styles.toggleRow}>
        <div style={styles.toggleInfo}>
          <span style={styles.toggleLabel}>Auto-reflect</span>
          <span style={styles.toggleDescription}>
            When enabled, the agent automatically reflects after completing
            tasks to identify improvement opportunities.
          </span>
        </div>
        <button
          className="settings-toggle"
          data-checked={autoReflect}
          onClick={handleAutoReflectToggle}
          aria-label={`Auto-reflect: ${autoReflect ? 'enabled' : 'disabled'}`}
        />
      </div>

      {/* Novelty threshold slider */}
      <div style={styles.field}>
        <div style={styles.sliderHeader}>
          <label style={styles.label}>Novelty Threshold</label>
          <span style={styles.sliderValue}>{localThreshold.toFixed(1)}</span>
        </div>
        <input
          className="settings-slider"
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={localThreshold}
          onChange={handleThresholdChange}
        />
        <span style={styles.sliderHint}>
          Lower = more skills generated, higher = only very novel patterns.
        </span>
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
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderRadius: 'var(--radius-standard)',
    gap: 16,
  },
  toggleInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  toggleDescription: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    lineHeight: 1.4,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '0 12px',
  },
  sliderHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  sliderValue: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--accent-amber)',
    fontFamily: 'var(--font-mono)',
  },
  sliderHint: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    lineHeight: 1.4,
  },
}
