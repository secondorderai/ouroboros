import React, { useState, useEffect, useCallback, useRef } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { InputBar } from './components/InputBar'
import { ChatView } from './views/ChatView'
import { OnboardingWizard } from './components/OnboardingWizard'
import { CommandPalette } from './components/CommandPalette'
import { SettingsOverlay } from './views/SettingsOverlay'
import { RSIDrawer } from './components/RSIDrawer'
import { ApprovalToastContainer } from './components/ApprovalToastContainer'
import { ApprovalQueue } from './components/ApprovalQueue'
import { AskUserDialog } from './components/AskUserDialog'
import { UpdateBanner } from './components/UpdateBanner'
import { OuroborosMark } from './components/OuroborosMark'
import { TeamGraphDrawer } from './components/TeamGraphDrawer'
import { useTheme } from './hooks/useTheme'
import { useNotifications } from './hooks/useNotifications'
import { useModeSync } from './hooks/useModeSync'
import { useRSI } from './hooks/useRSI'
import { useConversationStore } from './stores/conversationStore'
import { useApprovals } from './stores/approvalStore'
import { useArtifactsStore, selectCurrentArtifacts } from './stores/artifactsStore'
import { ArtifactPanel } from './components/ArtifactPanel'
import type { SettingsSectionId } from './views/SettingsOverlay'
import type { TeamGraphNotification } from '../shared/protocol'

// Keys for persisting state
const SIDEBAR_STATE_KEY = 'ouroboros:sidebar-open'
const SIDEBAR_WIDTH_KEY = 'ouroboros:sidebar-width'
const ARTIFACT_PANEL_WIDTH_KEY = 'ouroboros:artifact-panel-width'
const ONBOARDING_DONE_KEY = 'ouroboros:onboarding-done'

const DEFAULT_SIDEBAR_WIDTH = 250
const MIN_SIDEBAR_WIDTH = 250
const MAX_SIDEBAR_WIDTH = 560

const DEFAULT_ARTIFACT_PANEL_WIDTH = 480
const MIN_ARTIFACT_PANEL_WIDTH = 280
const MAX_ARTIFACT_PANEL_WIDTH = 900

function clampSidebarWidth(width: number, viewportWidth: number): number {
  const maxAllowedWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - 320),
  )
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maxAllowedWidth)
}

function clampArtifactPanelWidth(width: number, viewportWidth: number): number {
  // Leave at least ~280px for the sidebar+chat columns combined when sidebar
  // is open; the main flex column can compress further if needed.
  const maxAllowed = Math.max(
    MIN_ARTIFACT_PANEL_WIDTH,
    Math.min(MAX_ARTIFACT_PANEL_WIDTH, viewportWidth - 280),
  )
  return Math.min(Math.max(width, MIN_ARTIFACT_PANEL_WIDTH), maxAllowed)
}

export function App(): React.ReactElement {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme()

  // Subscribe to CLI notifications so agent events reach the store
  useNotifications()
  useModeSync()

  // RSI state (serpent icon, drawer, crystallizations)
  const rsi = useRSI()

  // Approval state for badge count
  const pendingApprovals = useApprovals()

  // Onboarding state — show wizard on first launch
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return localStorage.getItem(ONBOARDING_DONE_KEY) !== 'true'
    } catch {
      return true
    }
  })

  // Sidebar open/closed state — initialize from localStorage
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STATE_KEY)
      return stored !== null ? stored === 'true' : true
    } catch {
      return true
    }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY)
      const parsed = stored ? Number.parseInt(stored, 10) : DEFAULT_SIDEBAR_WIDTH
      const initialWidth = Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH
      return clampSidebarWidth(initialWidth, window.innerWidth)
    } catch {
      return DEFAULT_SIDEBAR_WIDTH
    }
  })

  // Overlay states
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined)
  const [approvalQueueOpen, setApprovalQueueOpen] = useState(false)
  const [teamGraphOpen, setTeamGraphOpen] = useState(false)
  const [activeTeamGraphId, setActiveTeamGraphId] = useState<string | null>(null)
  const [activeTeamGraphSnapshot, setActiveTeamGraphSnapshot] = useState<
    TeamGraphNotification['graph'] | null
  >(null)

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const messages = useConversationStore((s) => s.messages)
  const pendingSubagentRuns = useConversationStore((s) => s.pendingSubagentRuns)
  const isAgentRunning = useConversationStore((s) => s.isAgentRunning)
  const setModelName = useConversationStore((s) => s.setModelName)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)
  const currentSessionId = useConversationStore((s) => s.currentSessionId)
  const currentArtifacts = useArtifactsStore(selectCurrentArtifacts)

  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(ARTIFACT_PANEL_WIDTH_KEY)
      const parsed = stored ? Number.parseInt(stored, 10) : DEFAULT_ARTIFACT_PANEL_WIDTH
      const initial = Number.isFinite(parsed) ? parsed : DEFAULT_ARTIFACT_PANEL_WIDTH
      return clampArtifactPanelWidth(initial, window.innerWidth)
    } catch {
      return DEFAULT_ARTIFACT_PANEL_WIDTH
    }
  })

  const [artifactFullscreen, setArtifactFullscreen] = useState(false)

  useEffect(() => {
    void useArtifactsStore.getState().setSession(currentSessionId)
  }, [currentSessionId])
  const hasSubagentActivity =
    pendingSubagentRuns.length > 0 ||
    messages.some((message) => message.role === 'agent' && (message.subagentRuns?.length ?? 0) > 0)
  const hasTeamGraphAffordance =
    Boolean(activeTeamGraphId) || Boolean(activeTeamGraphSnapshot) || hasSubagentActivity

  const handleOnboardingComplete = useCallback(
    (welcomeMessage: string, _template: number) => {
      localStorage.setItem(ONBOARDING_DONE_KEY, 'true')
      setShowOnboarding(false)

      // Re-fetch config to pick up the model name set during onboarding
      window.ouroboros
        ?.rpc('config/get', {})
        .then((result) => {
          const config = result as { model?: { name?: string } }
          if (config?.model?.name) setModelName(config.model.name)
        })
        .catch(() => {})

      // Add welcome message as a system message. Synthetic event — no
      // sessionId because it's locally generated, not from a CLI run.
      if (welcomeMessage) {
        useConversationStore
          .getState()
          .handleTurnComplete({ sessionId: null, text: welcomeMessage, iterations: 0 })
      }
    },
    [setModelName],
  )

  // Persist sidebar state
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, String(sidebarOpen))
    } catch {
      // ignore
    }
  }, [sidebarOpen])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // ignore
    }
  }, [sidebarWidth])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev)
  }, [])

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(clampSidebarWidth(width, window.innerWidth))
  }, [])

  const resizeArtifactPanel = useCallback((width: number) => {
    setArtifactPanelWidth(clampArtifactPanelWidth(width, window.innerWidth))
  }, [])

  const toggleArtifactFullscreen = useCallback(() => {
    setArtifactFullscreen((prev) => !prev)
  }, [])

  // Persist artifact panel width.
  useEffect(() => {
    try {
      localStorage.setItem(ARTIFACT_PANEL_WIDTH_KEY, String(artifactPanelWidth))
    } catch {
      // ignore
    }
  }, [artifactPanelWidth])

  // Auto-exit fullscreen when no artifact is available (session change, etc).
  useEffect(() => {
    if (artifactFullscreen && currentArtifacts.length === 0) {
      setArtifactFullscreen(false)
    }
  }, [artifactFullscreen, currentArtifacts.length])

  // ESC exits artifact fullscreen.
  useEffect(() => {
    if (!artifactFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setArtifactFullscreen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [artifactFullscreen])

  // Listen for sidebar toggle from menu accelerator (Cmd/Ctrl+B)
  useEffect(() => {
    const unsubscribe = window.electronAPI.toggleSidebar(() => {
      setSidebarOpen((prev) => !prev)
    })
    return unsubscribe
  }, [])

  // Global keyboard shortcuts: Cmd+K (palette), Cmd+, (settings)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen((prev) => !prev)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((prev) => clampSidebarWidth(prev, window.innerWidth))
      setArtifactPanelWidth((prev) => clampArtifactPanelWidth(prev, window.innerWidth))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
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

  // ---- Command palette overlay callbacks ------------------------------------

  const openSettings = useCallback((section?: SettingsSectionId) => {
    setCommandPaletteOpen(false)
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const openApprovalQueue = useCallback(() => {
    setCommandPaletteOpen(false)
    setApprovalQueueOpen(true)
  }, [])

  const openRSIDrawer = useCallback(() => {
    setCommandPaletteOpen(false)
    rsi.openDrawer()
  }, [rsi])

  const openTeamGraph = useCallback(() => {
    setCommandPaletteOpen(false)
    setTeamGraphOpen(true)
  }, [])

  useEffect(() => {
    const api = window.ouroboros
    if (!api?.onNotification) return
    const openUnsubscribe = api.onNotification(
      'team/graphOpen',
      (params: TeamGraphNotification) => {
        setActiveTeamGraphId(params.graph.id)
        setActiveTeamGraphSnapshot({ ...params.graph })
        setTeamGraphOpen(true)
      },
    )
    const updateUnsubscribe = api.onNotification(
      'team/graphUpdated',
      (params: TeamGraphNotification) => {
        setActiveTeamGraphId((current) => current ?? params.graph.id)
        setActiveTeamGraphSnapshot({ ...params.graph })
      },
    )
    return () => {
      openUnsubscribe()
      updateUnsubscribe()
    }
  }, [])

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
      const addFiles = (window as unknown as Record<string, unknown>).__inputBarAddFiles as
        | ((files: string[]) => void)
        | undefined
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

  // Show onboarding wizard on first launch
  if (showOnboarding) {
    return (
      <div style={styles.app}>
        <TitleBar
          resolvedTheme={resolvedTheme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={toggleSidebar}
          serpentState={rsi.serpentState}
          onSerpentClick={rsi.openDrawer}
          pendingApprovals={pendingApprovals.length}
          showTeamGraph={hasTeamGraphAffordance}
          onOpenTeamGraph={openTeamGraph}
        />
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      </div>
    )
  }

  const hasContent = messages.length > 0 || isAgentRunning

  return (
    <div style={styles.app}>
      <UpdateBanner />
      <TitleBar
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
        serpentState={rsi.serpentState}
        onSerpentClick={rsi.openDrawer}
        pendingApprovals={pendingApprovals.length}
        showTeamGraph={hasTeamGraphAffordance}
        onOpenTeamGraph={openTeamGraph}
      />
      <div
        style={{
          ...styles.body,
          ['--sidebar-width' as string]: `${sidebarWidth}px`,
        }}
      >
        {!artifactFullscreen && (
          <Sidebar
            isOpen={sidebarOpen}
            width={sidebarWidth}
            onResize={resizeSidebar}
            onOpenSettings={() => openSettings()}
          />
        )}
        {!artifactFullscreen && (
          <div
            style={styles.main}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {hasContent ? (
              <ChatView
                crystallizations={rsi.crystallizations}
                onDismissCrystallization={rsi.dismissCrystallization}
                onOpenTeamGraph={openTeamGraph}
              />
            ) : (
              <div style={styles.content}>
                <div style={styles.placeholder}>
                  <div style={styles.logoContainer}>
                    <OuroborosLogo />
                  </div>
                  <h1 style={styles.title}>Ouroboros</h1>
                  <p style={styles.subtitle}>Self-improving AI agent</p>
                </div>
              </div>
            )}
            <InputBar isDragOver={isDragOver} />
          </div>
        )}
        {currentArtifacts.length > 0 && (
          <ArtifactPanel
            width={artifactPanelWidth}
            onResize={resizeArtifactPanel}
            isFullscreen={artifactFullscreen}
            onToggleFullscreen={toggleArtifactFullscreen}
            minWidth={MIN_ARTIFACT_PANEL_WIDTH}
            maxWidth={MAX_ARTIFACT_PANEL_WIDTH}
          />
        )}
      </div>

      {/* Overlays & modals */}
      <ApprovalToastContainer />
      <AskUserDialog />
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onOpenSettings={openSettings}
        onOpenApprovals={openApprovalQueue}
        onOpenRSIDrawer={openRSIDrawer}
        onOpenTeamGraph={openTeamGraph}
      />
      <SettingsOverlay
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onSetTheme={setTheme}
        initialSection={settingsSection}
      />
      <ApprovalQueue isOpen={approvalQueueOpen} onClose={() => setApprovalQueueOpen(false)} />
      <TeamGraphDrawer
        isOpen={teamGraphOpen}
        onClose={() => setTeamGraphOpen(false)}
        graphId={activeTeamGraphId}
        graphSnapshot={activeTeamGraphSnapshot}
      />
      <RSIDrawer
        isOpen={rsi.drawerOpen}
        onClose={rsi.closeDrawer}
        activeTab={rsi.activeTab}
        onTabChange={rsi.setActiveTab}
        historyFilter={rsi.historyFilter}
        onHistoryFilterChange={rsi.setHistoryFilter}
        selectedHistoryItemId={rsi.selectedHistoryItemId}
        onSelectHistoryItem={rsi.selectHistoryItem}
        selectedHistoryItem={rsi.selectedHistoryItem}
        selectedCheckpoint={rsi.selectedCheckpoint}
        stats={rsi.stats}
        activities={rsi.overviewActivities}
        historyEntries={rsi.visibleHistoryEntries}
        skills={rsi.skills}
        loading={rsi.loading}
        historyDetailLoading={rsi.historyDetailLoading}
        dreamRunning={rsi.dreamRunning}
        onRunDream={rsi.runDream}
      />
    </div>
  )
}

function OuroborosLogo(): React.ReactElement {
  return (
    <OuroborosMark
      size={64}
      color='var(--text-secondary)'
      eyeColor='var(--bg-chat)'
      tileColor='var(--bg-chat)'
      borderColor='var(--border-light)'
      shadow={true}
    />
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
