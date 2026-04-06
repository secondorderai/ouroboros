import React, { useState, useEffect, useCallback, useRef } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { InputBar } from './components/InputBar'
import { useTheme } from './hooks/useTheme'
import { useConversationStore } from './stores/conversationStore'

// Key for persisting sidebar state
const SIDEBAR_STATE_KEY = 'ouroboros:sidebar-open'

export function App(): React.ReactElement {
  const { resolvedTheme, toggleTheme } = useTheme()

  // Sidebar open/closed state — initialize from localStorage
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STATE_KEY)
      return stored !== null ? stored === 'true' : true
    } catch {
      return true
    }
  })

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const setModelName = useConversationStore((s) => s.setModelName)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)

  // Persist sidebar state
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, String(sidebarOpen))
    } catch {
      // ignore
    }
  }, [sidebarOpen])

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

  // Fetch config on mount to populate model name
  useEffect(() => {
    const api = window.ouroboros
    if (!api) return
    api
      .rpc('config/get', {})
      .then((result) => {
        const config = result as { model?: { name?: string } }
        if (config?.model?.name) {
          setModelName(config.model.name)
        }
      })
      .catch((err) => {
        console.error('config/get failed:', err)
      })
  }, [setModelName])

  // ---- Drag-and-drop handlers -----------------------------------------------

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    const files = e.dataTransfer.files
    if (files.length === 0) return

    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      // Electron provides the path property on dropped files
      const filePath = (file as unknown as { path?: string }).path
      if (filePath) {
        paths.push(filePath)
      }
    }

    if (paths.length > 0) {
      // Forward to InputBar via the global callback
      const addFiles = (window as unknown as Record<string, unknown>)
        .__inputBarAddFiles as ((files: string[]) => void) | undefined
      if (addFiles) {
        addFiles(paths)
      }
    }
  }, [])

  // Check if workspace is already set (e.g. from the CLI working directory)
  useEffect(() => {
    // Workspace will be set via the workspace indicator interaction
    // or from config. No automatic detection needed.
  }, [setWorkspace])

  return (
    <div style={styles.app}>
      <TitleBar
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
      />
      <div style={styles.body}>
        <Sidebar isOpen={sidebarOpen} />
        <div
          style={styles.main}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div style={styles.content}>
            <div style={styles.placeholder}>
              <div style={styles.logoContainer}>
                <OuroborosLogo />
              </div>
              <h1 style={styles.title}>Ouroboros</h1>
              <p style={styles.subtitle}>Self-improving AI agent</p>
            </div>
          </div>
          <InputBar isDragOver={isDragOver} />
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
    backgroundColor: 'var(--bg-primary)',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--bg-chat)',
    overflow: 'auto',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    opacity: 0.8,
  },
  logoContainer: {
    marginBottom: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
    lineHeight: 1.0,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: 400,
    color: 'var(--text-tertiary)',
    margin: 0,
  },
}
