import React, { useEffect, useRef, useState } from 'react'
import type { SkillInfo, RSICheckpointDetail } from '../../shared/protocol'
import type {
  RSIActivity,
  RSIHistoryEntryView,
  RSIHistoryFilter,
  RSIStats,
  RSITab,
} from '../hooks/useRSI'
import { formatAbsoluteTime, formatRelativeTime, historyDateGroup } from '../hooks/useRSI'

interface RSIDrawerProps {
  isOpen: boolean
  onClose: () => void
  activeTab: RSITab
  onTabChange: (tab: RSITab) => void
  historyFilter: RSIHistoryFilter
  onHistoryFilterChange: (filter: RSIHistoryFilter) => void
  selectedHistoryItemId: string | null
  onSelectHistoryItem: (id: string | null) => void
  selectedHistoryItem: RSIHistoryEntryView | null
  selectedCheckpoint: RSICheckpointDetail | null
  stats: RSIStats | null
  activities: RSIActivity[]
  historyEntries: RSIHistoryEntryView[]
  skills: SkillInfo[]
  loading: boolean
  historyDetailLoading: boolean
  dreamRunning: boolean
  onRunDream: () => void
}

const HISTORY_FILTERS: Array<{ id: RSIHistoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'reflections', label: 'Reflections' },
  { id: 'crystallizations', label: 'Crystallizations' },
  { id: 'dream', label: 'Dream' },
  { id: 'memory', label: 'Memory' },
  { id: 'errors', label: 'Errors' },
]

const DRAWER_TABS: Array<{ id: RSITab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'history', label: 'History' },
  { id: 'skills', label: 'Skills' },
]

const DEFAULT_DRAWER_WIDTH = 960
const MIN_DRAWER_WIDTH = 640
const DRAWER_VIEWPORT_MARGIN = 24

function clampDrawerWidth(width: number): number {
  if (typeof window === 'undefined') {
    return Math.max(MIN_DRAWER_WIDTH, Math.min(DEFAULT_DRAWER_WIDTH, width))
  }

  const maxWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - DRAWER_VIEWPORT_MARGIN)
  return Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, width))
}

function badgeStyle(skill: SkillInfo): React.CSSProperties {
  if (skill.status === 'core' || skill.status === 'builtin') {
    return { backgroundColor: 'var(--accent-blue)', color: '#fff' }
  }
  return { backgroundColor: 'var(--accent-purple)', color: '#fff' }
}

function badgeLabel(skill: SkillInfo): string {
  return skill.status ? skill.status[0].toUpperCase() + skill.status.slice(1) : 'Skill'
}

function toneStyle(
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | undefined,
): React.CSSProperties {
  switch (tone) {
    case 'accent':
      return {
        backgroundColor: 'var(--accent-muted)',
        color: 'var(--accent-primary)',
        borderColor: 'color-mix(in srgb, var(--accent-primary) 24%, var(--border-light) 76%)',
      }
    case 'success':
      return {
        backgroundColor: 'rgba(22,163,74,0.14)',
        color: 'var(--accent-green, #16A34A)',
        borderColor: 'rgba(22,163,74,0.24)',
      }
    case 'warning':
      return {
        backgroundColor: 'rgba(234,88,12,0.14)',
        color: 'var(--accent-orange, #EA580C)',
        borderColor: 'rgba(234,88,12,0.24)',
      }
    case 'danger':
      return {
        backgroundColor: 'rgba(220,38,38,0.14)',
        color: 'var(--accent-red, #DC2626)',
        borderColor: 'rgba(220,38,38,0.24)',
      }
    default:
      return {
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        borderColor: 'var(--border-light)',
      }
  }
}

function groupHistoryEntries(
  entries: RSIHistoryEntryView[],
): Array<{ label: string; entries: RSIHistoryEntryView[] }> {
  const order = ['Today', 'Yesterday', 'This Week', 'Older']
  const groups = new Map<string, RSIHistoryEntryView[]>()

  for (const entry of entries) {
    const label = historyDateGroup(entry.timestamp)
    const group = groups.get(label) ?? []
    group.push(entry)
    groups.set(label, group)
  }

  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, entries: groups.get(label)! }))
}

function StatsRow({ stats }: { stats: RSIStats | null }): React.ReactElement {
  const items = [
    { label: 'Total Skills', value: stats?.totalSkills ?? '--' },
    { label: 'Generated', value: stats?.generated ?? '--' },
    { label: 'Analyzed', value: stats?.sessionsAnalyzed ?? '--' },
    {
      label: 'Success Rate',
      value: stats ? `${Math.round(stats.successRate * 100)}%` : '--',
    },
  ]

  return (
    <div style={styles.statsGrid}>
      {items.map((item) => (
        <div key={item.label} style={styles.statCard}>
          <span style={styles.statValue}>{item.value}</span>
          <span style={styles.statLabel}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function OverviewHero({
  stats,
  dreamRunning,
  onRunDream,
}: {
  stats: RSIStats | null
  dreamRunning: boolean
  onRunDream: () => void
}): React.ReactElement {
  return (
    <section style={styles.heroSection}>
      <div style={styles.heroCopy}>
        <span style={styles.heroEyebrow}>Self Reflection</span>
        <h3 style={styles.heroTitle}>
          Monitor learning signals, memory pressure, and reusable patterns.
        </h3>
        <p style={styles.heroSummary}>
          Use this drawer to inspect what the agent retained, what it compacted, and what is ready
          to become durable skill.
        </p>
      </div>
      <div style={styles.heroRail}>
        <StatsRow stats={stats} />
        <button
          style={{
            ...styles.primaryButton,
            ...(dreamRunning ? styles.primaryButtonDisabled : {}),
          }}
          onClick={onRunDream}
          disabled={dreamRunning}
          aria-label='Run dream cycle'
        >
          {dreamRunning ? 'Running…' : 'Run dream cycle'}
        </button>
      </div>
    </section>
  )
}

function ActivityFeed({ activities }: { activities: RSIActivity[] }): React.ReactElement {
  if (activities.length === 0) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>No recent self-improvement activity.</span>
      </div>
    )
  }

  return (
    <div style={styles.activityFeed}>
      {activities.map((activity) => (
        <div key={activity.id} style={styles.activityRow}>
          <div style={styles.timelineDot} />
          <div style={styles.activityCopy}>
            <span style={styles.activityDesc}>{activity.description}</span>
            <span style={styles.activityTime}>
              {formatRelativeTime(activity.timestamp)} · {formatAbsoluteTime(activity.timestamp)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function HistoryFilters({
  current,
  onChange,
}: {
  current: RSIHistoryFilter
  onChange: (filter: RSIHistoryFilter) => void
}): React.ReactElement {
  return (
    <div style={styles.filterScroll}>
      <div style={styles.filterWrap}>
        {HISTORY_FILTERS.map((filter) => {
          const active = filter.id === current
          return (
            <button
              key={filter.id}
              style={{
                ...styles.filterChip,
                ...(active ? styles.filterChipActive : {}),
              }}
              onClick={() => onChange(filter.id)}
              aria-pressed={active}
            >
              {filter.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function HistoryOverviewBar({
  count,
  selectedEntry,
}: {
  count: number
  selectedEntry: RSIHistoryEntryView | null
}): React.ReactElement {
  return (
    <div style={styles.historyOverviewBar}>
      <div style={styles.historyOverviewBlock}>
        <span style={styles.historyOverviewLabel}>Visible Entries</span>
        <span style={styles.historyOverviewValue}>{count}</span>
      </div>
      <div style={styles.historyOverviewDivider} />
      <div style={styles.historyOverviewBlock}>
        <span style={styles.historyOverviewLabel}>Selected</span>
        <span style={styles.historyOverviewText}>
          {selectedEntry ? selectedEntry.typeLabel : 'Choose an item'}
        </span>
      </div>
    </div>
  )
}

function HistoryTimeline({
  entries,
  selectedId,
  onSelect,
}: {
  entries: RSIHistoryEntryView[]
  selectedId: string | null
  onSelect: (id: string) => void
}): React.ReactElement {
  if (entries.length === 0) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>No history entries match this filter.</span>
      </div>
    )
  }

  return (
    <div style={styles.timelineGroups}>
      {groupHistoryEntries(entries).map((group) => (
        <section key={group.label} style={styles.timelineSection}>
          <h4 style={styles.timelineHeading}>{group.label}</h4>
          <div style={styles.timelineList}>
            {group.entries.map((entry) => {
              const active = entry.id === selectedId
              return (
                <button
                  key={entry.id}
                  style={{
                    ...styles.timelineCard,
                    ...(active ? styles.timelineCardActive : {}),
                  }}
                  onClick={() => onSelect(entry.id)}
                  aria-pressed={active}
                >
                  <div style={styles.timelineCardTop}>
                    <span style={styles.timelineLabel}>{entry.typeLabel}</span>
                    <span style={styles.timelineTimestamp}>
                      {formatRelativeTime(entry.timestamp)}
                    </span>
                  </div>
                  <span style={styles.timelineTitle}>{entry.title}</span>
                  <span style={styles.timelineSummary}>{entry.summary}</span>
                  <div style={styles.chipRow}>
                    {entry.chips.map((chip) => (
                      <span
                        key={`${entry.id}-${chip.label}`}
                        style={{ ...styles.metaChip, ...toneStyle(chip.tone) }}
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function KeyValueList({ details }: { details: Record<string, unknown> }): React.ReactElement {
  const entries = Object.entries(details).filter(
    ([, value]) => value !== undefined && value !== null,
  )
  if (entries.length === 0) {
    return <span style={styles.emptyText}>No additional metadata.</span>
  }

  return (
    <div style={styles.detailList}>
      {entries.map(([key, value]) => (
        <div key={key} style={styles.detailRow}>
          <span style={styles.detailKey}>{key}</span>
          <span style={styles.detailValue}>
            {Array.isArray(value)
              ? value.join(', ')
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value)}
          </span>
        </div>
      ))}
    </div>
  )
}

function CheckpointSections({
  checkpoint,
}: {
  checkpoint: RSICheckpointDetail
}): React.ReactElement {
  const sections: Array<{ label: string; value: string | string[] }> = [
    { label: 'Goal', value: checkpoint.goal },
    { label: 'Current Plan', value: checkpoint.currentPlan },
    { label: 'Completed Work', value: checkpoint.completedWork },
    { label: 'Open Loops', value: checkpoint.openLoops },
    { label: 'Next Best Step', value: checkpoint.nextBestStep },
    {
      label: 'Durable Memory Candidates',
      value: checkpoint.durableMemoryCandidates.map((candidate) => candidate.title),
    },
    {
      label: 'Skill Candidates',
      value: checkpoint.skillCandidates.map((candidate) => candidate.name),
    },
  ]

  return (
    <div style={styles.detailSections}>
      {sections.map((section) => {
        const items = Array.isArray(section.value) ? section.value : [section.value]
        const populated = items.filter((item) => item && item.trim().length > 0)
        return (
          <div key={section.label} style={styles.detailSection}>
            <span style={styles.detailSectionLabel}>{section.label}</span>
            {populated.length > 0 ? (
              Array.isArray(section.value) ? (
                <ul style={styles.detailListItems}>
                  {populated.map((item) => (
                    <li key={item} style={styles.detailBullet}>
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={styles.detailParagraph}>{section.value}</p>
              )
            ) : (
              <span style={styles.emptyText}>None</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function HistoryDetail({
  entry,
  checkpoint,
  loading,
}: {
  entry: RSIHistoryEntryView | null
  checkpoint: RSICheckpointDetail | null
  loading: boolean
}): React.ReactElement {
  if (!entry) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>Select a history item to inspect it.</span>
      </div>
    )
  }

  return (
    <div style={styles.detailPane}>
      <div style={styles.detailHeroCard}>
        <div style={styles.detailHero}>
          <span style={styles.detailType}>{entry.typeLabel}</span>
          <h3 style={styles.detailTitle}>{entry.title}</h3>
          <p style={styles.detailSummary}>{entry.summary}</p>
        </div>

        <div style={styles.detailMetaGrid}>
          <div style={styles.detailMetaCard}>
            <span style={styles.detailMetaLabel}>Captured</span>
            <span style={styles.detailMetaValue}>{formatAbsoluteTime(entry.timestamp)}</span>
          </div>
          <div style={styles.detailMetaCard}>
            <span style={styles.detailMetaLabel}>Source</span>
            <span style={styles.detailMetaValue}>
              {entry.source === 'checkpoint' ? 'Checkpoint' : 'Evolution log'}
            </span>
          </div>
        </div>
      </div>

      <div style={styles.chipRow}>
        {entry.chips.map((chip) => (
          <span
            key={`${entry.id}-detail-${chip.label}`}
            style={{ ...styles.metaChip, ...toneStyle(chip.tone) }}
          >
            {chip.label}
          </span>
        ))}
      </div>

      {entry.source === 'checkpoint' ? (
        loading ? (
          <div style={styles.loadingState}>
            <Spinner />
            <span style={styles.loadingText}>Loading checkpoint details…</span>
          </div>
        ) : checkpoint ? (
          <CheckpointSections checkpoint={checkpoint} />
        ) : (
          <div style={styles.emptyState}>
            <span style={styles.emptyText}>Checkpoint details unavailable.</span>
          </div>
        )
      ) : (
        <div style={styles.detailSectionCard}>
          <KeyValueList details={entry.details ?? {}} />
        </div>
      )}
    </div>
  )
}

function SkillItem({ skill }: { skill: SkillInfo }): React.ReactElement {
  return (
    <div style={styles.skillRow}>
      <div style={styles.skillHeader}>
        <div style={styles.skillCopy}>
          <span style={styles.skillName}>{skill.name}</span>
          <span style={styles.skillVersion}>v{skill.version}</span>
        </div>
        <span style={{ ...styles.skillBadge, ...badgeStyle(skill) }}>{badgeLabel(skill)}</span>
      </div>
      <span style={styles.skillDescription}>
        {skill.description || 'No description available.'}
      </span>
    </div>
  )
}

function SkillsList({ skills }: { skills: SkillInfo[] }): React.ReactElement {
  if (skills.length === 0) {
    return (
      <div style={styles.emptyState}>
        <span style={styles.emptyText}>No skills loaded.</span>
      </div>
    )
  }

  return (
    <div style={styles.skillList}>
      {skills.map((skill) => (
        <SkillItem key={skill.name} skill={skill} />
      ))}
    </div>
  )
}

function Spinner(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 16 16'
      fill='none'
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <circle
        cx='8'
        cy='8'
        r='6'
        stroke='currentColor'
        strokeWidth='2'
        strokeDasharray='28'
        strokeDashoffset='8'
        strokeLinecap='round'
      />
    </svg>
  )
}

export function RSIDrawer({
  isOpen,
  onClose,
  activeTab,
  onTabChange,
  historyFilter,
  onHistoryFilterChange,
  selectedHistoryItemId,
  onSelectHistoryItem,
  selectedHistoryItem,
  selectedCheckpoint,
  stats,
  activities,
  historyEntries,
  skills,
  loading,
  historyDetailLoading,
  dreamRunning,
  onRunDream,
}: RSIDrawerProps): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (isOpen) {
      setVisible(true)
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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      setDrawerWidth((current) => clampDrawerWidth(current))
    }

    handleResize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    if (!isResizing) {
      return
    }

    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) {
        return
      }

      const deltaX = resizeState.startX - event.clientX
      setDrawerWidth(clampDrawerWidth(resizeState.startWidth + deltaX))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      resizeStateRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: drawerWidth,
    }
    setIsResizing(true)
  }

  if (!visible) return null

  return (
    <>
      <div
        style={{ ...styles.overlay, opacity: animating ? 1 : 0 }}
        onClick={onClose}
        aria-hidden='true'
      />

      <div
        ref={drawerRef}
        style={{
          ...styles.drawer,
          width: drawerWidth,
          transform: animating ? 'translateX(0)' : 'translateX(100%)',
          transition: isResizing ? 'none' : styles.drawer.transition,
        }}
        className='no-select'
        role='dialog'
        aria-label='Self-Improvement drawer'
      >
        <div
          style={{
            ...styles.resizeHandle,
            ...(isResizing ? styles.resizeHandleActive : {}),
          }}
          onMouseDown={handleResizeStart}
          role='separator'
          aria-orientation='vertical'
          aria-label='Resize drawer'
        />
        <div style={styles.header}>
          <div style={styles.headerCopy}>
            <h2 style={styles.headerTitle}>Self-Improvement</h2>
            <span style={styles.headerSubtitle}>Reflection browser</span>
          </div>
          <button style={styles.closeButton} onClick={onClose} aria-label='Close drawer'>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.content}>
          {loading ? (
            <div style={styles.loadingState}>
              <Spinner />
              <span style={styles.loadingText}>Loading self-improvement data…</span>
            </div>
          ) : activeTab === 'overview' ? (
            <div style={styles.sectionStack}>
              <OverviewHero stats={stats} dreamRunning={dreamRunning} onRunDream={onRunDream} />

              <div style={styles.tabBar} role='tablist' aria-label='Self-Improvement sections'>
                {DRAWER_TABS.map((tab) => {
                  const active = tab.id === activeTab
                  return (
                    <button
                      key={tab.id}
                      style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
                      onClick={() => onTabChange(tab.id)}
                      role='tab'
                      aria-selected={active}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>

              <section style={styles.sectionBlock}>
                <div style={styles.sectionHeader}>
                  <h3 style={styles.sectionTitle}>Recent Activity</h3>
                  <span style={styles.sectionHint}>
                    Live reflection, checkpoint, compaction, and dream-cycle signals.
                  </span>
                </div>
                <ActivityFeed activities={activities} />
              </section>
            </div>
          ) : activeTab === 'history' ? (
            <div style={styles.historyLayout}>
              <div style={styles.historyColumn}>
                <div style={styles.tabBar} role='tablist' aria-label='Self-Improvement sections'>
                  {DRAWER_TABS.map((tab) => {
                    const active = tab.id === activeTab
                    return (
                      <button
                        key={tab.id}
                        style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
                        onClick={() => onTabChange(tab.id)}
                        role='tab'
                        aria-selected={active}
                      >
                        {tab.label}
                      </button>
                    )
                  })}
                </div>
                <div style={styles.sectionHeader}>
                  <h3 style={styles.sectionTitle}>History</h3>
                  <span style={styles.sectionHint}>
                    Browse reflection checkpoints and evolution events.
                  </span>
                </div>
                <HistoryOverviewBar
                  count={historyEntries.length}
                  selectedEntry={selectedHistoryItem}
                />
                <HistoryFilters current={historyFilter} onChange={onHistoryFilterChange} />
                <div style={styles.timelineScrollArea}>
                  <HistoryTimeline
                    entries={historyEntries}
                    selectedId={selectedHistoryItemId}
                    onSelect={onSelectHistoryItem}
                  />
                </div>
              </div>
              <div style={styles.detailColumn}>
                <HistoryDetail
                  entry={selectedHistoryItem}
                  checkpoint={selectedCheckpoint}
                  loading={historyDetailLoading}
                />
              </div>
            </div>
          ) : (
            <div style={styles.sectionStack}>
              <div style={styles.tabBar} role='tablist' aria-label='Self-Improvement sections'>
                {DRAWER_TABS.map((tab) => {
                  const active = tab.id === activeTab
                  return (
                    <button
                      key={tab.id}
                      style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
                      onClick={() => onTabChange(tab.id)}
                      role='tab'
                      aria-selected={active}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>
              <section style={styles.sectionBlock}>
                <div style={styles.sectionHeader}>
                  <h3 style={styles.sectionTitle}>Skills</h3>
                  <span style={styles.sectionHint}>
                    Generated and core skills available to the agent.
                  </span>
                </div>
                <SkillsList skills={skills} />
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 16 16'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <line x1='4' y1='4' x2='12' y2='12' />
      <line x1='12' y1='4' x2='4' y2='12' />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'color-mix(in srgb, var(--bg-overlay) 100%, #000 12%)',
    zIndex: 200,
    transition: 'opacity 200ms ease',
  },
  drawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: DEFAULT_DRAWER_WIDTH,
    maxWidth: '100vw',
    backgroundColor: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 201,
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 200ms ease',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    left: -4,
    bottom: 0,
    width: 8,
    cursor: 'col-resize',
    zIndex: 1,
  },
  resizeHandleActive: {
    backgroundColor: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '18px 18px 12px',
    borderBottom: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-secondary)',
  },
  headerCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: 1.2,
  },
  headerSubtitle: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  closeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 10,
    margin: -4,
  },
  tabBar: {
    display: 'flex',
    gap: 8,
    padding: 4,
    flexWrap: 'wrap',
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-subtle)',
  },
  tabButton: {
    border: '1px solid var(--border-medium)',
    backgroundColor: 'var(--bg-chat)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 999,
    padding: '8px 13px',
    cursor: 'pointer',
    transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
  },
  tabButtonActive: {
    backgroundColor: 'var(--accent-primary)',
    color: 'var(--text-inverse)',
    borderColor: 'var(--accent-primary)',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  sectionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    padding: 18,
    overflowY: 'auto',
  },
  heroSection: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.3fr) minmax(220px, 0.9fr)',
    gap: 16,
    padding: 16,
    borderRadius: 18,
    border: '1px solid var(--border-medium)',
    background:
      'linear-gradient(180deg, var(--bg-chat) 0%, color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-chat) 28%) 100%)',
    boxShadow: 'var(--shadow-subtle)',
  },
  heroCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  heroEyebrow: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--accent-primary)',
  },
  heroTitle: {
    margin: 0,
    fontSize: 20,
    lineHeight: 1.24,
    fontWeight: 600,
    color: 'var(--text-primary)',
    maxWidth: 320,
  },
  heroSummary: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--text-primary)',
    maxWidth: 400,
  },
  heroRail: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    justifyContent: 'space-between',
  },
  sectionBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    borderRadius: 14,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-chat)',
    boxShadow: 'var(--shadow-subtle)',
  },
  sectionHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  sectionHint: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    maxWidth: 420,
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '12px 13px',
    borderRadius: 12,
    backgroundColor: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
  },
  statValue: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  activityFeed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  activityRow: {
    display: 'grid',
    gridTemplateColumns: '10px 1fr',
    gap: 10,
    alignItems: 'start',
  },
  timelineDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    marginTop: 6,
    backgroundColor: 'var(--accent-primary)',
  },
  activityCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  activityDesc: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
  },
  activityTime: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },
  overviewActionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  primaryButton: {
    border: '1px solid var(--accent-primary)',
    backgroundColor: 'var(--accent-primary)',
    color: '#fff',
    borderRadius: 'var(--radius-standard)',
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  primaryButtonDisabled: {
    opacity: 0.7,
    cursor: 'default',
  },
  historyLayout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(320px, 380px) minmax(0, 1fr)',
    gap: 20,
    flex: 1,
    minHeight: 0,
    padding: 20,
  },
  historyColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
    minHeight: 0,
    padding: 18,
    borderRadius: 20,
    backgroundColor: 'var(--bg-chat)',
    border: '1px solid var(--border-light)',
    boxShadow: 'var(--shadow-subtle)',
  },
  detailColumn: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    minWidth: 0,
    minHeight: 0,
  },
  historyOverviewBar: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1.1fr)',
    gap: 14,
    alignItems: 'stretch',
    padding: '14px 16px',
    borderRadius: 16,
    background:
      'linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 75%, var(--bg-chat) 25%) 0%, var(--bg-chat) 100%)',
    border: '1px solid var(--border-light)',
  },
  historyOverviewBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
  },
  historyOverviewLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
  },
  historyOverviewValue: {
    fontSize: 24,
    lineHeight: 1,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  historyOverviewText: {
    fontSize: 13,
    lineHeight: 1.45,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  historyOverviewDivider: {
    width: 1,
    backgroundColor: 'var(--border-light)',
  },
  timelineScrollArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    marginRight: -4,
    paddingRight: 4,
  },
  filterScroll: {
    overflowX: 'auto',
    paddingBottom: 2,
  },
  filterWrap: {
    display: 'flex',
    flexWrap: 'nowrap',
    gap: 8,
    minWidth: 'max-content',
  },
  filterChip: {
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-chat)',
    color: 'var(--text-primary)',
    borderRadius: 999,
    padding: '6px 11px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  filterChipActive: {
    backgroundColor: 'var(--accent-primary)',
    color: 'var(--text-inverse)',
    borderColor: 'var(--accent-primary)',
  },
  timelineGroups: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  timelineSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  timelineHeading: {
    margin: 0,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.05em',
  },
  timelineList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  timelineCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '16px 16px 15px',
    borderRadius: 16,
    border: '1px solid var(--border-light)',
    background:
      'linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 48%, var(--bg-chat) 52%) 0%, var(--bg-chat) 100%)',
    textAlign: 'left',
    cursor: 'pointer',
    boxShadow: 'var(--shadow-subtle)',
    transition: 'background-color 140ms ease, border-color 140ms ease, transform 140ms ease',
  },
  timelineCardActive: {
    borderColor: 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-light) 58%)',
    background:
      'linear-gradient(180deg, color-mix(in srgb, var(--accent-muted) 55%, var(--bg-chat) 45%) 0%, var(--bg-chat) 100%)',
    transform: 'translateY(-1px)',
  },
  timelineCardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
  },
  timelineLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--accent-primary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  timelineTimestamp: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    whiteSpace: 'nowrap',
  },
  timelineTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
  },
  timelineSummary: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  metaChip: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid transparent',
  },
  detailPane: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 22,
    borderRadius: 20,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-chat)',
    boxShadow: 'var(--shadow-subtle)',
    minHeight: '100%',
    position: 'sticky',
    top: 0,
  },
  detailHeroCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    paddingBottom: 18,
    borderBottom: '1px solid var(--border-light)',
  },
  detailHero: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  detailType: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--accent-primary)',
  },
  detailTitle: {
    margin: 0,
    fontSize: 24,
    fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
  },
  detailSummary: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.65,
    color: 'var(--text-primary)',
  },
  detailMetaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10,
  },
  detailMetaCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 14px',
    borderRadius: 14,
    border: '1px solid var(--border-light)',
    backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 55%, var(--bg-chat) 45%)',
  },
  detailMetaLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
  },
  detailMetaValue: {
    fontSize: 13,
    lineHeight: 1.45,
    color: 'var(--text-primary)',
    fontWeight: 600,
  },
  detailSections: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  detailSectionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '4px 0 0',
  },
  detailSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingTop: 12,
    borderTop: '1px solid var(--border-light)',
  },
  detailSectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    letterSpacing: '0.05em',
  },
  detailParagraph: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--text-primary)',
  },
  detailListItems: {
    margin: 0,
    paddingLeft: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  detailBullet: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
  },
  detailList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  detailRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(110px, 140px) 1fr',
    gap: 12,
    paddingTop: 10,
    borderTop: '1px solid var(--border-light)',
  },
  detailKey: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    textTransform: 'capitalize',
  },
  detailValue: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
    wordBreak: 'break-word',
  },
  skillList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  skillRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '14px 0',
    borderBottom: '1px solid var(--border-light)',
  },
  skillHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  skillCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  skillName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  skillVersion: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  skillBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '3px 7px',
    borderRadius: 999,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    flexShrink: 0,
  },
  skillDescriptionWrap: {
    display: 'flex',
    flexDirection: 'column',
  },
  skillDescription: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  loadingState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 32,
    color: 'var(--text-tertiary)',
  },
  loadingText: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
  },
}
