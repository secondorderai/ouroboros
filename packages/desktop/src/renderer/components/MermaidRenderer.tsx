import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import mermaid from 'mermaid'

// ---------------------------------------------------------------------------
// Theme palettes passed into Mermaid's config
// ---------------------------------------------------------------------------

interface MermaidThemeVars {
  background: string
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  secondaryColor: string
  tertiaryColor: string
  fontSize: string
  fontFamily: string
}

const LIGHT_THEME: MermaidThemeVars = {
  background: 'transparent',
  primaryColor: '#F8FAFC',
  primaryTextColor: '#0E1116',
  primaryBorderColor: '#94A3B8',
  lineColor: '#64748B',
  secondaryColor: '#ECEEF0',
  tertiaryColor: '#F5F6F7',
  fontSize: '13px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
}

const DARK_THEME: MermaidThemeVars = {
  background: 'transparent',
  primaryColor: '#1E293B',
  primaryTextColor: '#E2E8F0',
  primaryBorderColor: '#475569',
  lineColor: '#94A3B8',
  secondaryColor: '#171C22',
  tertiaryColor: '#0F1317',
  fontSize: '13px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
}

// ---------------------------------------------------------------------------
// Global Mermaid initialisation — track last theme to re-init on switch
// ---------------------------------------------------------------------------

let currentTheme: 'light' | 'dark' | null = null

function ensureInit(theme: 'light' | 'dark') {
  if (currentTheme === theme) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
    securityLevel: 'loose',
    logLevel: 'error',
    flowchart: {
      htmlLabels: true,
      curve: 'basis',
      padding: 20,
      nodeSpacing: 20,
      rankSpacing: 30,
      wrappingWidth: 200,
    },
    sequence: {
      diagramMarginX: 30,
      diagramMarginY: 20,
      actorMargin: 40,
      messageMargin: 50,
      mirrorActors: false,
    },
    gantt: {
      leftPadding: 80,
      rightPadding: 20,
    },
  })
  currentTheme = theme
}

// ---------------------------------------------------------------------------
// Simple string hash for stable IDs + cache keys
// ---------------------------------------------------------------------------

function hashContent(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return `m-${Math.abs(hash).toString(36)}`
}

// ---------------------------------------------------------------------------
// SVG cache — keyed by content hash, survives across renders in session
// ---------------------------------------------------------------------------

const svgCache = new Map<string, string>()

// ---------------------------------------------------------------------------
// Debounce delay (ms) — wait for streaming to pause before rendering
// ---------------------------------------------------------------------------

const RENDER_DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------
// MermaidRenderer component
// ---------------------------------------------------------------------------

interface MermaidRendererProps {
  content: string
  isStreaming?: boolean
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({
  content,
  isStreaming = false,
}) => {
  const contentHash = hashContent(content)
  const expandedBodyRef = useRef<HTMLDivElement | null>(null)

  // Check cache on mount so already-rendered diagrams appear instantly
  const [svg, setSvg] = useState<string>(() => svgCache.get(contentHash) || '')
  const [error, setError] = useState<string>('')
  const [isExpanded, setIsExpanded] = useState(false)
  const [fitScale, setFitScale] = useState(1)
  const [expandedScale, setExpandedScale] = useState(1)
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit')
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<string>(content)
  const svgDimensions = useMemo(() => getSvgDimensions(svg), [svg])
  const scalePercent = Math.round(expandedScale * 100)

  // Keep a stable ref to the current content to avoid stale closures
  contentRef.current = content

  const renderDiagram = useCallback(async (source: string, streamingAttempt = false) => {
    try {
      const root = document.documentElement
      const theme = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
      ensureInit(theme)

      const id = hashContent(source)

      // Already cached — nothing to do
      if (svgCache.has(id)) return

      await mermaid.parse(source, { suppressErrors: false })

      const { svg: rendered } = await mermaid.render(id, source)
      const normalized = normalizeRenderedSvg(rendered)
      svgCache.set(id, normalized)

      // Only update state if the source is still current (debounce guard)
      if (contentRef.current === source) {
        setSvg(normalized)
        setError('')
      }
    } catch (err) {
      if (contentRef.current === source) {
        const msg = err instanceof Error ? err.message : 'Unknown rendering error'

        // Streamed Mermaid blocks are frequently incomplete for a short period
        // while the assistant is still emitting the fenced code block. Treat
        // parse failures during that phase as transient and keep the last good
        // SVG on screen instead of flashing an error box.
        if (streamingAttempt) {
          setError('')
          return
        }

        setError(msg)
        setSvg('')
      }
    }
  }, [])

  useEffect(() => {
    if (!content.trim()) return

    // Clear any pending debounce from a previous content change
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    const id = hashContent(content)

    // Cache hit — renderDiagram will early-return (cache guard above)
    // so skip the debounce entirely. Zero delay, zero flash.
    if (svgCache.has(id)) {
      const cached = svgCache.get(id)!
      // Only update if the cached SVG differs — avoids unnecessary re-renders
      setSvg((prev) => (prev === cached ? prev : cached))
      setError('')
      return
    }

    // Cache miss — debounce to batch streaming updates
    debounceTimerRef.current = setTimeout(
      () => {
        renderDiagram(content, isStreaming)
      },
      isStreaming ? 900 : RENDER_DEBOUNCE_MS,
    )

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [content, isStreaming, renderDiagram])

  useEffect(() => {
    if (!isExpanded) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsExpanded(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded])

  useEffect(() => {
    if (!isExpanded || !expandedBodyRef.current || !svgDimensions) {
      setFitScale(1)
      setExpandedScale(1)
      return
    }

    const body = expandedBodyRef.current

    const updateScale = () => {
      const widthRatio = body.clientWidth / svgDimensions.width
      const heightRatio = body.clientHeight / svgDimensions.height
      const nextScale = Math.min(Math.max(Math.min(widthRatio, heightRatio), 0.35), 2.75)
      const resolvedScale = Number.isFinite(nextScale) ? nextScale : 1
      setFitScale(resolvedScale)
      if (zoomMode === 'fit') {
        setExpandedScale(resolvedScale)
      }
    }

    updateScale()

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateScale()) : null

    observer?.observe(body)
    window.addEventListener('resize', updateScale)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateScale)
    }
  }, [isExpanded, svgDimensions, zoomMode])

  if (error) {
    return (
      <div className='mermaid-diagram mermaid-diagram--error'>
        <div className='mermaid-diagram__error'>
          <span className='mermaid-diagram__error-icon'>⚠</span>
          <span>Diagram failed to render</span>
        </div>
        <pre className='mermaid-diagram__source'>{content}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className='mermaid-diagram mermaid-diagram--loading'>
        <span className='mermaid-diagram__loading-text'>Rendering diagram…</span>
      </div>
    )
  }

  const openExpandedView = () => setIsExpanded(true)
  const closeExpandedView = () => {
    setIsExpanded(false)
    setZoomMode('fit')
  }
  const zoomIn = () => {
    setZoomMode('manual')
    setExpandedScale((prev) => Math.min(prev * 1.18, 4))
  }
  const zoomOut = () => {
    setZoomMode('manual')
    setExpandedScale((prev) => Math.max(prev / 1.18, 0.35))
  }
  const zoomToFit = () => {
    setZoomMode('fit')
    setExpandedScale(fitScale)
  }
  const zoomToActualSize = () => {
    setZoomMode('manual')
    setExpandedScale(1)
  }

  return (
    <>
      <div className='mermaid-diagram'>
        <div className='mermaid-diagram__toolbar'>
          <div className='mermaid-diagram__meta'>
            <span className='mermaid-diagram__badge'>Mermaid</span>
            <span className='mermaid-diagram__caption'>Interactive diagram preview</span>
          </div>
          <button
            type='button'
            className='mermaid-diagram__expand-button'
            onClick={openExpandedView}
            aria-label='Open full-size diagram'
          >
            <ExpandIcon />
            Expand
          </button>
        </div>
        <div
          className='mermaid-diagram__viewport'
          role='button'
          tabIndex={0}
          onClick={openExpandedView}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openExpandedView()
            }
          }}
          aria-label='Open full-size diagram'
        >
          <div className='mermaid-diagram__svg-shell' dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <div className='mermaid-diagram__footer'>
          <span className='mermaid-diagram__footer-text'>
            Click the preview to inspect the diagram in a larger, scrollable viewer.
          </span>
        </div>
      </div>

      {isExpanded && typeof document !== 'undefined'
        ? createPortal(
            <div className='mermaid-lightbox' onClick={closeExpandedView}>
              <div
                className='mermaid-lightbox__dialog'
                role='dialog'
                aria-modal='true'
                aria-label='Expanded Mermaid diagram'
                onClick={(event) => event.stopPropagation()}
              >
                <div className='mermaid-lightbox__header'>
                  <div className='mermaid-lightbox__title-group'>
                    <div className='mermaid-lightbox__eyebrow-row'>
                      <span className='mermaid-lightbox__eyebrow'>Mermaid Diagram</span>
                      <span className='mermaid-lightbox__scale'>{scalePercent}%</span>
                    </div>
                    <span className='mermaid-lightbox__title'>Diagram</span>
                    <span className='mermaid-lightbox__hint'>
                      Use the zoom controls or scroll to inspect the full layout comfortably.
                    </span>
                  </div>
                  <div className='mermaid-lightbox__actions'>
                    <button
                      type='button'
                      className='mermaid-lightbox__tool-button'
                      onClick={zoomOut}
                      aria-label='Zoom out'
                    >
                      <ZoomOutIcon />
                    </button>
                    <button
                      type='button'
                      className='mermaid-lightbox__text-button'
                      onClick={zoomToFit}
                    >
                      Fit
                    </button>
                    <button
                      type='button'
                      className='mermaid-lightbox__text-button'
                      onClick={zoomToActualSize}
                    >
                      100%
                    </button>
                    <button
                      type='button'
                      className='mermaid-lightbox__tool-button'
                      onClick={zoomIn}
                      aria-label='Zoom in'
                    >
                      <ZoomInIcon />
                    </button>
                    <button
                      type='button'
                      className='mermaid-lightbox__close-button'
                      onClick={closeExpandedView}
                      aria-label='Close expanded diagram'
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </div>
                <div className='mermaid-lightbox__body' ref={expandedBodyRef}>
                  <div
                    className='mermaid-lightbox__canvas'
                    style={
                      svgDimensions
                        ? {
                            width: `${svgDimensions.width * expandedScale}px`,
                            height: `${svgDimensions.height * expandedScale}px`,
                          }
                        : undefined
                    }
                  >
                    <div
                      className='mermaid-lightbox__diagram-frame'
                      style={
                        svgDimensions
                          ? {
                              width: `${svgDimensions.width}px`,
                              height: `${svgDimensions.height}px`,
                              transform: `scale(${expandedScale})`,
                            }
                          : undefined
                      }
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

MermaidRenderer.displayName = 'MermaidRenderer'

function normalizeRenderedSvg(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return svg
  }

  try {
    const parser = new DOMParser()
    const document = parser.parseFromString(svg, 'image/svg+xml')
    const root = document.documentElement

    if (!root || root.nodeName !== 'svg') {
      return svg
    }

    const currentClass = root.getAttribute('class')
    root.setAttribute(
      'class',
      currentClass ? `${currentClass} mermaid-diagram__svg` : 'mermaid-diagram__svg',
    )
    root.setAttribute('preserveAspectRatio', 'xMidYMin meet')
    root.setAttribute('role', 'img')
    root.setAttribute('focusable', 'false')

    const inlineStyle = root.getAttribute('style')?.trim()
    const additions = ['max-width: 100%', 'height: auto', 'overflow: visible']
    root.setAttribute(
      'style',
      inlineStyle ? `${inlineStyle}; ${additions.join('; ')}` : additions.join('; '),
    )

    return new XMLSerializer().serializeToString(root)
  } catch {
    return svg
  }
}

function getSvgDimensions(svg: string): { width: number; height: number } | null {
  if (!svg || typeof DOMParser === 'undefined') {
    return null
  }

  try {
    const parser = new DOMParser()
    const document = parser.parseFromString(svg, 'image/svg+xml')
    const root = document.documentElement

    if (!root || root.nodeName !== 'svg') {
      return null
    }

    const viewBox = root.getAttribute('viewBox')?.trim().split(/\s+/).map(Number)
    if (
      viewBox &&
      viewBox.length === 4 &&
      Number.isFinite(viewBox[2]) &&
      Number.isFinite(viewBox[3])
    ) {
      return { width: viewBox[2], height: viewBox[3] }
    }

    const width = parseSvgLength(root.getAttribute('width'))
    const height = parseSvgLength(root.getAttribute('height'))
    if (width && height) {
      return { width, height }
    }

    return null
  } catch {
    return null
  }
}

function parseSvgLength(value: string | null): number | null {
  if (!value) {
    return null
  }

  const match = value.match(/^\s*([0-9]*\.?[0-9]+)/)
  if (!match) {
    return null
  }

  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M18 6 6 18' />
      <path d='m6 6 12 12' />
    </svg>
  )
}

function ExpandIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M15 3h6v6' />
      <path d='M9 21H3v-6' />
      <path d='m21 3-7 7' />
      <path d='m3 21 7-7' />
    </svg>
  )
}

function ZoomInIcon(): React.ReactElement {
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
      aria-hidden='true'
    >
      <circle cx='11' cy='11' r='7' />
      <path d='M21 21l-4.35-4.35' />
      <path d='M11 8v6' />
      <path d='M8 11h6' />
    </svg>
  )
}

function ZoomOutIcon(): React.ReactElement {
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
      aria-hidden='true'
    >
      <circle cx='11' cy='11' r='7' />
      <path d='M21 21l-4.35-4.35' />
      <path d='M8 11h6' />
    </svg>
  )
}
