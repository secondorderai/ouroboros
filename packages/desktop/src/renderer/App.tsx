import React, { useState, useEffect, useCallback } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { InputBar } from './components/InputBar'
import { useTheme } from './hooks/useTheme'

export function App(): React.ReactElement {
  const { resolvedTheme, toggleTheme } = useTheme()
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev)
  }, [])

  // Listen for sidebar toggle from menu accelerator (Cmd/Ctrl+B)
  useEffect(() => {
    const unsubscribe = window.electronAPI.toggleSidebar(() => {
      setSidebarOpen((prev) => !prev)
    })
    return unsubscribe
  }, [])

  return (
    <div style={styles.app}>
      <TitleBar
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
      />
      <div style={styles.body}>
        <Sidebar isOpen={sidebarOpen} />
        <div style={styles.main}>
          <div style={styles.content}>
            <div style={styles.placeholder}>
              <div style={styles.logoContainer}>
                <OuroborosLogo />
              </div>
              <h1 style={styles.title}>Ouroboros</h1>
              <p style={styles.subtitle}>Self-improving AI agent</p>
            </div>
          </div>
          <InputBar />
        </div>
      </div>
    </div>
  )
}

function OuroborosLogo(): React.ReactElement {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      fill="none"
      stroke="var(--text-tertiary)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="24" cy="24" r="16" />
      <path d="M 32 16 A 12 12 0 0 1 36 24" />
      <path d="M 36 24 L 33 22 M 36 24 L 34 27" />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    backgroundColor: 'var(--bg-primary)'
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden'
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden'
  },
  content: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--bg-chat)',
    overflow: 'auto'
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    opacity: 0.8
  },
  logoContainer: {
    marginBottom: 4
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: 1.0
  },
  subtitle: {
    fontSize: 14,
    fontWeight: 400,
    color: 'var(--text-tertiary)',
    margin: 0
  }
}
