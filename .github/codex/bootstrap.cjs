const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

// A JavaScript action receives the artifact service credentials. Do not export
// those credentials to GITHUB_ENV or to any model/tool subprocess.
const result = spawnSync('bun', [join(__dirname, 'controller.ts'), process.env.INPUT_OPERATION], {
  env: { ...process.env, CODEX_SDLC_NODE: process.execPath },
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
