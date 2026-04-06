import React, { useState, useCallback, useEffect } from 'react'
import type { OuroborosConfig } from '../../../shared/protocol'

interface ModelSectionProps {
  config: OuroborosConfig | null
  onConfigChange: (path: string, value: unknown) => void
}

type Provider = 'anthropic' | 'openai' | 'openai-compatible'

const PROVIDERS: Array<{ value: Provider; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
]

export function ModelSection({
  config,
  onConfigChange,
}: ModelSectionProps): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  const [testing, setTesting] = useState(false)

  const provider = config?.model?.provider ?? 'anthropic'
  const modelName = config?.model?.name ?? ''
  const baseUrl = config?.model?.baseUrl ?? ''

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onConfigChange('model.provider', e.target.value)
    },
    [onConfigChange]
  )

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onConfigChange('model.name', e.target.value)
    },
    [onConfigChange]
  )

  const handleBaseUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onConfigChange('model.baseUrl', e.target.value)
    },
    [onConfigChange]
  )

  const handleApiKeyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setApiKey(e.target.value)
    },
    []
  )

  const handleApiKeyBlur = useCallback(() => {
    if (apiKey) {
      onConfigChange('model.apiKey', apiKey)
    }
  }, [apiKey, onConfigChange])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = (await window.ouroboros.rpc('config/testConnection')) as {
        connected: boolean
        error?: string
      }
      if (result.connected) {
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
  }, [])

  // Reset test result when provider changes
  useEffect(() => {
    setTestResult(null)
  }, [provider])

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Model & API Keys</h3>
      <p style={styles.sectionDescription}>
        Configure your LLM provider, API key, and model selection.
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

      {/* API Key */}
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
      </div>

      {/* Base URL (only for openai-compatible) */}
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
        <input
          type="text"
          style={styles.input}
          placeholder="e.g. claude-3-opus-20240229"
          value={modelName}
          onChange={handleModelChange}
        />
      </div>

      {/* Test connection */}
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
