import React from 'react'
import type { Message } from '../../shared/protocol'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useConversationStore } from '../stores/conversationStore'

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  padding: '0 16px',
}

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

const imageGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
  gap: 8,
  marginTop: 10,
  maxWidth: 360,
}

const imageAttachmentStyle: React.CSSProperties = {
  border: '1px solid var(--border-light)',
  borderRadius: 6,
  overflow: 'hidden',
  background: 'var(--bg-secondary)',
}

const imagePreviewStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  aspectRatio: '4 / 3',
  objectFit: 'cover',
}

const imageNameStyle: React.CSSProperties = {
  display: 'block',
  padding: '4px 6px',
  color: 'var(--text-secondary)',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserMessageProps {
  message: Message
}

const SteerMessage: React.FC<UserMessageProps> = ({ message }) => {
  const steerStatus = message.steerStatus
  const resendOrphan = useConversationStore((s) => s.resendOrphanedSteer)
  const dismissOrphan = useConversationStore((s) => s.dismissOrphanedSteer)

  const composedBubbleStyle: React.CSSProperties = {
    ...bubbleStyle,
    borderRight: '3px solid var(--accent-amber)',
    opacity: steerStatus === 'pending' ? 0.78 : 1,
  }

  return (
    <div style={wrapperStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div style={composedBubbleStyle}>
          <div style={steerCaptionStyle}>↳ {captionForSteerStatus(steerStatus)}</div>
          {looksLikeMarkdown(message.text) ? (
            <MarkdownRenderer content={message.text} />
          ) : (
            <div style={plainTextStyle}>{message.text}</div>
          )}
        </div>
        {steerStatus === 'orphaned' && message.steerRequestId && (
          <div style={orphanActionsStyle}>
            <span style={orphanHintStyle}>This steer didn&apos;t reach the agent.</span>
            <button
              style={orphanResendButtonStyle}
              onClick={() => resendOrphan(message.steerRequestId!)}
            >
              Send as new message
            </button>
            <button
              style={orphanDismissButtonStyle}
              onClick={() => dismissOrphan(message.steerRequestId!)}
            >
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export const UserMessage: React.FC<UserMessageProps> = ({ message }) => {
  if (message.kind === 'steer') {
    return <SteerMessage message={message} />
  }
  return (
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
        {message.imageAttachments && message.imageAttachments.length > 0 && (
          <div style={imageGridStyle}>
            {message.imageAttachments.map((image) => (
              <div key={image.path} style={imageAttachmentStyle}>
                {image.previewDataUrl ? (
                  <img src={image.previewDataUrl} alt={image.name} style={imagePreviewStyle} />
                ) : null}
                <span style={imageNameStyle} title={image.path}>
                  {image.name}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const steerCaptionStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--accent-amber)',
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  marginBottom: 6,
}

const orphanActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 6,
  fontSize: 12,
}

const orphanHintStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
}

const orphanResendButtonStyle: React.CSSProperties = {
  border: '1px solid var(--accent-amber)',
  background: 'transparent',
  color: 'var(--accent-amber)',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
}

const orphanDismissButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-tertiary)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '3px 6px',
}

function captionForSteerStatus(status: Message['steerStatus']): string {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'orphaned':
      return 'not steered'
    case 'injected':
    default:
      return 'steered'
  }
}

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
