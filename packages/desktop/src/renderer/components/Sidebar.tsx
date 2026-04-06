import React from 'react'

interface SidebarProps {
  isOpen: boolean
}

export function Sidebar({ isOpen }: SidebarProps): React.ReactElement {
  return (
    <div
      style={{
        ...styles.sidebar,
        width: isOpen ? 'var(--sidebar-width)' : 0,
        minWidth: isOpen ? 'var(--sidebar-width)' : 0,
        opacity: isOpen ? 1 : 0,
        overflow: 'hidden'
      }}
      className="no-select"
    >
      <div style={styles.content}>
        <div style={styles.header}>
          <span style={styles.headerText}>Sessions</span>
        </div>
        <div style={styles.placeholder}>
          <span style={styles.placeholderText}>No sessions yet</span>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    height: '100%',
    backgroundColor: 'var(--bg-sidebar)',
    borderRight: '1px solid var(--border-light)',
    transition: 'width 0.2s ease, min-width 0.2s ease, opacity 0.2s ease',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column'
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: 250,
    overflow: 'hidden'
  },
  header: {
    padding: '16px 16px 12px',
    borderBottom: '1px solid var(--border-light)'
  },
  headerText: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.05em'
  },
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16
  },
  placeholderText: {
    fontSize: 13,
    color: 'var(--text-tertiary)'
  }
}
