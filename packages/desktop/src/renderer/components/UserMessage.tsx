import React from 'react'
import type { Message } from '../../shared/protocol'
import { MarkdownRenderer } from './MarkdownRenderer'

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  padding: '0 16px',
};

const bubbleStyle: React.CSSProperties = {
  maxWidth: '80%',
  background: 'var(--bg-user-msg)',
  padding: '12px 16px',
  borderRadius: '16px 16px 4px 16px',
  color: 'var(--text-primary)',
  fontSize: 15,
  fontWeight: 400,
  lineHeight: 1.6,
  wordBreak: 'break-word',
}

const plainTextStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
}

const fileChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  background: 'var(--bg-tool-chip)',
  border: '1px solid var(--border-light)',
  borderRadius: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginTop: 8,
  marginRight: 6,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserMessageProps {
  message: Message
}

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => (
  <div style={wrapperStyle}>
    <div style={bubbleStyle}>
      {looksLikeMarkdown(message.text) ? (
        <MarkdownRenderer content={message.text} />
      ) : (
        <div style={plainTextStyle}>{message.text}</div>
      )}
      {message.files && message.files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {message.files.map((file, i) => (
            <span key={i} style={fileChipStyle}>
              {file.split('/').pop()}
            </span>
          ))}
        </div>
      )}
    </div>
  </div>
)

const markdownBlockPatterns = [
  /^#{1,6}\s/m,
  /^>\s/m,
  /^```[\s\S]*```$/m,
  /^~~~[\s\S]*~~~$/m,
  /^(?:-|\*|\+)\s/m,
  /^\d+\.\s/m,
  /^\|.+\|\s*$/m,
  /^\s*[-*]\s\[[ xX]\]\s/m,
  /^([-*_]){3,}\s*$/m,
]

const markdownInlinePatterns = [
  /`[^`\n]+`/,
  /\*\*[^*\n]+\*\*/,
  /(^|[\s(])_[^_\n]+_(?=[\s).,!?]|$)/,
  /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
]

function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  return (
    markdownBlockPatterns.some((pattern) => pattern.test(trimmed)) ||
    markdownInlinePatterns.some((pattern) => pattern.test(trimmed))
  )
}
