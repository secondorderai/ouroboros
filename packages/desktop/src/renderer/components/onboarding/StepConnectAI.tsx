/**
 * Step 1 — "Connect your AI"
 *
 * Provider selection (3 large cards), API key input, test connection,
 * model selector (after success), and help link.
 */

import React, { useState, useCallback } from 'react'
import type { AIProvider, ConnectionTestResult } from '../../../shared/protocol'

// ── Provider card SVG icons ─────────────────────────────────

const AnthropicIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 2L2 19h6l4-8 4 8h6L12 2z" />
  </svg>
)

const OpenAIIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8M12 8v8" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const GenericAIIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 12h8M12 8v8" />
  </svg>
)

// ── Styles ──────────────────────────────────────────────────

const styles = {
  heading: {
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  } as React.CSSProperties,
  subheading: {
    fontSize: '15px',
    color: 'var(--text-secondary)',
    marginBottom: '24px',
  } as React.CSSProperties,
  providerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '12px',
    marginBottom: '20px',
  } as React.CSSProperties,
  providerCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '8px',
    padding: '16px 12px',
    border: '2px solid var(--border-light)',
    borderRadius: '10px',
    background: 'var(--bg-secondary)',
    cursor: 'pointer',
    transition: 'border-color 200ms ease, background 200ms ease',
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  } as React.CSSProperties,
  providerCardSelected: {
    borderColor: 'var(--accent-primary)',
    background: 'var(--accent-muted)',
  } as React.CSSProperties,
  inputGroup: {
    marginBottom: '16px',
  } as React.CSSProperties,
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '6px',
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '10px 12px',
    fontSize: '14px',
    fontFamily: 'var(--font-mono)',
    border: '1px solid var(--border-light)',
    borderRadius: '8px',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    outline: 'none',
    transition: 'border-color 200ms ease',
  } as React.CSSProperties,
  inputFocused: {
    borderColor: 'var(--border-focus)',
  } as React.CSSProperties,
  buttonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '16px',
  } as React.CSSProperties,
  testButton: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-inverse)',
    background: 'var(--accent-primary)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 200ms ease, opacity 200ms ease',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties,
  testButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  } as React.CSSProperties,
  statusText: {
    fontSize: '13px',
    fontWeight: 500,
  } as React.CSSProperties,
  successText: {
    color: 'var(--text-success)',
  } as React.CSSProperties,
  errorText: {
    color: 'var(--text-error)',
  } as React.CSSProperties,
  select: {
    width: '100%',
    padding: '10px 12px',
    fontSize: '14px',
    border: '1px solid var(--border-light)',
    borderRadius: '8px',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    outline: 'none',
    cursor: 'pointer',
  } as React.CSSProperties,
  helpLink: {
    display: 'inline-block',
    fontSize: '13px',
    color: 'var(--text-link)',
    textDecoration: 'none',
    cursor: 'pointer',
    marginTop: '4px',
  } as React.CSSProperties,
  nextButton: {
    width: '100%',
    padding: '12px',
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--text-inverse)',
    background: 'var(--accent-primary)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 200ms ease, opacity 200ms ease',
    marginTop: '20px',
  } as React.CSSProperties,
  nextButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  } as React.CSSProperties,
  spinner: {
    display: 'inline-block',
    width: '14px',
    height: '14px',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'tool-chip-spin 0.6s linear infinite',
  } as React.CSSProperties,
}

// ── Provider help URLs ──────────────────────────────────────

const PROVIDER_HELP_URLS: Record<AIProvider, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  'openai-compatible': 'https://platform.openai.com/api-keys',
}

// ── Component ───────────────────────────────────────────────

interface StepConnectAIProps {
  provider: AIProvider
  apiKey: string
  model: string
  onProviderChange: (provider: AIProvider) => void
  onApiKeyChange: (key: string) => void
  onModelChange: (model: string) => void
  onNext: () => void
}

export const StepConnectAI: React.FC<StepConnectAIProps> = ({
  provider,
  apiKey,
  model,
  onProviderChange,
  onApiKeyChange,
  onModelChange,
  onNext,
}) => {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [inputFocused, setInputFocused] = useState(false)

  const canTest = apiKey.trim().length > 0
  const canProceed = testResult?.success === true && model.length > 0

  const handleTestConnection = useCallback(async () => {
    if (!canTest || testing) return
    setTesting(true)
    setTestResult(null)

    try {
      const result = (await window.ouroboros.rpc('config/testConnection', {
        provider,
        apiKey,
      })) as ConnectionTestResult

      setTestResult(result)
      if (result.success && result.models && result.models.length > 0) {
        setAvailableModels(result.models)
        // Auto-select first model if none selected
        if (!model) {
          onModelChange(result.models[0])
        }
      }
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      })
    } finally {
      setTesting(false)
    }
  }, [canTest, testing, provider, apiKey, model, onModelChange])

  const handleHelpClick = useCallback(() => {
    const url = PROVIDER_HELP_URLS[provider]
    window.electronAPI.openExternal(url)
  }, [provider])

  const providers: { id: AIProvider; label: string; icon: React.ReactNode }[] = [
    { id: 'anthropic', label: 'Anthropic', icon: <AnthropicIcon /> },
    { id: 'openai', label: 'OpenAI', icon: <OpenAIIcon /> },
    { id: 'openai-compatible', label: 'OpenAI-compatible', icon: <GenericAIIcon /> },
  ]

  return (
    <div>
      <h2 style={styles.heading}>Connect your AI</h2>
      <p style={styles.subheading}>Enter your API key to get started</p>

      {/* Provider selector */}
      <div style={styles.providerGrid}>
        {providers.map((p) => (
          <div
            key={p.id}
            style={{
              ...styles.providerCard,
              ...(provider === p.id ? styles.providerCardSelected : {}),
            }}
            onClick={() => {
              onProviderChange(p.id)
              setTestResult(null)
              setAvailableModels([])
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onProviderChange(p.id)
                setTestResult(null)
                setAvailableModels([])
              }
            }}
            aria-pressed={provider === p.id}
          >
            {p.icon}
            {p.label}
          </div>
        ))}
      </div>

      {/* API key input */}
      <div style={styles.inputGroup}>
        <label style={styles.label}>API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            onApiKeyChange(e.target.value)
            setTestResult(null)
          }}
          placeholder="sk-..."
          style={{
            ...styles.input,
            ...(inputFocused ? styles.inputFocused : {}),
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          autoComplete="off"
        />
      </div>

      {/* Test connection */}
      <div style={styles.buttonRow}>
        <button
          style={{
            ...styles.testButton,
            ...(!canTest || testing ? styles.testButtonDisabled : {}),
          }}
          onClick={handleTestConnection}
          disabled={!canTest || testing}
        >
          {testing && <span style={styles.spinner} />}
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        {testResult && (
          <span
            style={{
              ...styles.statusText,
              ...(testResult.success ? styles.successText : styles.errorText),
            }}
          >
            {testResult.success ? 'Connected' : testResult.error ?? 'Failed'}
          </span>
        )}
      </div>

      {/* Model selector (only after successful test) */}
      {testResult?.success && availableModels.length > 0 && (
        <div style={styles.inputGroup}>
          <label style={styles.label}>Model</label>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            style={styles.select}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Help link */}
      <span
        style={styles.helpLink}
        onClick={handleHelpClick}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleHelpClick()
        }}
      >
        Don't have an API key?
      </span>

      {/* Next button */}
      <button
        style={{
          ...styles.nextButton,
          ...(!canProceed ? styles.nextButtonDisabled : {}),
        }}
        onClick={canProceed ? onNext : undefined}
        disabled={!canProceed}
      >
        Next
      </button>
    </div>
  )
}

export default StepConnectAI
