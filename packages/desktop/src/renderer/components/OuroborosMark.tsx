import React, { useId } from 'react'

interface OuroborosMarkProps {
  size?: number
  color?: string
  /** Retained for API back-compat; the new geometry has no separate eye element. */
  eyeColor?: string
  tileColor?: string
  borderColor?: string
  shadow?: boolean
}

export function OuroborosMark({
  size = 48,
  color = 'var(--text-secondary)',
  eyeColor: _eyeColor,
  tileColor = 'var(--bg-chat)',
  borderColor = 'var(--border-light)',
  shadow = false,
}: OuroborosMarkProps): React.ReactElement {
  void _eyeColor
  const shadowId = useId()

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        {shadow && (
          <filter id={shadowId} x="0" y="0" width="64" height="64" filterUnits="userSpaceOnUse">
            <feOffset dy="3" />
            <feGaussianBlur stdDeviation="3" />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0.0588 0 0 0 0 0.0667 0 0 0 0 0.0863 0 0 0 0.16 0"
            />
          </filter>
        )}
      </defs>
      <g filter={shadow ? `url(#${shadowId})` : undefined}>
        <rect x="5" y="5" width="54" height="54" rx="14" fill={tileColor} />
      </g>
      <rect x="5.5" y="5.5" width="53" height="53" rx="13.5" stroke={borderColor} />
      <circle cx="32" cy="32" r="18" stroke={color} strokeWidth="2" />
      <circle cx="32" cy="32" r="10" stroke={color} strokeWidth="2" />
      <circle cx="43" cy="21" r="3" fill={color} />
    </svg>
  )
}
