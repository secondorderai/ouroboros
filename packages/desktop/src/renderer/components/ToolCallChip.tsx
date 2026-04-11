/**
 * ToolCallChip — Displays tool call activity as a compact chip that expands
 * on click to reveal input/output details.
 *
 * Collapsed: icon + human-readable label + status indicator (spinner/check/X)
 * Expanded: header + duration, input section, output section
 */

import React, { useState, useMemo, useCallback } from 'react'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import type { ToolCallState } from '../../shared/protocol'
import './ToolCallChip.css'

// Register highlight.js languages for tool output syntax highlighting
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)

// ── Tool label & icon mapping ───────────────────────────────

interface ToolMeta {
  label: string
  icon: React.ReactNode
}

/** Terminal icon — for bash commands */
const TerminalIcon = () => (
  <svg viewBox="0 0 24 24">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

/** File icon — for file-read */
const FileIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
)

/** File-plus icon — for file-write */
const FilePlusIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
)

/** Pencil icon — for file-edit */
const PencilIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
)

/** Globe icon — for web-fetch */
const GlobeIcon = () => (
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
)

/** Search icon — for web-search */
const SearchIcon = () => (
  <svg viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

/** Brain icon — for memory */
const BrainIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M12 2a7 7 0 0 0-7 7c0 3 2 5.5 4 7l3 3 3-3c2-1.5 4-4 4-7a7 7 0 0 0-7-7z" />
    <path d="M12 2v20" />
    <path d="M8 8c2 1 4 1 6 0" />
    <path d="M7 12c2.5 1.5 5.5 1.5 8 0" />
  </svg>
)

/** Sparkle icon — for reflect */
const SparkleIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" />
  </svg>
)

/** Diamond icon — for crystallize */
const DiamondIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M6 3h12l4 7-10 12L2 10z" />
    <path d="M2 10h20" />
    <path d="M12 22L8 10l4-7 4 7-4 12z" />
  </svg>
)

/** Check-circle icon — for self-test */
const CheckCircleIcon = () => (
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" />
    <polyline points="9 12 11.5 14.5 16 10" />
  </svg>
)

/** Wand icon — for skill-gen */
const WandIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M15 4l-1.4 1.4L20.2 12l-6.6 6.6L15 20l8-8-8-8z" />
    <line x1="2" y1="22" x2="13" y2="11" />
    <line x1="6" y1="6" x2="6" y2="10" />
    <line x1="4" y1="8" x2="8" y2="8" />
  </svg>
)

/** Moon icon — for dream */
const MoonIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

/** Timeline icon — for evolution */
const TimelineIcon = () => (
  <svg viewBox="0 0 24 24">
    <line x1="12" y1="2" x2="12" y2="22" />
    <circle cx="12" cy="6" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="18" r="2" />
    <line x1="14" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="10" y2="12" />
    <line x1="14" y1="18" x2="20" y2="18" />
  </svg>
)

/** Wrench icon — fallback for unknown tools */
const WrenchIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)

/** Status: green checkmark */
const CheckIcon = () => (
  <svg viewBox="0 0 24 24">
    <polyline points="4 12 9 17 20 6" />
  </svg>
)

/** Status: red X */
const XIcon = () => (
  <svg viewBox="0 0 24 24">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ── Label/icon lookup table ─────────────────────────────────

const TOOL_META: Record<string, ToolMeta> = {
  bash: { label: 'Ran command', icon: <TerminalIcon /> },
  'file-read': { label: 'Read file', icon: <FileIcon /> },
  'file-write': { label: 'Created file', icon: <FilePlusIcon /> },
  'file-edit': { label: 'Edited file', icon: <PencilIcon /> },
  'web-fetch': { label: 'Fetched URL', icon: <GlobeIcon /> },
  'web-search': { label: 'Searched web', icon: <SearchIcon /> },
  memory: { label: 'Updated memory', icon: <BrainIcon /> },
  reflect: { label: 'Reflecting...', icon: <SparkleIcon /> },
  crystallize: { label: 'Crystallizing skill...', icon: <DiamondIcon /> },
  'self-test': { label: 'Running tests...', icon: <CheckCircleIcon /> },
  'skill-gen': { label: 'Generating skill...', icon: <WandIcon /> },
  dream: { label: 'Dreaming...', icon: <MoonIcon /> },
  evolution: { label: 'Logging evolution', icon: <TimelineIcon /> },
}

function getToolMeta(toolName: string): ToolMeta {
  return (
    TOOL_META[toolName] ?? {
      label: toolName,
      icon: <WrenchIcon />,
    }
  )
}

// ── Helpers ─────────────────────────────────────────────────

const TRUNCATION_LIMIT = 50

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function getOutputText(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/** Attempt to syntax-highlight code output using highlight.js */
function highlightCode(text: string, toolName: string): { html: string; highlighted: boolean } {
  try {
    // For JSON-like output, try json first
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      const result = hljs.highlight(text, { language: 'json', ignoreIllegals: true })
      return { html: result.value, highlighted: true }
    }
    // For bash tool, use bash highlighting
    if (toolName === 'bash') {
      const result = hljs.highlightAuto(text, ['bash', 'json', 'javascript', 'typescript'])
      if (result.relevance > 3) {
        return { html: result.value, highlighted: true }
      }
    }
    // For file-read/file-write/file-edit, auto-detect
    if (toolName.startsWith('file-')) {
      const result = hljs.highlightAuto(text)
      if (result.relevance > 3) {
        return { html: result.value, highlighted: true }
      }
    }
    // Fallback: auto-detect but only use if confidence is high enough
    const result = hljs.highlightAuto(text)
    if (result.relevance > 5) {
      return { html: result.value, highlighted: true }
    }
    return { html: text, highlighted: false }
  } catch {
    return { html: text, highlighted: false }
  }
}

function getInputDisplay(
  toolName: string,
  input: Record<string, unknown>,
): { type: 'code' | 'text'; content: string } {
  switch (toolName) {
    case 'bash':
      return {
        type: 'code',
        content: String(input.command ?? input.cmd ?? JSON.stringify(input)),
      }
    case 'file-read':
      return { type: 'text', content: String(input.path ?? input.file ?? '') }
    case 'file-write':
      return { type: 'text', content: String(input.path ?? input.file ?? '') }
    case 'file-edit':
      return { type: 'text', content: String(input.path ?? input.file ?? '') }
    case 'web-fetch':
      return { type: 'text', content: String(input.url ?? '') }
    case 'web-search':
      return { type: 'text', content: String(input.query ?? '') }
    default:
      return { type: 'code', content: JSON.stringify(input, null, 2) }
  }
}

// ── Component ───────────────────────────────────────────────

interface ToolCallChipProps {
  toolCall: ToolCallState
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

export const ToolCallChip: React.FC<ToolCallChipProps> = ({
  toolCall,
  expanded: expandedProp,
  onExpandedChange,
}) => {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [showAllOutput, setShowAllOutput] = useState(false)
  const expanded = expandedProp ?? internalExpanded

  const meta = useMemo(() => getToolMeta(toolCall.toolName), [toolCall.toolName])

  const inputDisplay = useMemo(
    () => getInputDisplay(toolCall.toolName, (toolCall.input ?? {}) as Record<string, unknown>),
    [toolCall.toolName, toolCall.input],
  )

  const outputText = useMemo(
    () => getOutputText(toolCall.error ?? toolCall.output),
    [toolCall.error, toolCall.output],
  )

  const outputLines = useMemo(() => outputText.split('\n'), [outputText])

  const isTruncated = outputLines.length > TRUNCATION_LIMIT && !showAllOutput

  const displayedOutput = useMemo(() => {
    if (isTruncated) {
      return outputLines.slice(0, TRUNCATION_LIMIT).join('\n')
    }
    return outputText
  }, [isTruncated, outputLines, outputText])

  const highlightedOutput = useMemo(() => {
    if (!displayedOutput || toolCall.status === 'error') return null
    return highlightCode(displayedOutput, toolCall.toolName)
  }, [displayedOutput, toolCall.toolName, toolCall.status])

  const toggleExpanded = useCallback(() => {
    const nextExpanded = !expanded
    if (expandedProp === undefined) {
      setInternalExpanded(nextExpanded)
    }
    onExpandedChange?.(nextExpanded)
  }, [expanded, expandedProp, onExpandedChange])

  const handleShowAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowAllOutput(true)
  }, [])

  // ── Status indicator ───────────────────────────────────

  const statusIndicator = useMemo(() => {
    switch (toolCall.status) {
      case 'running':
        return <div className="tool-chip__spinner" />
      case 'done':
        return (
          <span className="tool-chip__status tool-chip__status--success">
            <CheckIcon />
          </span>
        )
      case 'error':
        return (
          <span className="tool-chip__status tool-chip__status--failed">
            <XIcon />
          </span>
        )
    }
  }, [toolCall.status])

  // ── Collapsed view ─────────────────────────────────────

  if (!expanded) {
    return (
      <button
        className="tool-chip"
        onClick={toggleExpanded}
        type="button"
        aria-expanded={false}
        aria-label={`${meta.label} — click to expand`}
        data-testid="tool-chip-collapsed"
      >
        <span className="tool-chip__icon">{meta.icon}</span>
        <span>{meta.label}</span>
        {statusIndicator}
      </button>
    )
  }

  // ── Expanded view ──────────────────────────────────────

  return (
    <div className="tool-chip-expanded" aria-expanded={true} data-testid="tool-chip-expanded">
      <div className="tool-chip-expanded__inner">
        {/* Header — click to collapse */}
        <div
          className="tool-chip-expanded__header"
          onClick={toggleExpanded}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') toggleExpanded()
          }}
          aria-label={`${meta.label} — click to collapse`}
        >
          <span className="tool-chip__icon">{meta.icon}</span>
          <span>{meta.label}</span>
          {statusIndicator}
          {toolCall.durationMs != null && (
            <span className="tool-chip-expanded__duration">
              {formatDuration(toolCall.durationMs)}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="tool-chip-expanded__body" data-testid="tool-chip-expanded-body">
          {/* Input section */}
          <div className="tool-chip-expanded__section-label">Input</div>
          {inputDisplay.type === 'code' ? (
            <pre className="tool-chip-expanded__code">{inputDisplay.content}</pre>
          ) : (
            <div className="tool-chip-expanded__input-text">
              {inputDisplay.content}
            </div>
          )}

          {/* Output section */}
          {(toolCall.status === 'done' || toolCall.status === 'error') && (
            <>
              <div className="tool-chip-expanded__section-label">Output</div>
              {toolCall.status === 'error' ? (
                <pre className="tool-chip-expanded__error">
                  {outputText || 'Unknown error'}
                </pre>
              ) : (
                <>
                  {highlightedOutput?.highlighted ? (
                    <pre className="tool-chip-expanded__code hljs">
                      {/* highlight.js output is safe — it only produces span tags with class names
                          from its own grammar definitions, not from user input. The input is tool
                          output from the CLI child process, not user-supplied HTML. */}
                      <code dangerouslySetInnerHTML={{ __html: highlightedOutput.html }} />
                    </pre>
                  ) : (
                    <pre className="tool-chip-expanded__code">
                      {displayedOutput}
                    </pre>
                  )}
                  {isTruncated && (
                    <button
                      className="tool-chip-expanded__show-all"
                      onClick={handleShowAll}
                      type="button"
                    >
                      Show all ({outputLines.length} lines)
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ToolCallChip
