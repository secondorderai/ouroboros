import { readFileSync, writeFileSync } from 'node:fs'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const refName = process.env.GITHUB_REF_NAME ?? ''
const version = process.env.VERSION ?? refName.replace(/^v/, '')

if (!version || !SEMVER.test(version)) {
  throw new Error(
    `Release tag must be a SemVer tag like v1.2.3; received ${refName || '(empty)'}`,
  )
}

const packagePath = 'packages/cli/package.json'
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
packageJson.version = version
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

const cliPath = 'packages/cli/src/cli.ts'
const cliSource = readFileSync(cliPath, 'utf8')
const versionCall = /\.version\('\d+\.\d+\.\d+(?:-[^']+)?(?:\+[^']+)?'\)/
const nextCliSource = cliSource.replace(versionCall, `.version('${version}')`)

if (nextCliSource === cliSource) {
  throw new Error('Could not update Commander version in packages/cli/src/cli.ts')
}

writeFileSync(cliPath, nextCliSource)
console.log(`Synced CLI version to ${version}`)
