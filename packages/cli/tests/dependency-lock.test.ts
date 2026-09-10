import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const lock = Bun.JSONC.parse(readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf-8')) as {
  packages: Record<string, [string, ...unknown[]]>
}

// Minimum fixed versions for the production audit failures in Actions run 34437933948.
// Inspect every resolution, including nested copies, so a safe hoisted version cannot
// hide a vulnerable version that will still fail CI's audit.
const patchedVersions = {
  '@ai-sdk/provider-utils': '4.0.33',
  '@hono/node-server': '1.19.15',
  'body-parser': '2.3.0',
  'builder-util-runtime': '9.7.0',
  dompurify: '3.4.13',
  'fast-uri': '3.1.6',
  hono: '4.13.5',
  'ip-address': '10.3.1',
  'js-yaml': '4.3.2',
  mermaid: '11.16.1',
  qs: '6.16.0',
  'shell-quote': '1.9.0',
}

describe('production dependency audit regressions', () => {
  for (const [name, minimum] of Object.entries(patchedVersions)) {
    test(`${name} resolves only to patched releases`, () => {
      const versions = Object.values(lock.packages)
        .map(([resolution]) => resolution)
        .filter((resolution) => resolution.startsWith(`${name}@`))
        .map((resolution) => resolution.slice(name.length + 1))

      expect(versions.length).toBeGreaterThan(0)
      expect(versions.filter((version) => !Bun.semver.satisfies(version, `>=${minimum}`))).toEqual(
        [],
      )
    })
  }

  test('dependency and workflow changes trigger CI and retain the full production audit', () => {
    const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/build.yml'), 'utf-8'))

    for (const event of ['push', 'pull_request']) {
      expect(workflow.on[event].paths).toEqual(
        expect.arrayContaining([
          'packages/**',
          'package.json',
          'bun.lock',
          '.github/workflows/build.yml',
        ]),
      )
    }

    for (const job of ['verify', 'build']) {
      expect(workflow.jobs[job].steps).toContainEqual(
        expect.objectContaining({
          name: 'Audit production dependencies',
          run: 'bun audit --prod',
        }),
      )
    }
  })
})
