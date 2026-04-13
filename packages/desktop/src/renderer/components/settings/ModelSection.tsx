import React, { useState, useCallback, useEffect } from 'react'
import type {
  AuthStatusResult,
  ConnectionTestResult,
  OuroborosConfig,
} from '../../../shared/protocol'

interface ModelSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

type Provider = 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt'

const PROVIDERS: Array<{ value: Provider; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-chatgpt', label: 'ChatGPT Subscription' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
]

export function ModelSection({
  config,
  onConfigChange,
}: ModelSectionProps): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [savingApiKey, setSavingApiKey] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  const [testing, setTesting] = useState(false)
  const [authStatus, setAuthStatus] = useState<AuthStatusResult | null>(null)

  const provider = config?.model?.provider ?? 'anthropic'
  const modelName = config?.model?.name ?? ''
  const baseUrl = config?.model?.baseUrl ?? ''
  const isChatGPTProvider = provider === 'openai-chatgpt'

  const loadAuthStatus = useCallback(async () => {
    if (provider !== 'openai-chatgpt') {
      setAuthStatus(null)
      return
    }

    const status = await window.ouroboros.rpc('auth/getStatus', {
      provider: 'openai-chatgpt',
    })
    setAuthStatus(status)
  }, [provider])

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextProvider = e.target.value as Provider
      onConfigChange('model.provider', nextProvider)
      if (nextProvider === 'openai-chatgpt') {
        onConfigChange('model.name', 'gpt-5.4')
      }
    },
    [onConfigChange]
  )

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      onConfigChange('model.name', e.target.value)
    },
    [onConfigChange]
  )

  const handleBaseUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setTestResult(null)
      onConfigChange('model.baseUrl', e.target.value)
    },
    [onConfigChange]
  )

  const handleApiKeyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setApiKey(e.target.value)
      setApiKeyError(null)
      setTestResult(null)
    },
    []
  )

  const handleApiKeyBlur = useCallback(async () => {
    if (!apiKey) return

    setSavingApiKey(true)
    setApiKeyError(null)
    try {
      await window.ouroboros.rpc('config/setApiKey', { provider, apiKey })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save API key'
      setApiKeyError(message)
    } finally {
      setSavingApiKey(false)
    }
  }, [apiKey, provider])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result: ConnectionTestResult = await window.ouroboros.rpc('config/testConnection', {
        provider,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      })
      if (result.success) {
        setTestResult({ success: true, message: 'Connection successful' })
      } else {
        setTestResult({
          success: false,
          message: result.error ?? 'Connection failed',
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      setTestResult({ success: false, message })
    } finally {
      setTesting(false)
    }
  }, [apiKey, baseUrl, provider])

  const handleChatGPTLogin = useCallback(async () => {
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
        if (!poll.pending) {
          if (poll.success) {
            setTestResult({ success: true, message: 'Connected to ChatGPT subscription' })
            if (!poll.models.includes(modelName)) {
              onConfigChange('model.name', poll.models[0] ?? 'gpt-5.4')
            }
          } else {
            setTestResult({
              success: false,
              message: poll.error ?? 'ChatGPT sign-in failed',
            })
          }
          break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ChatGPT sign-in failed'
      setTestResult({ success: false, message })
    } finally {
      setTesting(false)
      void loadAuthStatus().catch(() => {})
    }
  }, [loadAuthStatus, modelName, onConfigChange])

  const handleChatGPTLogout = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await window.ouroboros.rpc('auth/logout', { provider: 'openai-chatgpt' })
      setAuthStatus({
        provider: 'openai-chatgpt',
        connected: false,
        authType: null,
        pending: false,
        availableMethods: ['browser', 'headless'],
        models: ['gpt-5.4'],
      })
      setTestResult({ success: true, message: 'Disconnected from ChatGPT subscription' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sign out'
      setTestResult({ success: false, message })
    } finally {
      setTesting(false)
    }
  }, [])

  // Reset test result when provider changes
  useEffect(() => {
    setTestResult(null)
  }, [provider])

  useEffect(() => {
    void loadAuthStatus().catch(() => {})
  }, [loadAuthStatus])

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Model & API Keys</h3>
      <p style={styles.sectionDescription}>
        Configure your LLM provider, authentication, and model selection.
      </p>

      {/* Provider selector */}
      <div style={styles.field}>
        <label style={styles.label}>Provider</label>
        <select
          style={styles.select}
          value={provider}
          onChange={handleProviderChange}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {!isChatGPTProvider && (
        <div style={styles.field}>
          <label style={styles.label}>API Key</label>
          <div style={styles.inputRow}>
            <input
              type={showKey ? 'text' : 'password'}
              style={styles.input}
              placeholder="Enter your API key..."
              value={apiKey}
              onChange={handleApiKeyChange}
              onBlur={handleApiKeyBlur}
            />
            <button
              style={styles.toggleButton}
              onClick={() => setShowKey((prev) => !prev)}
              type="button"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          {apiKeyError && <div style={styles.errorText}>{apiKeyError}</div>}
          {savingApiKey && <div style={styles.helperText}>Saving API key...</div>}
        </div>
      )}

      {provider === 'openai-compatible' && (
        <div style={styles.field}>
          <label style={styles.label}>Base URL</label>
          <input
            type="text"
            style={styles.input}
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={handleBaseUrlChange}
          />
        </div>
      )}

      {/* Model selector */}
      <div style={styles.field}>
        <label style={styles.label}>Model</label>
        {isChatGPTProvider ? (
          <select style={styles.select} value={modelName} onChange={handleModelChange}>
            {(authStatus?.models.length ? authStatus.models : ['gpt-5.4']).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            style={styles.input}
            placeholder="e.g. claude-3-opus-20240229"
            value={modelName}
            onChange={handleModelChange}
          />
        )}
      </div>

      {isChatGPTProvider && (
        <div style={styles.field}>
          <label style={styles.label}>Authentication</label>
          <div style={styles.helperText}>
            {authStatus?.connected
              ? authStatus.accountId
                ? `Connected account: ${authStatus.accountId}`
                : 'Connected to ChatGPT subscription'
              : 'Use your ChatGPT Plus or Pro subscription to access Codex models.'}
          </div>
          <div style={styles.inputRow}>
            <button
              style={styles.testButton}
              onClick={handleChatGPTLogin}
              disabled={testing}
            >
              {testing ? 'Waiting for sign-in...' : authStatus?.connected ? 'Reconnect' : 'Sign in with ChatGPT'}
            </button>
            <button
              style={styles.toggleButton}
              onClick={handleChatGPTLogout}
              type="button"
              disabled={testing || !authStatus?.connected}
            >
              Sign out
            </button>
          </div>
        </div>
      )}

      {!isChatGPTProvider && (
        <div style={styles.field}>
          <button
            style={styles.testButton}
            onClick={handleTestConnection}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <div
              style={{
                ...styles.testResult,
                color: testResult.success
                  ? 'var(--accent-green)'
                  : 'var(--accent-red)',
              }}
            >
              {testResult.success ? '\u2713 ' : '\u2717 '}
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {isChatGPTProvider && testResult && (
        <div
          style={{
            ...styles.testResult,
            color: testResult.success
              ? 'var(--accent-green)'
              : 'var(--accent-red)',
          }}
        >
          {testResult.success ? '\u2713 ' : '\u2717 '}
          {testResult.message}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  },
  sectionDescription: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: 0,
    lineHeight: 1.5,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  select: {
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  inputRow: {
    display: 'flex',
    gap: 8,
  },
  toggleButton: {
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'var(--font-sans)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  errorText: {
    fontSize: 12,
    color: 'var(--accent-red)',
    lineHeight: 1.4,
  },
  helperText: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    lineHeight: 1.4,
  },
  testButton: {
    alignSelf: 'flex-start',
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-sans)',
    border: '1px solid var(--accent-amber)',
    borderRadius: 'var(--radius-standard)',
    backgroundColor: 'transparent',
    color: 'var(--accent-amber)',
    cursor: 'pointer',
  },
  testResult: {
    fontSize: 13,
    fontWeight: 500,
    marginTop: 4,
  },
}
