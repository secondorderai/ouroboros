import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationStore } from '../stores/conversationStore'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINE_HEIGHT = 24 // 15px font * 1.6 line-height
const MAX_LINES = 5
const MAX_HEIGHT = LINE_HEIGHT * MAX_LINES
const MIN_HEIGHT = LINE_HEIGHT

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isAgentRunning = useConversationStore((s) => s.isAgentRunning)
  const sendMessage = useConversationStore((s) => s.sendMessage)
  const cancelRun = useConversationStore((s) => s.cancelRun)
  const workspace = useConversationStore((s) => s.workspace)
  const modelName = useConversationStore((s) => s.modelName)
  const setWorkspace = useConversationStore((s) => s.setWorkspace)

  const isEmpty = text.trim().length === 0 && attachedFiles.length === 0

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
    if (!trimmed && attachedFiles.length === 0) return
    sendMessage(trimmed, attachedFiles.length > 0 ? attachedFiles : undefined)
    setText('')
    setAttachedFiles([])
    // Reset textarea height and re-focus
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`
      textareaRef.current.focus()
    }
  }, [text, attachedFiles, isEmpty, isAgentRunning, sendMessage])

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

  const handleAttach = useCallback(async () => {
    const api = window.ouroboros
    if (!api) return
    const result = await api.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result) {
      setAttachedFiles((prev) => {
        // result can be a single path; normalize
        const paths = Array.isArray(result) ? result : [result]
        return mergeUniquePaths(prev, paths)
      })
    }
  }, [])

  const removeFile = useCallback((filePath: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f !== filePath))
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

  // ---- Handle file drops from parent (via props) ---------------------------

  const addDroppedFiles = useCallback((files: string[]) => {
    setAttachedFiles((prev) => mergeUniquePaths(prev, files))
  }, [])

  // Expose addDroppedFiles via a ref on the component
  // We use a stable ref attached to window for the parent to call
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__inputBarAddFiles = addDroppedFiles
    return () => {
      delete (window as unknown as Record<string, unknown>).__inputBarAddFiles
    }
  }, [addDroppedFiles])

  // ---- Render --------------------------------------------------------------

  const containerBorderStyle = isDragOver
    ? '2px dashed var(--accent-amber)'
    : '1px solid var(--border-light)'

  return (
    <div style={styles.container} className="no-select">
      {/* File chips */}
      {attachedFiles.length > 0 && (
        <div style={styles.fileChips}>
          {attachedFiles.map((filePath) => (
            <FileChip key={filePath} filePath={filePath} onRemove={removeFile} />
          ))}
        </div>
      )}

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
          title="Attach files"
          aria-label="Attach files"
        >
          <AttachIcon />
        </button>

        <textarea
          ref={textareaRef}
          style={styles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Ouroboros..."
          aria-label="Message input"
          rows={1}
          disabled={false}
        />

        {isAgentRunning ? (
          <button
            style={{ ...styles.sendButton, ...styles.stopButton }}
            onClick={handleStop}
            title="Stop agent"
            aria-label="Stop agent"
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
            title="Send message"
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>

      {/* Bottom meta row: workspace indicator + model badge */}
      <div style={styles.metaRow}>
        <button
          style={styles.workspaceButton}
          onClick={handleWorkspaceClick}
          title={workspace ?? 'Set workspace'}
          aria-label="Change workspace"
        >
          <FolderIcon />
          <span style={styles.workspacePath}>
            {workspace ? truncatePath(workspace) : 'No workspace'}
          </span>
        </button>

        {modelName && (
          <span style={styles.modelBadge}>{modelName}</span>
        )}
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

// ---------------------------------------------------------------------------
// FileChip
// ---------------------------------------------------------------------------

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
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function StopIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}

function AttachIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function FolderIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  )
}

function FileIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function XIcon(): React.ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
  },
  workspacePath: {
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
}
