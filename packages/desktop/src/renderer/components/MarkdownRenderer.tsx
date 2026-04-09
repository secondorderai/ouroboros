import React, { useCallback, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'

// ---------------------------------------------------------------------------
// Code block with copy button
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  className?: string
  children?: React.ReactNode
}

/**
 * Renders a fenced code block with syntax highlighting and a copy-to-clipboard
 * button. The language is extracted from the className set by react-markdown
 * (e.g., "language-typescript").
 */
function CodeBlock({ className, children }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Extract language from className like "language-typescript"
  const match = /language-(\w+)/.exec(className ?? '')
  const language = match ? match[1] : ''

  // Get the raw text content from the children
  const codeText = extractText(children)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [codeText])

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'text'}</span>
        <button
          className={`code-block-copy${copied ? ' copied' : ''}`}
          onClick={handleCopy}
          title="Copy code"
          aria-label="Copy code to clipboard"
        >
          {copied ? (
            <>
              <CheckIcon />
              Copied
            </>
          ) : (
            <>
              <CopyIcon />
              Copy
            </>
          )}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------

/**
 * Differentiates between inline code (`code`) and fenced code blocks.
 * react-markdown wraps both in <code>, but fenced blocks also get a <pre>
 * parent. We check for className (set by rehype-highlight for fenced blocks)
 * to decide which to render.
 */
function CodeComponent({
  className,
  children,
  node: _node,
  ...rest
}: {
  className?: string
  children?: React.ReactNode
  node?: unknown
  [key: string]: unknown
}): React.ReactElement {
  // If className contains "language-*" it's a fenced code block
  const isBlock = /language-/.test(className ?? '')

  if (isBlock) {
    return <CodeBlock className={className}>{children}</CodeBlock>
  }

  // Inline code
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  )
}

// ---------------------------------------------------------------------------
// Pre wrapper — we skip the default <pre> since CodeBlock handles it
// ---------------------------------------------------------------------------

function PreComponent({
  children,
}: {
  children?: React.ReactNode
  node?: unknown
}): React.ReactElement {
  // When the child is a CodeBlock (fenced code), just render the child directly
  // since CodeBlock already wraps in its own <pre>.
  return <>{children}</>
}

// ---------------------------------------------------------------------------
// Link — opens in external browser
// ---------------------------------------------------------------------------

function LinkComponent({
  href,
  children,
  node: _node,
  ...rest
}: {
  href?: string
  children?: React.ReactNode
  node?: unknown
  [key: string]: unknown
}): React.ReactElement {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (href && isSafeExternalHref(href)) {
        window.electronAPI.openExternal(href)
      }
    },
    [href]
  )

  return (
    <a href={href} onClick={handleClick} rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  )
}

function isSafeExternalHref(href: string): boolean {
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Custom components map
// ---------------------------------------------------------------------------

const markdownComponents: Components = {
  code: CodeComponent as Components['code'],
  pre: PreComponent as Components['pre'],
  a: LinkComponent as Components['a'],
}

// ---------------------------------------------------------------------------
// MarkdownRenderer
// ---------------------------------------------------------------------------

interface MarkdownRendererProps {
  content: string
}

/**
 * Renders markdown content with full GFM support, syntax highlighting, and
 * theme-aware styling. Wraps everything in a `.markdown-body` container so
 * CSS styles from markdown.css apply.
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({ content }) => {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    )
  }
)

MarkdownRenderer.displayName = 'MarkdownRenderer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively extract text content from React children. */
function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (children == null || typeof children === 'boolean') return ''
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (typeof children === 'object' && 'props' in children) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>
    return extractText(el.props.children)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function CopyIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
