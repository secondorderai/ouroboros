/**
 * Step 1 — "Connect your AI"
 *
 * Provider selection (3 large cards), API key input, test connection,
 * model selector (after success), and help link.
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { AIProvider, AuthStatusResult, ConnectionTestResult } from '../../../shared/protocol'

// ── Provider card SVG icons ─────────────────────────────────

const AnthropicIcon = () => (
  <svg
    width='24'
    height='24'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.5'
  >
    <path d='M12 2L2 19h6l4-8 4 8h6L12 2z' />
  </svg>
)

const OpenAIIcon = () => (
  <svg
    width='24'
    height='24'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.5'
  >
    <circle cx='12' cy='12' r='9' />
    <path d='M8 12h8M12 8v8' />
    <circle cx='12' cy='12' r='3' />
  </svg>
)

const GenericAIIcon = () => (
  <svg
    width='24'
    height='24'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.5'
  >
    <rect x='3' y='3' width='18' height='18' rx='3' />
    <path d='M8 12h8M12 8v8' />
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
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '12px',
    marginBottom: '20px',
  } as React.CSSProperties,
  providerCard: {
    appearance: 'none',
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
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    textAlign: 'center',
  } as React.CSSProperties,
  providerCardSelected: {
    border: '2px solid var(--accent-primary)',
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
  'openai-chatgpt': 'https://chatgpt.com/pricing',
}

const DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.4',
  'openai-compatible': 'gpt-5.4',
  'openai-chatgpt': 'gpt-5.4',
}

// ── Component ───────────────────────────────────────────────

interface StepConnectAIProps {
  provider: AIProvider
  apiKey: string
  baseUrl: string
  model: string
  onProviderChange: (provider: AIProvider) => void
  onApiKeyChange: (key: string) => void
  onBaseUrlChange: (baseUrl: string) => void
  onModelChange: (model: string) => void
  onNext: () => void
}

export const StepConnectAI: React.FC<StepConnectAIProps> = ({
  provider,
  apiKey,
  baseUrl,
  model,
  onProviderChange,
  onApiKeyChange,
  onBaseUrlChange,
  onModelChange,
  onNext,
}) => {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [authStatus, setAuthStatus] = useState<AuthStatusResult | null>(null)
  const [inputFocused, setInputFocused] = useState(false)

  const isChatGPTProvider = provider === 'openai-chatgpt'
  const isOpenAICompatibleProvider = provider === 'openai-compatible'
  const hasRequiredApiConfig =
    apiKey.trim().length > 0 &&
    (!isOpenAICompatibleProvider || baseUrl.trim().length > 0)
  const canTest = isChatGPTProvider ? !testing : hasRequiredApiConfig
  const canProceed = isChatGPTProvider
    ? authStatus?.connected === true && model.trim().length > 0
    : hasRequiredApiConfig && testResult?.success === true && model.trim().length > 0

  const applyAvailableModels = useCallback(
    (models: string[]) => {
      setAvailableModels(models)
      if (models.length > 0 && !models.includes(model)) {
        onModelChange(models[0])
      }
    },
    [model, onModelChange],
  )

  const handleProviderChange = useCallback(
    (nextProvider: AIProvider) => {
      if (nextProvider === provider) return

      onProviderChange(nextProvider)
      onModelChange(DEFAULT_MODELS[nextProvider])
      setTestResult(null)
      setAvailableModels([])
      setAuthStatus(null)
    },
    [onModelChange, onProviderChange, provider],
  )

  const syncChatGPTStatus = useCallback(async () => {
    const status = await window.ouroboros.rpc('auth/getStatus', {
      provider: 'openai-chatgpt',
    })
    setAuthStatus(status)
    applyAvailableModels(status.models)
  }, [applyAvailableModels])

  useEffect(() => {
    if (!isChatGPTProvider) {
      setAuthStatus(null)
      setAvailableModels([])
      return
    }

    void syncChatGPTStatus().catch((error: unknown) => {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load ChatGPT auth status',
      })
    })
  }, [isChatGPTProvider, syncChatGPTStatus])

  const handleTestConnection = useCallback(async () => {
    if (!canTest || testing) return
    setTesting(true)
    setTestResult(null)

    try {
      const result: ConnectionTestResult = await window.ouroboros.rpc('config/testConnection', {
        provider,
        apiKey,
        ...(isOpenAICompatibleProvider ? { baseUrl } : {}),
      })

      setTestResult(result)
      if (result.success && result.models && result.models.length > 0) {
        applyAvailableModels(result.models)
      }
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      })
    } finally {
      setTesting(false)
    }
  }, [apiKey, applyAvailableModels, baseUrl, canTest, isOpenAICompatibleProvider, provider, testing])

  const handleChatGPTLogin = useCallback(async () => {
    if (testing) return

    setTesting(true)
    setTestResult(null)

    try {
      const flow = await window.ouroboros.rpc('auth/startLogin', {
        provider: 'openai-chatgpt',
        method: 'browser',
      })
      window.electronAPI.openExternal(flow.url)

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const poll = await window.ouroboros.rpc('auth/pollLogin', {
          provider: 'openai-chatgpt',
          flowId: flow.flowId,
        })
        setAuthStatus(poll)
        applyAvailableModels(poll.models)

        if (!poll.pending) {
          if (poll.success) {
            setTestResult({ success: true, models: poll.models })
          } else {
            setTestResult({
              success: false,
              error: poll.error ?? 'ChatGPT sign-in failed',
            })
          }
          break
        }
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'ChatGPT sign-in failed',
      })
    } finally {
      setTesting(false)
      void syncChatGPTStatus().catch(() => {})
    }
  }, [applyAvailableModels, syncChatGPTStatus, testing])

  const handleHelpClick = useCallback(() => {
    const url = PROVIDER_HELP_URLS[provider]
    window.electronAPI.openExternal(url)
  }, [provider])

  const providers: { id: AIProvider; label: string; icon: React.ReactNode }[] = [
    { id: 'anthropic', label: 'Anthropic', icon: <AnthropicIcon /> },
    { id: 'openai', label: 'OpenAI API', icon: <OpenAIIcon /> },
    { id: 'openai-chatgpt', label: 'ChatGPT Subscription', icon: <OpenAIIcon /> },
    { id: 'openai-compatible', label: 'OpenAI-compatible', icon: <GenericAIIcon /> },
  ]

  return (
    <div>
      <h2 style={styles.heading}>Connect your AI</h2>
      <p style={styles.subheading}>
        {isChatGPTProvider
          ? 'Sign in with ChatGPT Plus or Pro to use subscription-backed Codex models'
          : 'Enter your API key to get started'}
      </p>

      {/* Provider selector */}
      <div style={styles.providerGrid} role='radiogroup' aria-label='AI provider'>
        {providers.map((p) => (
          <button
            key={p.id}
            type='button'
            style={{
              ...styles.providerCard,
              ...(provider === p.id ? styles.providerCardSelected : {}),
            }}
            onClick={() => handleProviderChange(p.id)}
            role='radio'
            aria-checked={provider === p.id}
          >
            {p.icon}
            {p.label}
          </button>
        ))}
      </div>

      {!isChatGPTProvider && (
        <div style={styles.inputGroup}>
          <label style={styles.label} htmlFor='onboarding-api-key'>
            API Key
          </label>
          <input
            id='onboarding-api-key'
            type='password'
            value={apiKey}
            onChange={(e) => {
              onApiKeyChange(e.target.value)
              setTestResult(null)
            }}
            placeholder='sk-...'
            style={{
              ...styles.input,
              ...(inputFocused ? styles.inputFocused : {}),
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            autoComplete='off'
          />
        </div>
      )}

      {isOpenAICompatibleProvider && (
        <div style={styles.inputGroup}>
          <label style={styles.label} htmlFor='onboarding-base-url'>
            API Base URL
          </label>
          <input
            id='onboarding-base-url'
            type='url'
            value={baseUrl}
            onChange={(e) => {
              onBaseUrlChange(e.target.value)
              setTestResult(null)
            }}
            placeholder='http://localhost:11434/v1'
            style={styles.input}
            autoComplete='off'
          />
        </div>
      )}

      {/* Test connection */}
      <div style={styles.buttonRow}>
        <button
          style={{
            ...styles.testButton,
            ...(!canTest || testing ? styles.testButtonDisabled : {}),
          }}
          onClick={isChatGPTProvider ? handleChatGPTLogin : handleTestConnection}
          disabled={!canTest || testing}
        >
          {testing && <span style={styles.spinner} />}
          {testing
            ? isChatGPTProvider
              ? 'Waiting for sign-in...'
              : 'Testing...'
            : isChatGPTProvider
              ? authStatus?.connected
                ? 'Reconnect ChatGPT'
                : 'Sign in with ChatGPT'
              : 'Test Connection'}
        </button>
        {testResult && (
          <span
            style={{
              ...styles.statusText,
              ...(testResult.success ? styles.successText : styles.errorText),
            }}
          >
            {testResult.success
              ? isChatGPTProvider
                ? authStatus?.accountId
                  ? `Connected (${authStatus.accountId})`
                  : 'Connected'
                : 'Connected'
              : (testResult.error ?? 'Failed')}
          </span>
        )}
      </div>

      {/* Model input */}
      <div style={styles.inputGroup}>
        <label style={styles.label} htmlFor='onboarding-model'>
          Model
        </label>
        {isChatGPTProvider ? (
          <select
            id='onboarding-model'
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            style={styles.select}
          >
            {(availableModels.length > 0 ? availableModels : [DEFAULT_MODELS[provider]]).map(
              (modelOption) => (
                <option key={modelOption} value={modelOption}>
                  {modelOption}
                </option>
              ),
            )}
          </select>
        ) : (
          <input
            id='onboarding-model'
            type='text'
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={DEFAULT_MODELS[provider]}
            style={styles.input}
            autoComplete='off'
          />
        )}
      </div>

      {/* Help link */}
      <span
        style={styles.helpLink}
        onClick={handleHelpClick}
        role='link'
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleHelpClick()
        }}
      >
        {isChatGPTProvider ? 'Need ChatGPT Plus or Pro?' : "Don't have an API key?"}
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
