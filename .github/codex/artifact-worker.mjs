import { DefaultArtifactClient } from '@actions/artifact'

// This file deliberately runs in Node, not Bun. Azure's streaming uploader can
// stall under Bun once checkpoint archives grow beyond the first small snapshot.
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  const request = JSON.parse(input)
  const client = new DefaultArtifactClient()
  let result
  if (request.operation === 'upload') {
    result = await client.uploadArtifact(...request.args)
    result = { id: result.id }
  } else if (request.operation === 'download') {
    await client.downloadArtifact(...request.args)
    result = {}
  } else {
    throw new Error('Unknown artifact operation')
  }
  // Do not let SDK sockets or retry timers keep the Actions runner alive.
  process.stdout.write(JSON.stringify({ type: 'artifact-result', ...result }) + '\n', () =>
    process.exit(0),
  )
} catch (error) {
  const reason = error?.message?.includes('Upload progress stalled') ? 'stalled' : 'failed'
  // SDK exceptions can include signed URLs. Return fixed labels only.
  process.stdout.write(JSON.stringify({ type: 'artifact-error', reason }) + '\n', () =>
    process.exit(1),
  )
}
