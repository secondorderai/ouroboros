import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConversationStore } from '../stores/conversationStore'

type Decision = 'approve' | 'reject' | 'custom'

export function PlanDecisionDialog(): React.ReactElement | null {
  const request = useConversationStore((state) => state.activePlanDecision)
  const respond = useConversationStore((state) => state.respondToPlanDecision)
  const dismiss = useConversationStore((state) => state.dismissPlanDecision)
  const [decision, setDecision] = useState<Decision>('approve')
  const [customText, setCustomText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDecision('approve')
    setCustomText('')
  }, [request?.plan.title])

  useEffect(() => {
    if ((decision === 'reject' || decision === 'custom') && request) {
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [decision, request])

  const needsText = decision === 'reject' || decision === 'custom'
  const canSubmit = useMemo(() => {
    return decision === 'approve' || customText.trim().length > 0
  }, [customText, decision])

  const submit = useCallback(() => {
    if (!canSubmit) return
    respond(decision, customText)
  }, [canSubmit, customText, decision, respond])

  if (!request) return null

  return createPortal(
    <div style={styles.backdrop} role='presentation'>
      <div
        style={styles.panel}
        role='dialog'
        aria-modal='true'
        aria-labelledby='plan-decision-title'
        aria-describedby='plan-decision-description'
      >
        <div style={styles.header}>
          <h2 id='plan-decision-title' style={styles.title}>
            Review Plan
          </h2>
          <button
            type='button'
            style={styles.closeButton}
            aria-label='Dismiss plan prompt'
            onClick={dismiss}
          >
            x
          </button>
        </div>

        <div style={styles.content}>
          <p id='plan-decision-description' style={styles.question}>
            {request.plan.title}
          </p>

          <div style={styles.options} role='radiogroup' aria-label='Plan decision'>
            <DecisionButton
              label='Approve'
              selected={decision === 'approve'}
              onClick={() => setDecision('approve')}
            />
            <DecisionButton
              label='Reject'
              selected={decision === 'reject'}
              onClick={() => setDecision('reject')}
            />
            <DecisionButton
              label='Custom response'
              selected={decision === 'custom'}
              onClick={() => setDecision('custom')}
            />
          </div>

          {needsText && (
            <>
              <label style={styles.customLabel} htmlFor='plan-decision-custom-input'>
                {decision === 'reject' ? 'Feedback' : 'Custom response'}
              </label>
              <textarea
                ref={inputRef}
                id='plan-decision-custom-input'
                style={styles.customInput}
                value={customText}
                placeholder={
                  decision === 'reject'
                    ? 'Describe what should change in the plan...'
                    : 'Type the response to send...'
                }
                onChange={(event) => setCustomText(event.target.value)}
              />
            </>
          )}
        </div>

        <div style={styles.footer}>
          <button
            type='button'
            style={{
              ...styles.submitButton,
              ...(!canSubmit ? styles.submitButtonDisabled : null),
            }}
            disabled={!canSubmit}
            onClick={submit}
          >
            Submit
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function DecisionButton({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      role='radio'
      aria-checked={selected}
      style={{
        ...styles.optionButton,
        ...(selected ? styles.optionButtonSelected : null),
      }}
      onClick={onClick}
    >
      <span style={styles.optionRadio} aria-hidden='true'>
        {selected ? <span style={styles.optionRadioDot} /> : null}
      </span>
      <span style={styles.optionText}>{label}</span>
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 970,
    backgroundColor: 'var(--bg-overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  panel: {
    width: 'min(100%, 520px)',
    maxHeight: 'min(680px, 86vh)',
    backgroundColor: 'var(--bg-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: 8,
    boxShadow: 'var(--shadow-xl)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '18px 20px 14px',
    borderBottom: '1px solid var(--border-light)',
  },
  title: {
    margin: 0,
    color: 'var(--text-primary)',
    fontSize: 16,
    fontWeight: 650,
    lineHeight: 1.3,
  },
  closeButton: {
    border: 'none',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 22,
    lineHeight: 1,
  },
  content: {
    padding: 20,
    overflow: 'auto',
  },
  question: {
    margin: '0 0 18px',
    color: 'var(--text-primary)',
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
  options: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 18,
  },
  optionButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 42,
    padding: '9px 12px',
    borderRadius: 6,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-chat)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  optionButtonSelected: {
    borderColor: 'var(--accent-amber)',
    backgroundColor: 'var(--accent-amber-bg)',
  },
  optionRadio: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '1px solid var(--border-medium)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optionRadioDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: 'var(--accent-amber)',
  },
  optionText: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  customLabel: {
    display: 'block',
    marginBottom: 6,
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1.3,
  },
  customInput: {
    width: '100%',
    minHeight: 96,
    resize: 'vertical',
    borderRadius: 6,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    padding: 12,
    font: 'inherit',
    lineHeight: 1.4,
  },
  footer: {
    padding: '14px 20px 18px',
    borderTop: '1px solid var(--border-light)',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  submitButton: {
    minWidth: 96,
    height: 38,
    borderRadius: 6,
    border: '1px solid var(--accent-amber)',
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    fontWeight: 650,
    cursor: 'pointer',
  },
  submitButtonDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
}
