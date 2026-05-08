/**
 * OnboardingWizard — Full-screen 2-step wizard shown on first launch.
 *
 * Step 1: Connect your AI (provider + API key + model)
 * Step 2: Choose Simple mode or Workspace mode
 *
 * On completion, persists settings and opens the chat view directly.
 */

import React, { useState, useCallback } from 'react'
import type { AIProvider, SessionNewResult } from '../../shared/protocol'
import { StepConnectAI } from './onboarding/StepConnectAI'
import { useConversationStore } from '../stores/conversationStore'
import './OnboardingWizard.css'

// ── Mode selection icons ─────────────────────────────────────

const ChatBubbleIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const FolderIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

// ── Back arrow icon ─────────────────────────────────────────

const BackArrow = () => (
  <svg viewBox='0 0 24 24'>
    <line x1='19' y1='12' x2='5' y2='12' />
    <polyline points='12 19 5 12 12 5' />
  </svg>
)

// ── Component ───────────────────────────────────────────────

interface OnboardingWizardProps {
  onComplete: () => void
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onComplete }) => {
  // Wizard state
  const [step, setStep] = useState(1)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  // Step 1 state
  const [provider, setProvider] = useState<AIProvider>('openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('gpt-5.5')

  // Step 2 state
  const [workspace, setWorkspace] = useState('')
  const [selectedMode, setSelectedMode] = useState<'simple' | 'workspace' | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  // ── Navigation ──────────────────────────────────────────

  const goNext = useCallback(() => {
    setDirection('forward')
    setStep((s) => Math.min(s + 1, 2))
  }, [])

  const goBack = useCallback(() => {
    setDirection('back')
    setStep((s) => Math.max(s - 1, 1))
  }, [])

  // ── Finish wizard ───────────────────────────────────────

  const handleFinish = useCallback(async () => {
    if (selectedMode === null || finishing) return

    setFinishing(true)
    setFinishError(null)

    try {
      await window.ouroboros.rpc('config/set', { path: 'model.provider', value: provider })
      await window.ouroboros.rpc('config/set', { path: 'model.name', value: model })
      if (provider === 'openai-compatible') {
        await window.ouroboros.rpc('config/set', { path: 'model.baseUrl', value: baseUrl })
      }
      if (provider !== 'openai-chatgpt') {
        await window.ouroboros.rpc('config/setApiKey', { provider, apiKey })
      }

      const isWorkspaceMode = selectedMode === 'workspace'
      const sessionResult = (await window.ouroboros.rpc(
        'session/new',
        isWorkspaceMode && workspace
          ? { workspaceMode: 'workspace' as const, workspacePath: workspace }
          : { workspaceMode: 'simple' as const },
      )) as SessionNewResult

      if (sessionResult?.sessionId) {
        const store = useConversationStore.getState()
        const createdWorkspaceMode =
          sessionResult.workspaceMode ?? (isWorkspaceMode && workspace ? 'workspace' : 'simple')
        if (isWorkspaceMode && workspace) {
          store.setSelectedWorkspacePath(workspace)
          store.setWorkspaceMode('workspace')
        } else {
          store.setWorkspaceMode('simple')
        }
        store.createNewSession(
          sessionResult.sessionId,
          sessionResult.workspacePath,
          createdWorkspaceMode,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete onboarding setup'
      setFinishError(message)
      setFinishing(false)
      return
    }

    setFinishing(false)
    onComplete()
  }, [provider, apiKey, baseUrl, model, workspace, selectedMode, onComplete, finishing])

  // ── Step indicator ──────────────────────────────────────

  const dots = [1, 2].map((n) => {
    let className = 'onboarding-wizard__dot'
    if (n === step) className += ' onboarding-wizard__dot--active'
    else if (n < step) className += ' onboarding-wizard__dot--completed'
    return <div key={n} className={className} />
  })

  // ── Step content ────────────────────────────────────────

  const stepAnimClass =
    direction === 'forward'
      ? 'onboarding-wizard__step'
      : 'onboarding-wizard__step onboarding-wizard__step--back'

  let stepContent: React.ReactNode
  switch (step) {
    case 1:
      stepContent = (
        <StepConnectAI
          provider={provider}
          apiKey={apiKey}
          baseUrl={baseUrl}
          model={model}
          onProviderChange={setProvider}
          onApiKeyChange={setApiKey}
          onBaseUrlChange={setBaseUrl}
          onModelChange={setModel}
          onNext={goNext}
        />
      )
      break
    case 2:
      stepContent = (
        <StepMode
          selectedMode={selectedMode}
          onModeChange={setSelectedMode}
          workspacePath={workspace}
          onWorkspaceChange={setWorkspace}
          onFinish={handleFinish}
          isFinishing={finishing}
          errorMessage={finishError}
        />
      )
      break
  }

  return (
    <div className='onboarding-wizard'>
      <div className='onboarding-wizard__card'>
        {/* Step indicator */}
        <div className='onboarding-wizard__dots'>{dots}</div>

        {/* Back button (steps 2 and 3) */}
        {step > 1 && (
          <button className='onboarding-wizard__back' onClick={goBack}>
            <BackArrow />
            Back
          </button>
        )}

        {/* Step content with slide animation */}
        <div key={step} className={stepAnimClass}>
          {stepContent}
        </div>
      </div>
    </div>
  )
}

// ── Step 2: Mode Selection ──────────────────────────────────

interface StepModeProps {
  selectedMode: 'simple' | 'workspace' | null
  onModeChange: (mode: 'simple' | 'workspace') => void
  workspacePath: string
  onWorkspaceChange: (path: string) => void
  onFinish: () => void
  isFinishing: boolean
  errorMessage: string | null
}

const StepMode: React.FC<StepModeProps> = ({
  selectedMode,
  onModeChange,
  workspacePath,
  onWorkspaceChange,
  onFinish,
  isFinishing,
  errorMessage,
}) => {
  const hasWorkspaceForWorkspaceMode = selectedMode === 'workspace' && workspacePath.length > 0
  const canFinish = (
    (selectedMode === 'simple') ||
    hasWorkspaceForWorkspaceMode
  ) && !isFinishing

  const handleChooseFolder = useCallback(async () => {
    try {
      const result = await window.ouroboros.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose your workspace folder',
      })
      if (result) {
        const dir = Array.isArray(result) ? result[0] : result
        if (dir) onWorkspaceChange(dir)
      }
    } catch {
      // Dialog canceled or errored — no action
    }
  }, [onWorkspaceChange])

  const modes: { id: 'simple' | 'workspace'; icon: React.ReactNode; title: string; description: string }[] = [
    {
      id: 'simple',
      icon: <ChatBubbleIcon />,
      title: 'Simple',
      description: 'A clean chat experience. Ask questions, get answers — no project context needed.',
    },
    {
      id: 'workspace',
      icon: <FolderIcon />,
      title: 'Workspace',
      description: 'Full project access. The agent can read files, run commands, and build in your workspace.',
    },
  ]

  return (
    <div>
      <h2 style={styles.heading}>Choose your mode</h2>
      <p style={styles.subheading}>
        {selectedMode === 'workspace' && !workspacePath
          ? 'Pick a workspace folder to get started'
          : 'Pick a starting mode — you can always change later'}
      </p>

      {/* Mode selection cards */}
      <div style={styles.modeGrid}>
        {modes.map((mode) => (
          <div
            key={mode.id}
            style={{
              ...styles.modeCard,
              ...(selectedMode === mode.id ? styles.modeCardSelected : {}),
            }}
            onClick={() => onModeChange(mode.id)}
            role="button"
            aria-label={mode.title}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onModeChange(mode.id)
            }}
            aria-pressed={selectedMode === mode.id}
          >
            <div style={styles.modeCardIcon}>{mode.icon}</div>
            <div style={styles.modeCardTitle}>{mode.title}</div>
            <div style={styles.modeCardDescription}>{mode.description}</div>
          </div>
        ))}
      </div>

      {/* Workspace folder picker when Workspace mode is selected */}
      {selectedMode === 'workspace' && (
        <div style={styles.workspaceSection}>
          {workspacePath ? (
            <div style={styles.selectedPath}>
              <span style={styles.pathText}>{workspacePath}</span>
              <button style={styles.changeLink} onClick={handleChooseFolder}>
                Change
              </button>
            </div>
          ) : (
            <button style={styles.chooseButton} onClick={handleChooseFolder}>
              Choose folder
            </button>
          )}
        </div>
      )}

      {errorMessage && <p style={styles.errorText}>{errorMessage}</p>}

      {/* Get Started button */}
      <button
        style={{
          ...styles.startButton,
          ...(!canFinish ? styles.buttonDisabled : {}),
        }}
        onClick={canFinish ? onFinish : undefined}
        disabled={!canFinish}
      >
        {isFinishing ? 'Setting things up...' : 'Get Started'}
      </button>
    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  heading: {
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  },
  subheading: {
    fontSize: '15px',
    color: 'var(--text-secondary)',
    marginBottom: '24px',
  },
  modeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
    marginBottom: '16px',
  },
  modeCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    padding: '20px 16px',
    border: '2px solid var(--border-light)',
    borderRadius: '12px',
    background: 'var(--bg-secondary)',
    cursor: 'pointer',
    transition: 'border-color 200ms ease, background 200ms ease',
    textAlign: 'left' as const,
  },
  modeCardSelected: {
    borderColor: 'var(--accent-primary)',
    background: 'var(--accent-muted)',
  },
  modeCardIcon: {
    color: 'var(--accent-primary)',
    marginBottom: '4px',
  },
  modeCardTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  modeCardDescription: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  workspaceSection: {
    marginBottom: '16px',
  },
  selectedPath: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    background: 'var(--bg-success)',
    border: '1px solid var(--border-success)',
    borderRadius: '8px',
  },
  pathText: {
    flex: 1,
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    wordBreak: 'break-all' as const,
  },
  changeLink: {
    fontSize: '13px',
    color: 'var(--text-link)',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    fontWeight: 500,
    flexShrink: 0,
  },
  chooseButton: {
    width: '100%',
    padding: '10px 24px',
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-inverse)',
    background: 'var(--accent-primary)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 200ms ease',
  },
  errorText: {
    fontSize: '13px',
    color: 'var(--text-error)',
    lineHeight: 1.5,
    margin: '0 0 16px 0',
  },
  startButton: {
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
  },
  buttonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
}

export default OnboardingWizard
