import React, { useCallback, useState } from 'react'
import type { OuroborosConfig } from '../../../shared/protocol'

interface PermissionsSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

interface TierInfo {
  key: keyof OuroborosConfig['permissions']
  label: string
  description: string
  defaultOn: boolean
  disabled?: boolean
  warnOnEnable?: string
}

const TIERS: TierInfo[] = [
  {
    key: 'tier0',
    label: 'Tier 0: Read-only',
    description: 'Agent can read files and data.',
    defaultOn: true,
    disabled: true,
  },
  {
    key: 'tier1',
    label: 'Tier 1: Scoped writes',
    description: 'Agent can write to designated files.',
    defaultOn: true,
  },
  {
    key: 'tier2',
    label: 'Tier 2: Skill generation',
    description: 'Agent can create new skills.',
    defaultOn: true,
  },
  {
    key: 'tier3',
    label: 'Tier 3: Self-modification',
    description: 'Agent can modify its own system prompt and config.',
    defaultOn: false,
    warnOnEnable:
      'This allows the agent to modify its own system prompt and configuration. Are you sure?',
  },
  {
    key: 'tier4',
    label: 'Tier 4: System-level',
    description: 'Agent can execute system commands and modify permissions.',
    defaultOn: false,
    warnOnEnable:
      'This allows the agent to execute system-level commands and modify its own permissions. Are you sure?',
  },
]

export function PermissionsSection({
  config,
  onConfigChange,
}: PermissionsSectionProps): React.ReactElement {
  const [confirmTier, setConfirmTier] = useState<TierInfo | null>(null)

  const handleToggle = useCallback(
    (tier: TierInfo) => {
      const currentValue = config?.permissions?.[tier.key] ?? tier.defaultOn
      const newValue = !currentValue

      // If enabling a tier with warning, show confirmation
      if (newValue && tier.warnOnEnable) {
        setConfirmTier(tier)
        return
      }

      onConfigChange(`permissions.${tier.key}`, newValue)
    },
    [config, onConfigChange]
  )

  const handleConfirmEnable = useCallback(() => {
    if (confirmTier) {
      onConfigChange(`permissions.${confirmTier.key}`, true)
      setConfirmTier(null)
    }
  }, [confirmTier, onConfigChange])

  const handleCancelEnable = useCallback(() => {
    setConfirmTier(null)
  }, [])

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Permissions</h3>
      <p style={styles.sectionDescription}>
        Control what the agent is allowed to do. Higher tiers grant more
        capabilities.
      </p>

      <div style={styles.tierList}>
        {TIERS.map((tier) => {
          const isChecked =
            config?.permissions?.[tier.key] ?? tier.defaultOn
          return (
            <div key={tier.key} style={styles.tierRow}>
              <div style={styles.tierInfo}>
                <span style={styles.tierLabel}>{tier.label}</span>
                <span style={styles.tierDescription}>
                  {tier.description}
                </span>
              </div>
              <button
                className="settings-toggle"
                data-checked={isChecked}
                disabled={tier.disabled}
                onClick={() => handleToggle(tier)}
                aria-label={`${tier.label}: ${isChecked ? 'enabled' : 'disabled'}`}
              />
            </div>
          )
        })}
      </div>

      {/* Confirmation dialog */}
      {confirmTier && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmText}>{confirmTier.warnOnEnable}</p>
            <div style={styles.confirmActions}>
              <button
                style={styles.confirmButton}
                onClick={handleConfirmEnable}
              >
                Enable
              </button>
              <button
                style={styles.cancelButton}
                onClick={handleCancelEnable}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    position: 'relative' as const,
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
  tierList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  tierRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderRadius: 'var(--radius-standard)',
    gap: 16,
  },
  tierInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  tierLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  tierDescription: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },
  confirmOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1100,
    backgroundColor: 'var(--bg-overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDialog: {
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: 12,
    padding: 24,
    maxWidth: 400,
    boxShadow: 'var(--shadow-xl)',
  },
  confirmText: {
    fontSize: 14,
    color: 'var(--text-primary)',
    lineHeight: 1.5,
    margin: '0 0 16px 0',
  },
  confirmActions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
  confirmButton: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
  },
  cancelButton: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
}
