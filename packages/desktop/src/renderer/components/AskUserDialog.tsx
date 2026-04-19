import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  useActiveAskUserRequest,
  useAskUserActions,
} from '../stores/askUserStore'

export function AskUserDialog(): React.ReactElement | null {
  const request = useActiveAskUserRequest()
  const { respond } = useAskUserActions()
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setSelectedOption(null)
    setCustomText('')
    setSubmitting(false)
    setErrorMessage(null)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [request?.id])

  useEffect(() => {
    if (!request) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [request])

  const answer = useMemo(() => {
    const custom = customText.trim()
    return custom.length > 0 ? custom : selectedOption
  }, [customText, selectedOption])

  const handleSubmit = useCallback(async () => {
    if (!request || !answer || submitting) return

    setSubmitting(true)
    setErrorMessage(null)
    try {
      await respond(request.id, answer)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to submit response')
    } finally {
      setSubmitting(false)
    }
  }, [answer, request, respond, submitting])

  if (!request) return null

  return createPortal(
    <div style={styles.backdrop} role='presentation'>
      <div
        style={styles.panel}
        role='dialog'
        aria-modal='true'
        aria-labelledby='ask-user-title'
        aria-describedby='ask-user-question'
      >
        <div style={styles.header}>
          <h2 id='ask-user-title' style={styles.title}>
            Input Needed
          </h2>
        </div>

        <div style={styles.content}>
          <p id='ask-user-question' style={styles.question}>
            {request.question}
          </p>

          {request.options.length > 0 && (
            <div style={styles.options} role='radiogroup' aria-label='Answer options'>
              {request.options.map((option) => {
                const selected = selectedOption === option && customText.trim().length === 0
                return (
                  <button
                    key={option}
                    type='button'
                    role='radio'
                    aria-checked={selected}
                    disabled={submitting}
                    style={{
                      ...styles.optionButton,
                      ...(selected ? styles.optionButtonSelected : null),
                    }}
                    onClick={() => {
                      setSelectedOption(option)
                      setCustomText('')
                    }}
                  >
                    <span style={styles.optionRadio} aria-hidden='true'>
                      {selected ? <span style={styles.optionRadioDot} /> : null}
                    </span>
                    <span style={styles.optionText}>{option}</span>
                  </button>
                )
              })}
            </div>
          )}

          <label style={styles.customLabel} htmlFor='ask-user-custom-input'>
            Custom response
          </label>
          <input
            ref={inputRef}
            id='ask-user-custom-input'
            style={styles.customInput}
            value={customText}
            disabled={submitting}
            placeholder='Type your answer...'
            onChange={(event) => {
              setCustomText(event.target.value)
              if (event.target.value.trim().length > 0) {
                setSelectedOption(null)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSubmit()
              }
            }}
          />

          {errorMessage && <p style={styles.errorText}>{errorMessage}</p>}
        </div>

        <div style={styles.footer}>
          <button
            type='button'
            style={{
              ...styles.submitButton,
              ...(!answer || submitting ? styles.submitButtonDisabled : null),
            }}
            disabled={!answer || submitting}
            onClick={handleSubmit}
          >
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 980,
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
  content: {
    padding: 20,
    overflow: 'auto',
  },
  question: {
    margin: '0 0 18px',
    color: 'var(--text-primary)',
    fontSize: 15,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
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
    height: 40,
    borderRadius: 6,
    border: '1px solid var(--border-light)',
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    padding: '0 12px',
    font: 'inherit',
    lineHeight: 1.4,
  },
  errorText: {
    margin: '12px 0 0',
    color: 'var(--accent-red)',
    fontSize: 13,
    lineHeight: 1.4,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '14px 20px 18px',
    borderTop: '1px solid var(--border-light)',
  },
  submitButton: {
    minWidth: 92,
    height: 36,
    padding: '0 16px',
    border: 'none',
    borderRadius: 6,
    backgroundColor: 'var(--accent-amber)',
    color: 'var(--text-inverse)',
    fontSize: 13,
    fontWeight: 650,
    cursor: 'pointer',
  },
  submitButtonDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
}
