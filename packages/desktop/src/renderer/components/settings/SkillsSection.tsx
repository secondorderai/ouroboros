import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { OuroborosConfig, SkillInfo } from '../../../shared/protocol'

interface SkillsSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

function normalizePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function normalizeDisabledSkills(names: string[]): string[] {
  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).sort()
}

export function SkillsSection({
  config,
  onConfigChange,
}: SkillsSectionProps): React.ReactElement {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disabledSkills = useMemo(
    () => normalizeDisabledSkills(config?.disabledSkills ?? []),
    [config?.disabledSkills],
  )
  const skillDirectories = useMemo(
    () => normalizePaths(config?.skillDirectories ?? []),
    [config?.skillDirectories],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.ouroboros
      .rpc('skills/list', { includeDisabled: true })
      .then((result) => {
        if (cancelled) return
        setSkills(result.skills)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Failed to load skills'
        setError(message)
        setSkills([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [disabledSkills.join('\0'), skillDirectories.join('\0')])

  const handleToggleSkill = useCallback(
    (skill: SkillInfo) => {
      const nextDisabled = skill.enabled
        ? [...disabledSkills, skill.name]
        : disabledSkills.filter((name) => name !== skill.name)
      onConfigChange('disabledSkills', normalizeDisabledSkills(nextDisabled))
    },
    [disabledSkills, onConfigChange],
  )

  const handleAddPath = useCallback(async () => {
    const selected = await window.ouroboros.showOpenDialog({
      title: 'Add skills lookup path',
      properties: ['openDirectory'],
    })
    const path = Array.isArray(selected) ? selected[0] : selected
    if (!path) return
    onConfigChange('skillDirectories', normalizePaths([...skillDirectories, path]))
  }, [onConfigChange, skillDirectories])

  const handleRemovePath = useCallback(
    (path: string) => {
      onConfigChange(
        'skillDirectories',
        skillDirectories.filter((entry) => entry !== path),
      )
    },
    [onConfigChange, skillDirectories],
  )

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Skills</h3>
      <p style={styles.sectionDescription}>
        Manage Agent Skills available for lookup and configure workspace skill paths.
      </p>

      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <div>
            <h4 style={styles.groupTitle}>Available skills</h4>
            <p style={styles.groupDescription}>
              Built-in and discovered Agent Skills can be disabled without affecting tools.
            </p>
          </div>
        </div>

        {error && <div style={styles.errorText}>{error}</div>}
        {loading ? (
          <div style={styles.emptyState}>Loading skills...</div>
        ) : skills.length === 0 ? (
          <div style={styles.emptyState}>No skills discovered.</div>
        ) : (
          <div style={styles.skillList}>
            {skills.map((skill) => (
              <div key={skill.name} style={styles.skillRow}>
                <div style={styles.skillMain}>
                  <div style={styles.skillHeader}>
                    <span style={styles.skillName}>{skill.name}</span>
                    <span style={styles.skillBadge}>{skill.status ?? 'skill'}</span>
                    <span style={styles.skillVersion}>v{skill.version}</span>
                  </div>
                  <span style={styles.skillDescription}>
                    {skill.description || 'No description available.'}
                  </span>
                  {skill.path && (
                    <span style={styles.skillPath} title={skill.path}>
                      {skill.path}
                    </span>
                  )}
                </div>
                <button
                  className="settings-toggle"
                  data-checked={skill.enabled}
                  onClick={() => handleToggleSkill(skill)}
                  aria-label={`${skill.name}: ${skill.enabled ? 'enabled' : 'disabled'}`}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <div>
            <h4 style={styles.groupTitle}>Lookup paths</h4>
            <p style={styles.groupDescription}>
              These configured paths are scanned alongside built-in and user-global skill roots.
            </p>
          </div>
          <button style={styles.addButton} onClick={handleAddPath}>
            Add path
          </button>
        </div>

        {skillDirectories.length === 0 ? (
          <div style={styles.emptyState}>No configured lookup paths.</div>
        ) : (
          <div style={styles.pathList}>
            {skillDirectories.map((path) => (
              <div key={path} style={styles.pathRow}>
                <span style={styles.pathText} title={path}>
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
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
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
  skillList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  skillRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    padding: '10px 12px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--bg-secondary)',
  },
  skillMain: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  skillHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  skillName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  skillBadge: {
    fontSize: 11,
    color: 'var(--accent-amber)',
    border: '1px solid var(--border-light)',
    borderRadius: 6,
    padding: '1px 6px',
    textTransform: 'capitalize',
    flexShrink: 0,
  },
  skillVersion: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
  },
  skillDescription: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
  },
  skillPath: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pathList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  pathRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
  },
  pathText: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  emptyState: {
    padding: '14px 12px',
    fontSize: 12,
    color: 'var(--text-tertiary)',
    border: '1px dashed var(--border-light)',
    borderRadius: 'var(--radius-standard)',
  },
  errorText: {
    fontSize: 12,
    color: 'var(--text-error)',
  },
}
