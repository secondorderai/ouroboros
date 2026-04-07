import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useConversationStore } from '../stores/conversationStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionGroup = 'Actions' | 'Navigation' | 'Settings'

export interface PaletteAction {
  id: string
  group: ActionGroup
  icon: React.ReactNode
  title: string
  description: string
  shortcut?: string
  handler: () => void
}

// ---------------------------------------------------------------------------
// Icons (16px SVGs)
// ---------------------------------------------------------------------------

function PlusIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function MoonStarsIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      <line x1="17" y1="2" x2="17" y2="4" />
      <line x1="20" y1="5" x2="22" y2="5" />
    </svg>
  )
}

function FolderIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ZapIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function ClockIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function CheckSquareIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function CpuIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  )
}

function ShieldIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function KeyIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  )
}

function PaletteIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <line x1="21.17" y1="8" x2="12" y2="8" />
      <line x1="3.95" y1="6.06" x2="8.54" y2="14" />
      <line x1="10.88" y1="21.94" x2="15.46" y2="14" />
    </svg>
  )
}

function SearchIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Default actions
// ---------------------------------------------------------------------------

const GROUP_ORDER: ActionGroup[] = ['Actions', 'Navigation', 'Settings']

function createDefaultActions(handlers: {
  onNewConversation: () => void
  onTriggerDream: () => void
  onOpenWorkspace: () => void
  onBrowseSkills: () => void
  onViewEvolution: () => void
  onApprovalsQueue: () => void
  onChangeModel: () => void
  onConfigurePermissions: () => void
  onManageApiKeys: () => void
  onAppearance: () => void
}): PaletteAction[] {
  const isMac = navigator.userAgent.includes('Mac')
  const mod = isMac ? 'Cmd' : 'Ctrl'

  return [
    // Actions
    {
      id: 'new-conversation',
      group: 'Actions',
      icon: <PlusIcon />,
      title: 'New conversation',
      description: 'Start a fresh session',
      shortcut: `${mod}+N`,
      handler: handlers.onNewConversation,
    },
    {
      id: 'trigger-dream',
      group: 'Actions',
      icon: <MoonStarsIcon />,
      title: 'Trigger dream cycle',
      description: 'Run memory consolidation',
      handler: handlers.onTriggerDream,
    },
    {
      id: 'open-workspace',
      group: 'Actions',
      icon: <FolderIcon />,
      title: 'Open workspace folder',
      description: 'Change the working directory',
      handler: handlers.onOpenWorkspace,
    },

    // Navigation
    {
      id: 'browse-skills',
      group: 'Navigation',
      icon: <ZapIcon />,
      title: 'Browse skills',
      description: 'View installed skills',
      handler: handlers.onBrowseSkills,
    },
    {
      id: 'view-evolution',
      group: 'Navigation',
      icon: <ClockIcon />,
      title: 'View evolution log',
      description: 'Self-improvement history',
      handler: handlers.onViewEvolution,
    },
    {
      id: 'approvals-queue',
      group: 'Navigation',
      icon: <CheckSquareIcon />,
      title: 'Approvals queue',
      description: 'Pending approval requests',
      handler: handlers.onApprovalsQueue,
    },

    // Settings
    {
      id: 'change-model',
      group: 'Settings',
      icon: <CpuIcon />,
      title: 'Change model',
      description: 'Switch LLM provider or model',
      handler: handlers.onChangeModel,
    },
    {
      id: 'configure-permissions',
      group: 'Settings',
      icon: <ShieldIcon />,
      title: 'Configure permissions',
      description: 'Adjust safety tiers',
      handler: handlers.onConfigurePermissions,
    },
    {
      id: 'manage-api-keys',
      group: 'Settings',
      icon: <KeyIcon />,
      title: 'Manage API keys',
      description: 'Add or update API keys',
      handler: handlers.onManageApiKeys,
    },
    {
      id: 'appearance',
      group: 'Settings',
      icon: <PaletteIcon />,
      title: 'Appearance',
      description: 'Theme and font size',
      shortcut: `${mod}+,`,
      handler: handlers.onAppearance,
    },
  ]
}

// ---------------------------------------------------------------------------
// Fuse.js configuration
// ---------------------------------------------------------------------------

const fuseOptions = {
  keys: [
    { name: 'title', weight: 0.7 },
    { name: 'description', weight: 0.3 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
}

// ---------------------------------------------------------------------------
// CommandPalette component
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onOpenSettings?: (section?: string) => void
  onOpenApprovals?: () => void
  onOpenRSIDrawer?: () => void
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, onOpenSettings, onOpenApprovals, onOpenRSIDrawer }) => {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const resetConversation = useConversationStore((s) => s.resetConversation)

  // Action handlers
  const actions = useMemo(() => {
    return createDefaultActions({
      onNewConversation: () => {
        resetConversation()
        window.ouroboros?.rpc('session/new', {}).catch((err: unknown) => {
          console.error('session/new failed:', err)
        })
      },
      onTriggerDream: () => {
        window.ouroboros?.rpc('rsi/dream', {}).catch((err: unknown) => {
          console.error('rsi/dream failed:', err)
        })
      },
      onOpenWorkspace: () => {
        window.ouroboros?.showOpenDialog({
          title: 'Open Workspace Folder',
          properties: ['openDirectory'],
        }).then((dir) => {
          if (dir) {
            window.ouroboros?.rpc('workspace/set', { directory: dir }).catch((err: unknown) => {
              console.error('workspace/set failed:', err)
            })
          }
        })
      },
      onBrowseSkills: () => {
        if (onOpenRSIDrawer) onOpenRSIDrawer()
      },
      onViewEvolution: () => {
        if (onOpenRSIDrawer) onOpenRSIDrawer()
      },
      onApprovalsQueue: () => {
        if (onOpenApprovals) onOpenApprovals()
      },
      onChangeModel: () => {
        if (onOpenSettings) onOpenSettings('model')
      },
      onConfigurePermissions: () => {
        if (onOpenSettings) onOpenSettings('permissions')
      },
      onManageApiKeys: () => {
        if (onOpenSettings) onOpenSettings('model')
      },
      onAppearance: () => {
        if (onOpenSettings) onOpenSettings('appearance')
      },
    })
  }, [resetConversation])

  // Fuse.js index
  const fuse = useMemo(() => new Fuse(actions, fuseOptions), [actions])

  // Filtered results
  const filteredActions = useMemo(() => {
    if (!query.trim()) return actions
    return fuse.search(query).map((result) => result.item)
  }, [query, actions, fuse])

  // Group filtered actions
  const groupedActions = useMemo(() => {
    const groups: Array<{ group: ActionGroup; items: PaletteAction[] }> = []
    for (const group of GROUP_ORDER) {
      const items = filteredActions.filter((a) => a.group === group)
      if (items.length > 0) {
        groups.push({ group, items })
      }
    }
    return groups
  }, [filteredActions])

  // Flat list for keyboard navigation (excluding group headers)
  const flatItems = useMemo(
    () => groupedActions.flatMap((g) => g.items),
    [groupedActions]
  )

  // Animate close
  const handleClose = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      setQuery('')
      setSelectedIndex(0)
      onClose()
    }, 150)
  }, [onClose])

  // Execute action
  const executeAction = useCallback(
    (action: PaletteAction) => {
      handleClose()
      // Slight delay so palette closes before handler runs
      setTimeout(() => action.handler(), 160)
    },
    [handleClose]
  )

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setClosing(false)
      // Use a timeout to ensure the element is mounted
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const selected = listRef.current.querySelector('.command-palette-item.selected')
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % Math.max(flatItems.length, 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) =>
            prev <= 0 ? Math.max(flatItems.length - 1, 0) : prev - 1
          )
          break
        case 'Enter':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            executeAction(flatItems[selectedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          handleClose()
          break
      }
    },
    [flatItems, selectedIndex, executeAction, handleClose]
  )

  if (!isOpen) return null

  // Track the flat index as we render grouped items
  let flatIndex = 0

  return (
    <>
      {/* Backdrop */}
      <div
        className={`command-palette-backdrop${closing ? ' closing' : ''}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Palette */}
      <div
        className={`command-palette${closing ? ' closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="command-palette-input-wrapper">
          <span className="command-palette-search-icon">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            placeholder="Search actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="command-palette-divider" />

        {/* Action list */}
        <div className="command-palette-list" ref={listRef}>
          {groupedActions.length === 0 ? (
            <div className="command-palette-empty">No matching actions</div>
          ) : (
            groupedActions.map(({ group, items }) => (
              <div key={group}>
                <div className="command-palette-group-header">{group}</div>
                {items.map((action) => {
                  const currentFlatIndex = flatIndex++
                  return (
                    <div
                      key={action.id}
                      className={`command-palette-item${currentFlatIndex === selectedIndex ? ' selected' : ''}`}
                      onClick={() => executeAction(action)}
                      onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                      role="option"
                      aria-selected={currentFlatIndex === selectedIndex}
                    >
                      <span className="command-palette-item-icon">{action.icon}</span>
                      <div className="command-palette-item-content">
                        <span className="command-palette-item-title">{action.title}</span>
                        <span className="command-palette-item-description">
                          {action.description}
                        </span>
                      </div>
                      {action.shortcut && (
                        <span className="command-palette-item-shortcut">
                          {action.shortcut}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
