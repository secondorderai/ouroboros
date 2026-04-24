import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachment, RejectedImageAttachment } from '../../shared/protocol'
import { useConversationStore } from '../stores/conversationStore'
import { getModeDisplayName, useModeStore } from '../stores/modeStore'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINE_HEIGHT = 24 // 15px font * 1.6 line-height
const MAX_LINES = 5
const MAX_HEIGHT = LINE_HEIGHT * MAX_LINES
const MIN_HEIGHT = LINE_HEIGHT
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const POTENTIAL_IMAGE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  'gif',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'heif',
])

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------

interface InputBarProps {
  /** Whether a drag is currently over the chat area (for drop zone visual). */
  isDragOver?: boolean
}

export function InputBar({ isDragOver }: InputBarProps): React.ReactElement {
  const [text, setText] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<string[]>([])
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)

  const isAgentRunning = useConversationStore((s) => s.isAgentRunning)
  const sendMessage = useConversationStore((s) => s.sendMessage)
  const cancelRun = useConversationStore((s) => s.cancelRun)
  const workspace = useConversationStore((s) => s.workspace)
  const modelName = useConversationStore((s) => s.modelName)
  const contextUsage = useConversationStore((s) => s.contextUsage)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)
  const modeState = useModeStore((s) => s.modeState)
  const modeBusy = useModeStore((s) => s.isHydrating || s.isMutating)
  const modeError = useModeStore((s) => s.error)
  const enterMode = useModeStore((s) => s.enterMode)
  const exitMode = useModeStore((s) => s.exitMode)
  const clearModeError = useModeStore((s) => s.clearError)

  const isEmpty =
    text.trim().length === 0 && attachedFiles.length === 0 && attachedImages.length === 0
  const activeModeLabel =
    modeState.status === 'active' ? getModeDisplayName(modeState.modeId) : null

  // ---- Auto-resize textarea ------------------------------------------------

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Reset to min to get accurate scrollHeight
    el.style.height = `${MIN_HEIGHT}px`
    const newHeight = Math.min(el.scrollHeight, MAX_HEIGHT)
    el.style.height = `${newHeight}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [text, adjustHeight])

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // ---- Handlers ------------------------------------------------------------

  const handleSend = useCallback(() => {
    if (isEmpty || isAgentRunning) return
    const trimmed = text.trim()
    if (!trimmed && attachedFiles.length === 0 && attachedImages.length === 0) return
    sendMessage(
      trimmed,
      attachedFiles.length > 0 ? attachedFiles : undefined,
      attachedImages.length > 0 ? attachedImages : undefined,
    )
    setText('')
    setAttachedFiles([])
    setAttachedImages([])
    setAttachmentError(null)
    // Reset textarea height and re-focus
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`
      textareaRef.current.focus()
    }
  }, [text, attachedFiles, attachedImages, isEmpty, isAgentRunning, sendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleStop = useCallback(() => {
    cancelRun()
  }, [cancelRun])

  const addAttachmentPaths = useCallback(async (paths: string[]) => {
    const api = window.ouroboros
    if (!api || paths.length === 0) return

    const imageCandidatePaths = paths.filter(isPotentialImagePath)
    const regularFilePaths = paths.filter((path) => !isPotentialImagePath(path))

    if (regularFilePaths.length > 0) {
      setAttachedFiles((prev) => mergeUniquePaths(prev, regularFilePaths))
    }

    if (imageCandidatePaths.length === 0) {
      setAttachmentError(null)
      return
    }

    const result = await api.validateImageAttachments(imageCandidatePaths)
    setAttachedImages((prev) => mergeUniqueImages(prev, result.accepted))
    setAttachmentError(formatAttachmentError(result.rejected))
  }, [])

  const handleAttach = useCallback(async () => {
    const api = window.ouroboros
    if (!api) return
    const result = await api.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result) {
      await addAttachmentPaths(Array.isArray(result) ? result : [result])
    }
  }, [addAttachmentPaths])

  const removeFile = useCallback((filePath: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f !== filePath))
  }, [])

  const removeImage = useCallback((filePath: string) => {
    setAttachedImages((prev) => prev.filter((image) => image.path !== filePath))
  }, [])

  const handleWorkspaceClick = useCallback(async () => {
    const api = window.ouroboros
    if (!api) return
    const result = await api.showOpenDialog({
      title: 'Select workspace folder',
      properties: ['openDirectory'],
    })
    if (result) {
      const dir = Array.isArray(result) ? result[0] : result
      if (dir) {
        setWorkspace(dir)
        api.rpc('workspace/set', { directory: dir }).catch((err) => {
          console.error('workspace/set failed:', err)
        })
      }
    }
  }, [setWorkspace])

  const handleModeChipClick = useCallback(() => {
    clearModeError()
    setModeMenuOpen((open) => !open)
  }, [clearModeError])

  const handleEnterPlanMode = useCallback(async () => {
    await enterMode('plan')
    setModeMenuOpen(false)
  }, [enterMode])

  const handleExitMode = useCallback(async () => {
    await exitMode()
    setModeMenuOpen(false)
  }, [exitMode])

  // ---- Handle file drops from parent (via props) ---------------------------

  const addDroppedFiles = useCallback(
    (files: string[]) => {
      void addAttachmentPaths(files)
    },
    [addAttachmentPaths],
  )

  // Expose addDroppedFiles via a ref on the component
  // We use a stable ref attached to window for the parent to call
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__inputBarAddFiles = addDroppedFiles
    return () => {
      delete (window as unknown as Record<string, unknown>).__inputBarAddFiles
    }
  }, [addDroppedFiles])

  useEffect(() => {
    if (!modeMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!modeMenuRef.current?.contains(event.target as Node)) {
        setModeMenuOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModeMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [modeMenuOpen])

  useEffect(() => {
    if (modeState.status === 'active') {
      setModeMenuOpen(false)
    }
  }, [modeState.status])

  const modeButtonLabel = useMemo(() => {
    if (modeBusy) return 'Mode: updating…'
    if (activeModeLabel) return `${activeModeLabel} mode active`
    return 'Open mode picker'
  }, [activeModeLabel, modeBusy])

  const contextUsageDisplay = useMemo(() => {
    if (!contextUsage) return null

    const tokenDisplay = `${formatTokenCount(contextUsage.estimatedTotalTokens)} / ${
      contextUsage.contextWindowTokens !== null
        ? formatTokenCount(contextUsage.contextWindowTokens)
        : 'unknown'
    }`
    const percentDisplay =
      contextUsage.usageRatio !== null
        ? `${(contextUsage.usageRatio * 100).toFixed(contextUsage.usageRatio >= 0.1 ? 0 : 1)}%`
        : null

    const breakdown = contextUsage.breakdown
    const sourceLabel = contextUsage.contextWindowSource
      ? `Context window source: ${contextUsage.contextWindowSource}`
      : null
    const breakdownLines = breakdown
      ? [
          `System prompt: ${breakdown.systemPromptTokens.toLocaleString()}`,
          `Tools catalog: ${breakdown.toolPromptTokens.toLocaleString()}`,
          `AGENTS.md: ${breakdown.agentsInstructionsTokens.toLocaleString()}`,
          `Memory: ${breakdown.memoryTokens.toLocaleString()}`,
          `Conversation: ${breakdown.conversationTokens.toLocaleString()}`,
          `Tool results: ${breakdown.toolResultTokens.toLocaleString()}`,
        ]
      : []

    const titleMain =
      contextUsage.contextWindowTokens !== null
        ? `${contextUsage.estimatedTotalTokens.toLocaleString()} of ${contextUsage.contextWindowTokens.toLocaleString()} context tokens in use${
            percentDisplay ? ` (${percentDisplay})` : ''
          }`
        : `${contextUsage.estimatedTotalTokens.toLocaleString()} estimated context tokens in use${
            percentDisplay ? ` (${percentDisplay})` : ''
          }`
    const title = [titleMain, sourceLabel, ...breakdownLines].filter(Boolean).join('\n')

    return {
      label: percentDisplay ? `${tokenDisplay} · ${percentDisplay}` : tokenDisplay,
      title,
      threshold: contextUsage.threshold,
    }
  }, [contextUsage])

  // ---- Render --------------------------------------------------------------

  const containerBorderStyle = isDragOver
    ? '2px dashed var(--accent-amber)'
    : '1px solid var(--border-light)'

  return (
    <div style={styles.container} className='no-select'>
      {/* File chips */}
      {(attachedImages.length > 0 || attachedFiles.length > 0) && (
        <div style={styles.fileChips}>
          {attachedImages.map((image) => (
            <ImageChip key={image.path} image={image} onRemove={removeImage} />
          ))}
          {attachedFiles.map((filePath) => (
            <FileChip key={filePath} filePath={filePath} onRemove={removeFile} />
          ))}
        </div>
      )}
      {attachmentError && <div style={styles.attachmentError}>{attachmentError}</div>}

      {/* Input area */}
      <div
        style={{
          ...styles.inputWrapper,
          border: containerBorderStyle,
        }}
      >
        <button
          style={styles.attachButton}
          onClick={handleAttach}
          title='Attach files'
          aria-label='Attach files'
        >
          <AttachIcon />
        </button>

        <textarea
          ref={textareaRef}
          style={styles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Message Ouroboros...'
          aria-label='Message input'
          rows={1}
          disabled={false}
        />

        {isAgentRunning ? (
          <button
            style={{ ...styles.sendButton, ...styles.stopButton }}
            onClick={handleStop}
            title='Stop agent'
            aria-label='Stop agent'
          >
            <StopIcon />
          </button>
        ) : (
          <button
            style={{
              ...styles.sendButton,
              opacity: isEmpty ? 0.4 : 1,
              cursor: isEmpty ? 'not-allowed' : 'pointer',
            }}
            onClick={handleSend}
            disabled={isEmpty}
            title='Send message'
            aria-label='Send message'
          >
            <SendIcon />
          </button>
        )}
      </div>

      {/* Bottom meta row: workspace indicator + model badge */}
      <div style={styles.metaRow}>
        <div style={styles.metaLeft}>
          <div style={styles.modeArea} ref={modeMenuRef}>
            {modeState.status === 'active' ? (
              <div style={styles.activeModeChip} aria-label={modeButtonLabel}>
                <span style={styles.activeModeLabel}>{activeModeLabel}</span>
                <button
                  style={styles.modeDismissButton}
                  onClick={() => void handleExitMode()}
                  aria-label={`Exit ${activeModeLabel} mode`}
                  title={`Exit ${activeModeLabel} mode`}
                  disabled={modeBusy}
                >
                  <XIcon />
                </button>
              </div>
            ) : (
              <>
                <button
                  style={styles.modeButton}
                  onClick={handleModeChipClick}
                  aria-label={modeButtonLabel}
                  aria-expanded={modeMenuOpen}
                  title='Switch mode'
                  disabled={modeBusy}
                >
                  <ModeIcon />
                  <span style={styles.modeButtonText}>Mode</span>
                  <ChevronIcon open={modeMenuOpen} />
                </button>
                {modeMenuOpen && (
                  <div style={styles.modeMenu} role='menu' aria-label='Mode picker'>
                    <button
                      style={styles.modeMenuItem}
                      onClick={() => void handleEnterPlanMode()}
                      role='menuitem'
                      disabled={modeBusy}
                    >
                      <span style={styles.modeMenuTitle}>Plan</span>
                      <span style={styles.modeMenuDescription}>
                        Start in a planning workflow before implementation.
                      </span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <button
            style={styles.workspaceButton}
            onClick={handleWorkspaceClick}
            title={workspace ?? 'Set workspace'}
            aria-label='Change workspace'
          >
            <FolderIcon />
            <span style={styles.workspacePath}>
              {workspace ? truncatePath(workspace) : 'No workspace'}
            </span>
          </button>
        </div>

        <div style={styles.metaRight}>
          {modeError && <span style={styles.modeErrorText}>{modeError}</span>}
          {contextUsageDisplay && (
            <span
              style={{
                ...styles.contextBadge,
                ...(contextUsageDisplay.threshold === 'warn'
                  ? styles.contextBadgeWarn
                  : contextUsageDisplay.threshold === 'flush' ||
                      contextUsageDisplay.threshold === 'compact'
                    ? styles.contextBadgeCritical
                    : undefined),
              }}
              title={contextUsageDisplay.title}
            >
              {contextUsageDisplay.label}
            </span>
          )}
          {modelName && <span style={styles.modelBadge}>{modelName}</span>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helper: truncate path for display
// ---------------------------------------------------------------------------

function truncatePath(fullPath: string): string {
  // Replace home dir with ~
  const home = fullPath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
  // If still long, show last 2 segments
  const segments = home.split('/')
  if (segments.length > 3) {
    return '.../' + segments.slice(-2).join('/')
  }
  return home
}

function mergeUniquePaths(existingPaths: string[], nextPaths: string[]): string[] {
  const seen = new Set(existingPaths)
  const merged = [...existingPaths]

  for (const path of nextPaths) {
    if (seen.has(path)) continue
    seen.add(path)
    merged.push(path)
  }

  return merged
}

function mergeUniqueImages(
  existingImages: ImageAttachment[],
  nextImages: ImageAttachment[],
): ImageAttachment[] {
  const seen = new Set(existingImages.map((image) => image.path))
  const merged = [...existingImages]

  for (const image of nextImages) {
    if (seen.has(image.path)) continue
    seen.add(image.path)
    merged.push(image)
  }

  return merged
}

function isPotentialImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? POTENTIAL_IMAGE_EXTENSIONS.has(ext) : false
}

function formatAttachmentError(rejected: RejectedImageAttachment[]): string | null {
  if (rejected.length === 0) return null
  const names = rejected.map((item) => item.path.split('/').pop() ?? item.path).join(', ')
  return `Could not attach ${names}. Supported image formats are JPG, PNG, and WebP.`
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toString()
}

// ---------------------------------------------------------------------------
// FileChip
// ---------------------------------------------------------------------------

function ImageChip({
  image,
  onRemove,
}: {
  image: ImageAttachment
  onRemove: (path: string) => void
}): React.ReactElement {
  return (
    <span style={styles.imageChip}>
      {image.previewDataUrl ? (
        <img src={image.previewDataUrl} alt='' style={styles.imageChipPreview} />
      ) : (
        <ImageIcon />
      )}
      <span style={styles.fileChipName} title={image.path}>
        {image.name}
      </span>
      <button
        style={styles.fileChipRemove}
        onClick={() => onRemove(image.path)}
        aria-label={`Remove ${image.name}`}
      >
        <XIcon />
      </button>
    </span>
  )
}

function FileChip({
  filePath,
  onRemove,
}: {
  filePath: string
  onRemove: (path: string) => void
}): React.ReactElement {
  const fileName = filePath.split('/').pop() ?? filePath
  return (
    <span style={styles.fileChip}>
      <FileIcon />
      <span style={styles.fileChipName} title={filePath}>
        {fileName}
      </span>
      <button
        style={styles.fileChipRemove}
        onClick={() => onRemove(filePath)}
        aria-label={`Remove ${fileName}`}
      >
        <XIcon />
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SendIcon(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <line x1='22' y1='2' x2='11' y2='13' />
      <polygon points='22 2 15 22 11 13 2 9 22 2' />
    </svg>
  )
}

function StopIcon(): React.ReactElement {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' fill='currentColor' stroke='none'>
      <rect x='4' y='4' width='16' height='16' rx='2' />
    </svg>
  )
}

function AttachIcon(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48' />
    </svg>
  )
}

function FolderIcon(): React.ReactElement {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' />
    </svg>
  )
}

function FileIcon(): React.ReactElement {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z' />
      <polyline points='14 2 14 8 20 8' />
    </svg>
  )
}

function ImageIcon(): React.ReactElement {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <rect x='3' y='3' width='18' height='18' rx='2' />
      <circle cx='8.5' cy='8.5' r='1.5' />
      <path d='M21 15l-5-5L5 21' />
    </svg>
  )
}

function XIcon(): React.ReactElement {
  return (
    <svg
      width='10'
      height='10'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <line x1='18' y1='6' x2='6' y2='18' />
      <line x1='6' y1='6' x2='18' y2='18' />
    </svg>
  )
}

function ModeIcon(): React.ReactElement {
  return (
    <svg
      width='12'
      height='12'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z' />
      <path d='M12 12l8-4.5' />
      <path d='M12 12v9' />
      <path d='M12 12L4 7.5' />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width='10'
      height='10'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      style={{
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <polyline points='6 9 12 15 18 9' />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderTop: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    padding: '8px 16px 6px',
    flexShrink: 0,
  },
  fileChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
    paddingLeft: 4,
  },
  fileChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    maxWidth: 200,
  },
  imageChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 8px 3px 4px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    maxWidth: 220,
  },
  imageChipPreview: {
    width: 22,
    height: 22,
    objectFit: 'cover',
    borderRadius: 4,
    border: '1px solid var(--border-light)',
    flexShrink: 0,
  },
  attachmentError: {
    color: 'var(--accent-red)',
    fontSize: 12,
    padding: '0 4px 8px',
  },
  fileChipName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 150,
  },
  fileChipRemove: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    padding: 0,
    borderRadius: 'var(--radius-micro)',
    flexShrink: 0,
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 4,
    backgroundColor: 'var(--bg-input)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-comfortable)',
    padding: '8px 12px 8px 10px',
    transition: 'border-color 0.15s ease',
  },
  attachButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--radius-standard)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    fontSize: 15,
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    lineHeight: '24px',
    color: 'var(--text-primary)',
    outline: 'none',
    resize: 'none',
    padding: 0,
    margin: 0,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    overflowY: 'hidden',
  },
  sendButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: 'none',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'opacity 0.15s ease, background-color 0.15s ease',
    marginBottom: -2,
  },
  stopButton: {
    backgroundColor: 'var(--accent-red)',
    opacity: 1,
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 4px 0',
    minHeight: 24,
    gap: 12,
  },
  metaLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  metaRight: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    minWidth: 0,
    flexShrink: 0,
  },
  modeArea: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  modeButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
    padding: '3px 8px',
    borderRadius: 999,
    cursor: 'pointer',
    minHeight: 24,
  },
  modeButtonText: {
    lineHeight: 1,
  },
  activeModeChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 24,
    padding: '3px 4px 3px 9px',
    borderRadius: 999,
    backgroundColor: 'var(--accent-amber-bg)',
    border: '1px solid color-mix(in srgb, var(--accent-amber) 24%, transparent)',
    color: 'var(--accent-amber)',
  },
  activeModeLabel: {
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1,
  },
  modeDismissButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    border: 'none',
    borderRadius: 999,
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: 0,
  },
  modeMenu: {
    position: 'absolute',
    left: 0,
    bottom: 'calc(100% + 8px)',
    width: 240,
    borderRadius: 14,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    boxShadow: 'var(--shadow-lg)',
    padding: 8,
    zIndex: 20,
  },
  modeMenuItem: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '10px 12px',
    border: 'none',
    borderRadius: 10,
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  modeMenuTitle: {
    fontSize: 12,
    fontWeight: 700,
  },
  modeMenuDescription: {
    fontSize: 11,
    lineHeight: 1.4,
    color: 'var(--text-tertiary)',
  },
  workspaceButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 'var(--radius-micro)',
    maxWidth: 220,
    minWidth: 0,
  },
  workspacePath: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  modeErrorText: {
    fontSize: 11,
    color: 'var(--accent-red)',
    maxWidth: 220,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  modelBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)',
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
  },
  contextBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    backgroundColor: 'color-mix(in srgb, var(--accent-blue) 8%, var(--bg-secondary))',
    border: '1px solid color-mix(in srgb, var(--accent-blue) 18%, var(--border-light))',
    borderRadius: 'var(--radius-standard)',
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
  },
  contextBadgeWarn: {
    backgroundColor: 'var(--accent-amber-bg)',
    border: '1px solid color-mix(in srgb, var(--accent-amber) 24%, transparent)',
    color: 'var(--accent-amber)',
  },
  contextBadgeCritical: {
    backgroundColor: 'color-mix(in srgb, var(--accent-red) 12%, var(--bg-secondary))',
    border: '1px solid color-mix(in srgb, var(--accent-red) 28%, transparent)',
    color: 'var(--accent-red)',
  },
}
