/**
 * OnboardingWizard — Full-screen 3-step wizard shown on first launch.
 *
 * Step 1: Connect your AI (provider + API key + model)
 * Step 2: Choose your workspace (folder picker + drag-and-drop)
 * Step 3: What would you like to do? (template selection)
 *
 * On completion, persists settings and triggers the first chat message.
 */

import React, { useState, useCallback } from 'react'
import type { AIProvider } from '../../shared/protocol'
import { StepConnectAI } from './onboarding/StepConnectAI'
import { StepWorkspace } from './onboarding/StepWorkspace'
import { StepTemplate } from './onboarding/StepTemplate'
import { useConversationStore } from '../stores/conversationStore'
import './OnboardingWizard.css'

// ── Welcome message templates ───────────────────────────────

function getWelcomeMessage(template: number, workspace: string): string {
  switch (template) {
    case 1:
      return `Hi! I'm Ouroboros. I'm ready to help with your project at \`${workspace}\`. What would you like to work on?`
    case 2:
      return `Hi! Let me explore \`${workspace}\` and give you an overview...`
    case 3:
      return "Hi! I'm Ouroboros, your AI assistant. Ask me anything."
    case 4:
      return "Hi! I'm Ouroboros, and I'm designed to learn and improve. Give me tasks and I'll develop new skills over time. My self-improvement is on — watch the serpent icon for activity."
    default:
      return "Hi! I'm Ouroboros. How can I help you?"
  }
}

// ── Back arrow icon ─────────────────────────────────────────

const BackArrow = () => (
  <svg viewBox="0 0 24 24">
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </svg>
)

// ── Component ───────────────────────────────────────────────

interface OnboardingWizardProps {
  onComplete: (welcomeMessage: string, template: number) => void
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  onComplete,
}) => {
  // Wizard state
  const [step, setStep] = useState(1)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  // Step 1 state
  const [provider, setProvider] = useState<AIProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-opus-4-20250514')

  // Step 2 state
  const [workspace, setWorkspace] = useState('')

  // Step 3 state
  const [template, setTemplate] = useState<number | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  // ── Navigation ──────────────────────────────────────────

  const goNext = useCallback(() => {
    setDirection('forward')
    setStep((s) => Math.min(s + 1, 3))
  }, [])

  const goBack = useCallback(() => {
    setDirection('back')
    setStep((s) => Math.max(s - 1, 1))
  }, [])

  // ── Finish wizard ───────────────────────────────────────

  const handleFinish = useCallback(async () => {
    if (template === null || finishing) return

    setFinishing(true)
    setFinishError(null)

    try {
      await window.ouroboros.rpc('config/setApiKey', { provider, apiKey })
      await window.ouroboros.rpc('config/set', { path: 'model.provider', value: provider })
      await window.ouroboros.rpc('config/set', { path: 'model.name', value: model })

      if (workspace) {
        await window.ouroboros.rpc('workspace/set', { directory: workspace })
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to complete onboarding setup'
      setFinishError(message)
      setFinishing(false)
      return
    }

    // Generate welcome message and transition to chat
    const welcomeMessage = getWelcomeMessage(template, workspace)
    setFinishing(false)
    onComplete(welcomeMessage, template)

    // For template 2, auto-trigger codebase exploration
    if (template === 2) {
      try {
        await window.ouroboros.rpc('agent/run', {
          message: 'Explore this project and give me an overview',
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to start initial project exploration'
        useConversationStore.getState().handleAgentError({
          message: `Initial exploration failed: ${message}`,
        })
      }
    }
  }, [provider, apiKey, model, workspace, template, onComplete, finishing])

  // ── Step indicator ──────────────────────────────────────

  const dots = [1, 2, 3].map((n) => {
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
          model={model}
          onProviderChange={setProvider}
          onApiKeyChange={setApiKey}
          onModelChange={setModel}
          onNext={goNext}
        />
      )
      break
    case 2:
      stepContent = (
        <StepWorkspace
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          onNext={goNext}
        />
      )
      break
    case 3:
      stepContent = (
        <StepTemplate
          selectedTemplate={template}
          onTemplateChange={setTemplate}
          onFinish={handleFinish}
          isFinishing={finishing}
          errorMessage={finishError}
        />
      )
      break
  }

  return (
    <div className="onboarding-wizard">
      <div className="onboarding-wizard__card">
        {/* Step indicator */}
        <div className="onboarding-wizard__dots">{dots}</div>

        {/* Back button (steps 2 and 3) */}
        {step > 1 && (
          <button className="onboarding-wizard__back" onClick={goBack}>
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

export default OnboardingWizard
