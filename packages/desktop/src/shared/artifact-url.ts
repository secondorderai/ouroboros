export const ARTIFACT_PROTOCOL_SCHEME = 'ouroboros-artifact'

export function buildArtifactProtocolUrl(absolutePath: string): string {
  return `${ARTIFACT_PROTOCOL_SCHEME}://artifact/?path=${encodeURIComponent(absolutePath)}`
}
