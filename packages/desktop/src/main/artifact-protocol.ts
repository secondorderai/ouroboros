import { protocol } from 'electron'
import { readFile } from 'fs/promises'
import { isSafeArtifactPath } from './artifact-paths'
import { ARTIFACT_PROTOCOL_SCHEME } from '../shared/artifact-url'

export { ARTIFACT_PROTOCOL_SCHEME }
export { buildArtifactProtocolUrl } from '../shared/artifact-url'

export function registerArtifactProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        stream: true,
        codeCache: false,
      },
    },
  ])
}

export function registerArtifactProtocolHandler(): void {
  protocol.handle(ARTIFACT_PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad URL', { status: 400 })
    }

    const filePath = url.searchParams.get('path')
    if (!filePath) {
      return new Response('Missing path', { status: 400 })
    }

    if (!isSafeArtifactPath(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const buffer = await readFile(filePath)
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
