import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ModelSection } from '../components/settings/ModelSection'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { PermissionsSection } from '../components/settings/PermissionsSection'
import { RsiSection } from '../components/settings/RsiSection'
import { MemorySection } from '../components/settings/MemorySection'
import type { Theme, OuroborosConfig } from '../../shared/protocol'

interface SettingsOverlayProps {
  isOpen: boolean
  onClose: () => void
  theme: Theme
  onSetTheme: (theme: Theme) => void
  initialSection?: string
}

type SectionId = 'model' | 'appearance' | 'permissions' | 'rsi' | 'memory'

interface SectionDef {
  id: SectionId
  label: string
}

const SECTIONS: SectionDef[] = [
  { id: 'model', label: 'Model & API Keys' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'rsi', label: 'RSI Behavior' },
  { id: 'memory', label: 'Memory' },
]

export function SettingsOverlay({
  isOpen,
  onClose,
  theme,
  onSetTheme,
  initialSection,
}: SettingsOverlayProps): React.ReactElement | null {
  const [activeSection, setActiveSection] = useState<SectionId>('model')

  // Navigate to initial section when opening
  useEffect(() => {
    if (isOpen && initialSection) {
      const valid: SectionId[] = ['model', 'appearance', 'permissions', 'rsi', 'memory']
      if (valid.includes(initialSection as SectionId)) {
        setActiveSection(initialSection as SectionId)
      }
    }
  }, [isOpen, initialSection])
  const [config, setConfig] = useState<OuroborosConfig | null>(null)
  const [exiting, setExiting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Load config when overlay opens
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoadError(null)
    setSaveError(null)
    window.ouroboros
      .rpc('config/get')
      .then((result) => {
        if (!cancelled) {
          setConfig(result)
        }
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Failed to load settings'
        setLoadError(message)
        setConfig(null)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  const handleClose = useCallback(() => {
    setExiting(true)
    setTimeout(() => {
      setExiting(false)
      onClose()
    }, 150)
  }, [onClose])

  // Escape key closes the overlay
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleClose])

  const handleConfigChange = useCallback(
    async (path: string, value: unknown) => {
      if (!config) return

      const previousConfig = config
      setSaveError(null)
      setConfig(applyConfigChange(config, path, value))

      try {
        const savedConfig = await window.ouroboros.rpc('config/set', { path, value })
        setConfig(savedConfig)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save settings'
        setConfig(previousConfig)
        setSaveError(message)
      }
    },
    [config]
  )

  if (!isOpen && !exiting) return null

  return createPortal(
    <div
      style={styles.overlay}
      className={exiting ? 'settings-overlay-exit' : 'settings-overlay-enter'}
    >
      {/* Close button */}
      <button
        style={styles.closeButton}
        onClick={handleClose}
        aria-label="Close settings"
      >
        <CloseIcon />
      </button>

      <div style={styles.container}>
        {/* Section navigation */}
        <nav style={styles.nav}>
          <div style={styles.navHeader}>Settings</div>
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              style={{
                ...styles.navItem,
                ...(activeSection === section.id
                  ? styles.navItemActive
                  : {}),
              }}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        {/* Active section content */}
        <div style={styles.content}>
          {(loadError || saveError) && (
            <div style={styles.errorBanner}>
              {loadError ?? saveError}
            </div>
          )}
          {activeSection === 'model' && (
            <ModelSection
              config={config}
              onConfigChange={handleConfigChange}
            />
          )}
          {activeSection === 'appearance' && (
            <AppearanceSection
              theme={theme}
              onSetTheme={onSetTheme}
            />
          )}
          {activeSection === 'permissions' && (
            <PermissionsSection
              config={config}
              onConfigChange={handleConfigChange}
            />
          )}
          {activeSection === 'rsi' && (
            <RsiSection
              config={config}
              onConfigChange={handleConfigChange}
            />
          )}
          {activeSection === 'memory' && (
            <MemorySection
              config={config}
              onConfigChange={handleConfigChange}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function applyConfigChange(
  config: OuroborosConfig,
  path: string,
  value: unknown,
): OuroborosConfig {
  const next = structuredClone(config)

  if (path.startsWith('permissions.')) {
    const permissionKey = path.slice('permissions.'.length) as keyof OuroborosConfig['permissions']
    next.permissions[permissionKey] = Boolean(value)
    return next
  }

  switch (path) {
    case 'model.provider':
      next.model.provider = value as OuroborosConfig['model']['provider']
      return next
    case 'model.name':
      next.model.name = String(value)
      return next
    case 'model.baseUrl':
      if (typeof value === 'string' && value.length > 0) {
        next.model.baseUrl = value
      } else {
        delete next.model.baseUrl
      }
      return next
    case 'rsi.autoReflect':
      next.rsi.autoReflect = Boolean(value)
      return next
    case 'rsi.noveltyThreshold':
      next.rsi.noveltyThreshold = Number(value)
      return next
    case 'memory.consolidationSchedule':
      next.memory.consolidationSchedule =
        value as OuroborosConfig['memory']['consolidationSchedule']
      return next
    default:
      return config
  }
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 800,
    backgroundColor: 'var(--bg-primary)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    overflow: 'auto',
    paddingTop: 'var(--title-bar-height)',
  },
  closeButton: {
    position: 'fixed',
    top: 'calc(var(--title-bar-height) + 16px)',
    right: 16,
    zIndex: 810,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  container: {
    display: 'flex',
    width: '100%',
    maxWidth: 640,
    gap: 32,
    padding: '32px 16px 48px',
  },
  nav: {
    width: 160,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    position: 'sticky' as const,
    top: 'calc(var(--title-bar-height) + 32px)',
    alignSelf: 'flex-start',
  },
  navHeader: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-tertiary)',
    letterSpacing: '0.05em',
    padding: '8px 12px',
    marginBottom: 4,
  },
  navItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-secondary)',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    cursor: 'pointer',
  },
  navItemActive: {
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-hover)',
    fontWeight: 600,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  errorBanner: {
    marginBottom: 16,
    padding: '10px 12px',
    borderRadius: 'var(--radius-standard)',
    border: '1px solid rgba(220, 38, 38, 0.24)',
    backgroundColor: 'rgba(220, 38, 38, 0.08)',
    color: 'var(--accent-red)',
    fontSize: 13,
    lineHeight: 1.5,
  },
}
