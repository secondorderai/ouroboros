import React from 'react'

interface ArtifactFrameProps {
  src: string
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

// `allow-same-origin` is safe because the iframe loads from the
// `ouroboros-artifact://` scheme, which is a different origin from the
// renderer — it grants the artifact access to its own storage only.
const ARTIFACT_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-downloads',
  'allow-pointer-lock',
].join(' ')

export function ArtifactFrame({ src, title }: ArtifactFrameProps): React.ReactElement {
  return (
    <iframe
      data-testid='artifact-frame'
      title={title}
      sandbox={ARTIFACT_SANDBOX}
      referrerPolicy='no-referrer'
      src={src}
      style={styles.frame}
    />
  )
}
