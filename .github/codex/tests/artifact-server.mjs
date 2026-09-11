// A real Azure streaming upload against a local HTTP service, with only the
// GitHub control-plane request mocked. Loaded into the production Node worker.
import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { BlobClient, BlockBlobClient } from '@azure/storage-blob'
import { DefaultArtifactClient } from '@actions/artifact'
import { createZipUploadStream } from '../node_modules/@actions/artifact/lib/internal/upload/zip.js'
import { uploadToBlobStorage } from '../node_modules/@actions/artifact/lib/internal/upload/blob-upload.js'

let received = 0
const server = createServer((request, response) => {
  request.on('data', (chunk) => {
    received += chunk.length
  })
  request.on('end', () => {
    response.writeHead(201, {
      etag: '"fixture"',
      'last-modified': new Date().toUTCString(),
      'x-ms-request-id': 'fixture',
      'x-ms-version': '2025-11-05',
    })
    response.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
BlobClient.prototype.getBlockBlobClient = () =>
  new BlockBlobClient(
    `http://127.0.0.1:${server.address().port}/account/container/checkpoint`,
    undefined,
    { allowInsecureConnection: true, retryOptions: { maxTries: 1 } },
  )
DefaultArtifactClient.prototype.uploadArtifact = async (_name, files) => {
  const stream = await createZipUploadStream([
    {
      sourcePath: files[0],
      destinationPath: 'checkpoint.enc',
      stats: await stat(files[0]),
    },
  ])
  const result = await uploadToBlobStorage(
    'https://example.com/container/checkpoint',
    stream,
    'application/zip',
  )
  if (received < 2_000_000 || result.uploadSize < 2_000_000)
    throw new Error('Large upload was incomplete')
  server.closeAllConnections()
  server.close()
  return { id: 9 }
}
