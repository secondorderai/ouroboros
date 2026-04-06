import React, { useState, useEffect, useRef } from 'react'
import type { SkillInfo } from '../../shared/protocol'
import type { RSIActivity, RSIStats } from '../hooks/useRSI'
import { formatRelativeTime } from '../hooks/useRSI'

interface RSIDrawerProps {
  isOpen: boolean
  onClose: () => void
  stats: RSIStats | null
  activities: RSIActivity[]
  skills: SkillInfo[]
  loading: boolean
  dreamRunning: boolean
  onRunDream: () => void
}

// ── Badge Colors ─────────────────────────────────────────────────

function badgeStyle(skill: SkillInfo): React.CSSProperties {
  // Core = enabled, Generated = not enabled but not staging, Staging = name contains staging
  if (skill.enabled) {
    return { backgroundColor: 'var(--accent-blue)', color: '#fff' }
  }
  return { backgroundColor: 'var(--accent-amber)', color: '#fff' }
}

function badgeLabel(skill: SkillInfo): string {
  if (skill.enabled) return 'Core'
  return 'Generated'
}

// ── Stats Card ───────────────────────────────────────────────────

function StatsRow({ stats }: { stats: RSIStats | null }): React.ReactElement {
  const items = [
    { label: 'Total Skills', value: stats?.totalSkills ?? '--' },
    { label: 'Generated', value: stats?.generated ?? '--' },
    { label: 'Analyzed', value: stats?.sessionsAnalyzed ?? '--' },
    {
      label: 'Success Rate',
      value: stats ? `${Math.round(stats.successRate * 100)}%` : '--'
    }
  ]

  return (
    <div style={styles.statsRow}>
      {items.map((item) => (
        <div key={item.label} style={styles.statItem}>
          <span style={styles.statValue}>{item.value}</span>
          <span style={styles.statLabel}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Activity Feed ────────────────────────────────────────────────

function ActivityFeed({ activities }: { activities: RSIActivity[] }): React.ReactElement {
  if (activities.length === 0) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>No recent activity</span>
      </div>
    )
  }

  return (
    <div style={styles.activityList}>
      {activities.map((activity) => (
        <div key={activity.id} style={styles.activityItem}>
          <span style={styles.activityDesc}>{activity.description}</span>
          <span style={styles.activityTime}>{formatRelativeTime(activity.timestamp)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Skill Item ───────────────────────────────────────────────────

function SkillItem({ skill }: { skill: SkillInfo }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={styles.skillItem}>
      <button
        style={styles.skillHeader}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span style={styles.skillName}>{skill.name}</span>
        <span style={{ ...styles.skillBadge, ...badgeStyle(skill) }}>
          {badgeLabel(skill)}
        </span>
      </button>
      {expanded && (
        <div style={styles.skillDescription}>
          {skill.description || 'No description available.'}
        </div>
      )}
    </div>
  )
}

// ── Skills List ──────────────────────────────────────────────────

function SkillsList({ skills }: { skills: SkillInfo[] }): React.ReactElement {
  if (skills.length === 0) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>No skills loaded</span>
      </div>
    )
  }

  return (
    <div style={styles.skillsList}>
      {skills.map((skill) => (
        <SkillItem key={skill.name} skill={skill} />
      ))}
    </div>
  )
}

// ── Spinner ──────────────────────────────────────────────────────

function Spinner(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="28"
        strokeDashoffset="8"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ── Main Drawer ──────────────────────────────────────────────────

export function RSIDrawer({
  isOpen,
  onClose,
  stats,
  activities,
  skills,
  loading,
  dreamRunning,
  onRunDream
}: RSIDrawerProps): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [animating, setAnimating] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  // Handle open/close animation
  useEffect(() => {
    if (isOpen) {
      setVisible(true)
      // Trigger reflow before adding animation
      requestAnimationFrame(() => {
        setAnimating(true)
      })
    } else if (visible) {
      setAnimating(false)
      const timer = setTimeout(() => {
        setVisible(false)
      }, 200)
      return () => clearTimeout(timer)
    }
  }, [isOpen, visible])

  if (!visible) return null

  return (
    <>
      {/* Overlay */}
      <div
        style={{
          ...styles.overlay,
          opacity: animating ? 1 : 0
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        style={{
          ...styles.drawer,
          transform: animating ? 'translateX(0)' : 'translateX(100%)'
        }}
        className="no-select"
        role="dialog"
        aria-label="Self-Improvement drawer"
      >
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.headerTitle}>Self-Improvement</h2>
          <button
            style={styles.closeButton}
            onClick={onClose}
            aria-label="Close drawer"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {loading ? (
            <div style={styles.loadingState}>
              <Spinner />
              <span style={styles.loadingText}>Loading...</span>
            </div>
          ) : (
            <>
              {/* Stats Row */}
              <div style={styles.section}>
                <StatsRow stats={stats} />
              </div>

              {/* Recent Activity */}
              <div style={styles.section}>
                <h3 style={styles.sectionTitle}>Recent Activity</h3>
                <ActivityFeed activities={activities} />
              </div>

              {/* Skills List */}
              <div style={{ ...styles.section, flex: 1 }}>
                <h3 style={styles.sectionTitle}>Skills</h3>
                <SkillsList skills={skills} />
              </div>
            </>
          )}
        </div>

        {/* Dream Trigger */}
        <div style={styles.footer}>
          <button
            style={styles.dreamButton}
            onClick={onRunDream}
            disabled={dreamRunning}
            aria-label="Run dream cycle"
          >
            {dreamRunning ? (
              <>
                <Spinner />
                <span>Running...</span>
              </>
            ) : (
              <span>Run dream cycle</span>
            )}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Icons ────────────────────────────────────────────────────────

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  )
}

// ── Styles ───────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--bg-overlay)',
    zIndex: 200,
    transition: 'opacity 200ms ease'
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 350,
    maxWidth: '90vw',
    backgroundColor: 'var(--bg-drawer)',
    borderLeft: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 201,
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 200ms ease'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 12px',
    borderBottom: '1px solid var(--border-light)',
    flexShrink: 0
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: 1.2
  },
  closeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 6
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column'
  },
  section: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-light)'
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.05em',
    marginBottom: 8,
    margin: 0,
    paddingBottom: 8
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2
  },
  statValue: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1.0
  },
  statLabel: {
    fontSize: 11,
    fontWeight: 400,
    color: 'var(--text-secondary)',
    textAlign: 'center' as const
  },
  activityList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxHeight: 200,
    overflowY: 'auto'
  },
  activityItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2
  },
  activityDesc: {
    fontSize: 13,
    color: 'var(--text-primary)',
    lineHeight: 1.4
  },
  activityTime: {
    fontSize: 12,
    color: 'var(--text-tertiary)'
  },
  skillsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 300,
    overflowY: 'auto'
  },
  skillItem: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 'var(--radius-standard)',
    overflow: 'hidden'
  },
  skillHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: 'var(--radius-standard)',
    width: '100%',
    textAlign: 'left' as const
  },
  skillName: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary)'
  },
  skillBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 'var(--radius-micro)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    flexShrink: 0
  },
  skillDescription: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    padding: '0 8px 8px',
    lineHeight: 1.4
  },
  footer: {
    padding: 16,
    borderTop: '1px solid var(--border-light)',
    flexShrink: 0
  },
  dreamButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 16px',
    border: '1px solid var(--border-medium)',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)'
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--text-tertiary)'
  },
  loadingState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32,
    color: 'var(--text-tertiary)'
  },
  loadingText: {
    fontSize: 13,
    color: 'var(--text-tertiary)'
  }
}
