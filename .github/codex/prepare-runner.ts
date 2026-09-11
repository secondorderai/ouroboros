import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { command } from './process'

// Use an isolated source list for this invocation instead of the runner image's
// HTTP mirror list. Ubuntu archive signatures remain checked by apt.
const sources = `Types: deb
URIs: https://archive.ubuntu.com/ubuntu
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`

export async function prepareRunner(
  directory: string,
  run = command,
  timeoutMs = 300_000,
): Promise<void> {
  const file = join(directory, 'ubuntu.sources')
  await writeFile(file, sources)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const apt = [
    'sudo',
    '-n',
    'env',
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get',
    '-o',
    `Dir::Etc::sourcelist=${file}`,
    '-o',
    'Dir::Etc::sourceparts=-',
    '-o',
    'Acquire::Retries=2',
    '-o',
    'Acquire::https::Timeout=20',
    '-o',
    'Acquire::http::Timeout=20',
    '-o',
    'APT::Update::Error-Mode=any',
  ]
  try {
    for (const args of [
      ['update'],
      [
        'install',
        '--yes',
        '--no-install-recommends',
        'xvfb',
        'libgtk-3-0t64',
        'libnss3',
        'libasound2t64',
        'libgbm1',
        'libxss1',
        'bubblewrap',
        'socat',
        'ripgrep',
      ],
    ]) {
      const result = await run([...apt, ...args], {
        cwd: directory,
        signal: abort.signal,
        onLine: (line) => console.log(line),
      })
      if (abort.signal.aborted)
        throw new Error('Runner dependency setup exceeded its five-minute deadline.')
      if (result.code !== 0) {
        console.error(result.stderr)
        throw new Error(`Runner dependency ${args[0]} failed using Ubuntu HTTPS sources.`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

if (import.meta.main) {
  const os = await readFile('/etc/os-release', 'utf8')
  if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os))
    throw new Error('Runner preparation requires Ubuntu 24.04.')
  const directory = await mkdtemp(join(tmpdir(), 'codex-sdlc-apt-'))
  try {
    await prepareRunner(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
