import React, { useId } from 'react'

interface OuroborosMarkProps {
  size?: number
  color?: string
  eyeColor?: string
  tileColor?: string
  borderColor?: string
  shadow?: boolean
}

export function OuroborosMark({
  size = 48,
  color = 'var(--text-secondary)',
  eyeColor = 'var(--bg-chat)',
  tileColor = 'var(--bg-chat)',
  borderColor = 'var(--border-light)',
  shadow = false,
}: OuroborosMarkProps): React.ReactElement {
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
      <circle cx="32" cy="32" r="17.5" stroke={color} strokeWidth="8" />
      <path
        d="M39.4 16.2C42.5 15 46.4 15.2 49 17.1C50.7 18.4 51.9 20.4 52.2 22.6C50.4 25 47.2 26.5 43.8 26.5C40.3 26.4 37.1 24.8 35.1 22.2C35.9 19.7 37.2 17.9 39.4 16.2Z"
        fill={color}
      />
      <ellipse cx="43.4" cy="18.9" rx="1.65" ry="1.15" fill={eyeColor} transform="rotate(24 43.4 18.9)" />
    </svg>
  )
}
