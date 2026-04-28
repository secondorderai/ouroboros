import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'bun:test'

import { syncPackageVersion, versionFromGitTag } from '../scripts/sync-release-version'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('release version sync', () => {
  test('derives package version from a v-prefixed Git tag', () => {
    expect(versionFromGitTag('v1.2.3')).toBe('1.2.3')
    expect(versionFromGitTag('v2.0.0-beta.1')).toBe('2.0.0-beta.1')
  })

  test('rejects tags that cannot be used as package versions', () => {
    expect(() => versionFromGitTag('release-1.2.3')).toThrow('SemVer')
    expect(() => versionFromGitTag('v1.2')).toThrow('SemVer')
  })

  test('updates package.json version while preserving other metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ouroboros-release-version-'))
    tempDirs.push(dir)

    const packageJsonPath = join(dir, 'package.json')
    await writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: '@ouroboros/desktop',
          version: '0.1.0',
          private: true,
        },
        null,
        2,
      ),
    )

    await syncPackageVersion(packageJsonPath, '1.4.0')

    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      name: string
      version: string
      private: boolean
    }

    expect(packageJson).toEqual({
      name: '@ouroboros/desktop',
      version: '1.4.0',
      private: true,
    })
  })
})
