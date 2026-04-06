import React, { useState, useEffect, useCallback } from 'react'
import type { Theme } from '../../../shared/protocol'

interface AppearanceSectionProps {
  theme: Theme
  onSetTheme: (theme: Theme) => void
}

type FontSize = 'small' | 'medium' | 'large'

const FONT_SIZE_MAP: Record<FontSize, number> = {
  small: 13,
  medium: 15,
  large: 17,
}

export function AppearanceSection({
  theme,
  onSetTheme,
}: AppearanceSectionProps): React.ReactElement {
  const [fontSize, setFontSizeState] = useState<FontSize>('medium')

  // Initialize font size from current body style
  useEffect(() => {
    const bodySize = parseInt(
      getComputedStyle(document.body).fontSize,
      10
    )
    if (bodySize <= 13) setFontSizeState('small')
    else if (bodySize >= 17) setFontSizeState('large')
    else setFontSizeState('medium')
  }, [])

  const handleFontSizeChange = useCallback(
    (size: FontSize) => {
      setFontSizeState(size)
      document.body.style.fontSize = `${FONT_SIZE_MAP[size]}px`
      // Persist via config
      window.ouroboros.rpc('config/set', {
        path: 'appearance.fontSize',
        value: size,
      })
    },
    []
  )

  return (
    <div style={styles.section}>
      <h3 style={styles.sectionTitle}>Appearance</h3>
      <p style={styles.sectionDescription}>
        Customize the look and feel of the application.
      </p>

      {/* Theme selector */}
      <div style={styles.field}>
        <label style={styles.label}>Theme</label>
        <div className="settings-segment-group">
          <button
            className="settings-segment-option"
            data-active={theme === 'light'}
            onClick={() => onSetTheme('light')}
          >
            Light
          </button>
          <button
            className="settings-segment-option"
            data-active={theme === 'dark'}
            onClick={() => onSetTheme('dark')}
          >
            Dark
          </button>
          <button
            className="settings-segment-option"
            data-active={theme === 'system'}
            onClick={() => onSetTheme('system')}
          >
            System
          </button>
        </div>
      </div>

      {/* Font size selector */}
      <div style={styles.field}>
        <label style={styles.label}>Font Size</label>
        <div className="settings-segment-group">
          <button
            className="settings-segment-option"
            data-active={fontSize === 'small'}
            onClick={() => handleFontSizeChange('small')}
          >
            Small
          </button>
          <button
            className="settings-segment-option"
            data-active={fontSize === 'medium'}
            onClick={() => handleFontSizeChange('medium')}
          >
            Medium
          </button>
          <button
            className="settings-segment-option"
            data-active={fontSize === 'large'}
            onClick={() => handleFontSizeChange('large')}
          >
            Large
          </button>
        </div>
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
}
