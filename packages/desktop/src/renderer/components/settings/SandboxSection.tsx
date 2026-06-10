import React, { useCallback, useMemo, useState } from 'react'
import type { OuroborosConfig, SandboxUserConfig } from '../../../shared/protocol'

interface SandboxSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

/**
 * Built-in denyWrite protections enforced by the CLI policy builder. These
 * are kernel-level and not configurable — shown read-only so users
 * understand why tier-1 commands cannot touch RSI state.
 */
const BUILT_IN_PROTECTIONS: Array<{ path: string; description: string }> = [
  {
    path: 'skills/',
    description: 'Skill definitions — changes go through the tier-2/3 skill pipeline.',
  },
  {
    path: 'memory/',
    description: 'Durable and working memory state.',
  },
  {
    path: '.ouroboros',
    description: 'Runtime configuration, including this sandbox policy.',
  },
]

const CONFIRM_DISABLE_TEXT =
  'Disabling the OS sandbox removes kernel-enforced filesystem and network ' +
  'isolation from tier-0/1 commands. The permission-tier model still applies, ' +
  'but spawned processes can write anywhere your user account can. Are you sure?'

function normalizeEntries(entries: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

export function SandboxSection({
  config,
  onConfigChange,
}: SandboxSectionProps): React.ReactElement {
  const sandbox: SandboxUserConfig | undefined = config?.sandbox
  const enabled = sandbox?.enabled ?? true
  const allowedDomains = useMemo(
    () => normalizeEntries(sandbox?.network?.allowedDomains ?? []),
    [sandbox?.network?.allowedDomains],
  )
  const allowWritePaths = useMemo(
    () => normalizeEntries(sandbox?.filesystem?.allowWrite ?? []),
    [sandbox?.filesystem?.allowWrite],
  )

  const [confirmDisable, setConfirmDisable] = useState(false)
  const [domainDraft, setDomainDraft] = useState('')
  const [pathDraft, setPathDraft] = useState('')

  const handleToggle = useCallback(() => {
    if (enabled) {
      // Disabling drops OS-level isolation — confirm first.
      setConfirmDisable(true)
      return
    }
    onConfigChange('sandbox.enabled', true)
  }, [enabled, onConfigChange])

  const handleConfirmDisable = useCallback(() => {
    onConfigChange('sandbox.enabled', false)
    setConfirmDisable(false)
  }, [onConfigChange])

  const handleCancelDisable = useCallback(() => {
    setConfirmDisable(false)
  }, [])

  const handleAddDomain = useCallback(() => {
    const domain = domainDraft.trim()
    if (!domain) return
    onConfigChange('sandbox.network.allowedDomains', normalizeEntries([...allowedDomains, domain]))
    setDomainDraft('')
  }, [allowedDomains, domainDraft, onConfigChange])

  const handleRemoveDomain = useCallback(
    (domain: string) => {
      onConfigChange(
        'sandbox.network.allowedDomains',
        allowedDomains.filter((entry) => entry !== domain),
      )
    },
    [allowedDomains, onConfigChange],
  )

  const handleAddPath = useCallback(() => {
    const path = pathDraft.trim()
    if (!path) return
    onConfigChange('sandbox.filesystem.allowWrite', normalizeEntries([...allowWritePaths, path]))
    setPathDraft('')
  }, [allowWritePaths, onConfigChange, pathDraft])

  const handleRemovePath = useCallback(
    (path: string) => {
      onConfigChange(
        'sandbox.filesystem.allowWrite',
        allowWritePaths.filter((entry) => entry !== path),
      )
    },
    [allowWritePaths, onConfigChange],
  )

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Sandbox</h3>
      <p style={styles.sectionDescription}>
        Tier-0/1 bash and code execution run inside an OS-level sandbox (Seatbelt on macOS,
        bubblewrap on Linux). Blocked commands can request human approval to retry without the
        sandbox. Changes apply immediately — no restart needed.
      </p>

      {/* Enabled toggle */}
      <div style={styles.toggleRow}>
        <div style={styles.toggleInfo}>
          <span style={styles.toggleLabel}>OS sandbox</span>
          <span style={styles.toggleDescription}>
            Kernel-enforced filesystem and network isolation for spawned commands.
          </span>
        </div>
        <button
          className='settings-toggle'
          data-checked={enabled}
          onClick={handleToggle}
          aria-label={`OS sandbox: ${enabled ? 'enabled' : 'disabled'}`}
        />
      </div>

      {/* Allowed network domains */}
      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <div>
            <h4 style={styles.groupTitle}>Allowed network domains</h4>
            <p style={styles.groupDescription}>
              Extra domains sandboxed commands may reach. Package registries (npm, GitHub, bun.sh)
              and the Anthropic API are always allowed. Tools that ignore the system proxy may
              still report network failures.
            </p>
          </div>
        </div>
        <div style={styles.addRow}>
          <input
            style={styles.input}
            type='text'
            value={domainDraft}
            placeholder='example.com'
            aria-label='Add allowed domain'
            onChange={(event) => setDomainDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddDomain()
            }}
          />
          <button style={styles.addButton} onClick={handleAddDomain}>
            Add domain
          </button>
        </div>
        {allowedDomains.length === 0 ? (
          <div style={styles.emptyState}>No extra domains configured.</div>
        ) : (
          <div style={styles.entryList}>
            {allowedDomains.map((domain) => (
              <div key={domain} style={styles.entryRow}>
                <span style={styles.entryText} title={domain}>
                  {domain}
                </span>
                <button
                  style={styles.removeButton}
                  onClick={() => handleRemoveDomain(domain)}
                  aria-label={`Remove ${domain}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Extra writable paths */}
      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <div>
            <h4 style={styles.groupTitle}>Extra writable paths</h4>
            <p style={styles.groupDescription}>
              Paths merged into the sandbox write policy in addition to the workspace and
              temporary directories.
            </p>
          </div>
        </div>
        <div style={styles.addRow}>
          <input
            style={styles.input}
            type='text'
            value={pathDraft}
            placeholder='/path/to/directory'
            aria-label='Add writable path'
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddPath()
            }}
          />
          <button style={styles.addButton} onClick={handleAddPath}>
            Add path
          </button>
        </div>
        {allowWritePaths.length === 0 ? (
          <div style={styles.emptyState}>No extra writable paths configured.</div>
        ) : (
          <div style={styles.entryList}>
            {allowWritePaths.map((path) => (
              <div key={path} style={styles.entryRow}>
                <span style={styles.entryText} title={path}>
                  {path}
                </span>
                <button
                  style={styles.removeButton}
                  onClick={() => handleRemovePath(path)}
                  aria-label={`Remove ${path}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Built-in protections (read-only) */}
      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <div>
            <h4 style={styles.groupTitle}>Built-in protections</h4>
            <p style={styles.groupDescription}>
              Always write-denied for sandboxed commands, even inside writable paths. This
              kernel-enforces the tier-3 self-modification approval gate.
            </p>
          </div>
        </div>
        <div style={styles.entryList}>
          {BUILT_IN_PROTECTIONS.map((protection) => (
            <div key={protection.path} style={styles.protectionRow}>
              <span style={styles.protectionPath}>{protection.path}</span>
              <span style={styles.protectionDescription}>{protection.description}</span>
              <span style={styles.protectionBadge}>Always denied</span>
            </div>
          ))}
        </div>
      </div>

      {/* Confirmation dialog for disabling */}
      {confirmDisable && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmDialog}>
            <p style={styles.confirmText}>{CONFIRM_DISABLE_TEXT}</p>
            <div style={styles.confirmActions}>
              <button style={styles.confirmButton} onClick={handleConfirmDisable}>
                Disable sandbox
              </button>
              <button style={styles.cancelButton} onClick={handleCancelDisable}>
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
    gap: 18,
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
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderRadius: 'var(--radius-standard)',
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-secondary)',
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
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  groupDescription: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    margin: '3px 0 0',
    lineHeight: 1.4,
  },
  addRow: {
    display: 'flex',
    gap: 8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-medium)',
    borderRadius: 'var(--radius-standard)',
  },
  addButton: {
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 'var(--radius-standard)',
    border: '1px solid var(--border-medium)',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    flexShrink: 0,
  },
  entryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  entryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
  },
  entryText: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeButton: {
    padding: '4px 8px',
    fontSize: 12,
    borderRadius: 'var(--radius-standard)',
    border: '1px solid var(--border-light)',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    flexShrink: 0,
  },
  protectionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--bg-secondary)',
  },
  protectionPath: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
  },
  protectionDescription: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: 'var(--text-tertiary)',
    lineHeight: 1.4,
  },
  protectionBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.03em',
    backgroundColor: 'var(--accent-amber-bg)',
    color: 'var(--accent-amber)',
    flexShrink: 0,
  },
  emptyState: {
    padding: '14px 12px',
    fontSize: 12,
    color: 'var(--text-tertiary)',
    border: '1px dashed var(--border-light)',
    borderRadius: 'var(--radius-standard)',
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
