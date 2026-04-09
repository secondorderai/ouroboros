/**
 * Step 3 — "What would you like to do?"
 *
 * 2x2 grid of template cards. Each card has an icon, title, and description.
 * Selected card uses the primary accent border + a subtle accent background tint.
 */

import React from 'react'

// ── Template card icons ─────────────────────────────────────

const CodeIcon = () => (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
)

const SearchIcon = () => (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const ChatIcon = () => (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const SparkleIcon = () => (
  <svg
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" />
  </svg>
)

// ── Template definitions ────────────────────────────────────

interface TemplateOption {
  id: number
  icon: React.ReactNode
  title: string
  description: string
}

const TEMPLATES: TemplateOption[] = [
  {
    id: 1,
    icon: <CodeIcon />,
    title: 'Help me with a project',
    description:
      "I'll help you build, debug, and improve your code in the workspace you selected.",
  },
  {
    id: 2,
    icon: <SearchIcon />,
    title: 'Explore this codebase',
    description:
      "I'll read through your project and give you an overview of its structure and purpose.",
  },
  {
    id: 3,
    icon: <ChatIcon />,
    title: 'General assistant',
    description:
      'Ask me anything — no project focus needed. Good for questions, writing, and research.',
  },
  {
    id: 4,
    icon: <SparkleIcon />,
    title: 'Let the agent evolve',
    description:
      "I'll learn from every task and build new skills over time. Give me problems to grow from.",
  },
]

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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
    marginBottom: '24px',
  } as React.CSSProperties,
  card: {
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
  } as React.CSSProperties,
  cardSelected: {
    borderColor: 'var(--accent-primary)',
    background: 'var(--accent-muted)',
  } as React.CSSProperties,
  cardIcon: {
    color: 'var(--accent-primary)',
    marginBottom: '4px',
  } as React.CSSProperties,
  cardTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  } as React.CSSProperties,
  cardDescription: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  } as React.CSSProperties,
  getStartedButton: {
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
  } as React.CSSProperties,
  buttonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  } as React.CSSProperties,
  errorText: {
    fontSize: '13px',
    color: 'var(--text-error)',
    lineHeight: 1.5,
    margin: '0 0 16px 0',
  } as React.CSSProperties,
}

// ── Component ───────────────────────────────────────────────

interface StepTemplateProps {
  selectedTemplate: number | null
  onTemplateChange: (id: number) => void
  onFinish: () => void
  isFinishing?: boolean
  errorMessage?: string | null
}

export const StepTemplate: React.FC<StepTemplateProps> = ({
  selectedTemplate,
  onTemplateChange,
  onFinish,
  isFinishing = false,
  errorMessage = null,
}) => {
  const canFinish = selectedTemplate !== null && !isFinishing

  return (
    <div>
      <h2 style={styles.heading}>What would you like to do?</h2>
      <p style={styles.subheading}>
        Pick a starting point — you can always change later
      </p>

      {/* 2x2 template grid */}
      <div style={styles.grid}>
        {TEMPLATES.map((tmpl) => (
          <div
            key={tmpl.id}
            style={{
              ...styles.card,
              ...(selectedTemplate === tmpl.id ? styles.cardSelected : {}),
            }}
            onClick={() => onTemplateChange(tmpl.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onTemplateChange(tmpl.id)
            }}
            aria-pressed={selectedTemplate === tmpl.id}
          >
            <div style={styles.cardIcon}>{tmpl.icon}</div>
            <div style={styles.cardTitle}>{tmpl.title}</div>
            <div style={styles.cardDescription}>{tmpl.description}</div>
          </div>
        ))}
      </div>

      {errorMessage && <p style={styles.errorText}>{errorMessage}</p>}

      {/* Get Started button */}
      <button
        style={{
          ...styles.getStartedButton,
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

export default StepTemplate
