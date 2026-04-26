import React from 'react'

interface ArtifactFrameProps {
  html: string
  title: string
}

const styles: Record<string, React.CSSProperties> = {
  frame: {
    width: '100%',
    height: '100%',
    border: 'none',
    background: 'var(--bg-chat)',
  },
}

export function ArtifactFrame({ html, title }: ArtifactFrameProps): React.ReactElement {
  return (
    <iframe
      data-testid='artifact-frame'
      title={title}
      sandbox='allow-scripts'
      referrerPolicy='no-referrer'
      srcDoc={html}
      style={styles.frame}
    />
  )
}
