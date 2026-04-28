import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function versionFromGitTag(tag: string): string {
  const trimmed = tag.trim()
  const version = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed

  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Release tag must be a SemVer tag like v1.2.3; received ${JSON.stringify(tag)}`)
  }

  return version
}

export async function syncPackageVersion(packageJsonPath: string, version: string): Promise<void> {
  const contents = await readFile(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(contents) as { version?: unknown }

  packageJson.version = version

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

export async function main(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const tag = args[0] ?? env.GITHUB_REF_NAME

  if (!tag) {
    throw new Error('Missing release tag. Pass a tag argument or set GITHUB_REF_NAME.')
  }

  const version = versionFromGitTag(tag)
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const packageJsonPath = resolve(scriptDir, '..', 'package.json')

  await syncPackageVersion(packageJsonPath, version)
  console.log(`Synced ${basename(packageJsonPath)} version to ${version}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
