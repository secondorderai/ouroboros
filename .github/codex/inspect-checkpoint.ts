import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { decrypt, stateKey } from './storage'
import { command } from './process'

async function main(): Promise<void> {
  const [file, repo, issue, pipelineId, destination] = Bun.argv.slice(2)
  if (!file || !repo || !/^\d+$/.test(issue ?? '') || !pipelineId || !destination) {
    throw new Error(
      'Usage: inspect-checkpoint.ts checkpoint.enc owner/repo issue pipeline-id destination',
    )
  }
  const target = resolve(destination)
  await mkdir(target, { recursive: true, mode: 0o700 })
  if ((await readdir(target)).length) throw new Error('Choose an empty inspection directory.')
  const key = stateKey(process.env.CODEX_SDLC_STATE_KEY ?? '')
  const archive = join(target, 'checkpoint.tar.gz')
  await writeFile(
    archive,
    decrypt(await readFile(file), key, `${repo}/${issue}/${pipelineId}/v1`),
    { mode: 0o600 },
  )
  const listing = await command(['tar', '-tzf', archive], { cwd: target })
  if (
    listing.code !== 0 ||
    listing.stdout
      .split('\n')
      .filter(Boolean)
      .some((path) => path.startsWith('/') || path.split('/').includes('..'))
  ) {
    throw new Error('Invalid checkpoint paths.')
  }
  const extracted = await command(['tar', '-xzf', archive, '-C', target], { cwd: target })
  if (extracted.code !== 0) throw new Error('Checkpoint extraction failed.')
  console.log(`Decrypted records: ${target}`)
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Inspection failed.')
    process.exitCode = 1
  })
