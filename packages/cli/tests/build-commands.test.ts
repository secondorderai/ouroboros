import { describe, expect, test } from 'bun:test'
import { buildCommands } from '../scripts/build'

const output = '/tmp/ouroboros'
const bunExecutable = '/path/to/bun'

function commands(platform: NodeJS.Platform, target?: string): string[][] {
  return buildCommands({ output, target, platform, bunExecutable })
}

describe('compiled CLI build commands', () => {
  test('native macOS build signs and verifies the final binary', () => {
    expect(commands('darwin')).toEqual([
      [
        bunExecutable,
        'build',
        '--compile',
        '--minify',
        '--sourcemap',
        './src/cli.ts',
        '--outfile',
        output,
      ],
      ['codesign', '--force', '--sign', '-', output],
      ['codesign', '--verify', '--verbose=2', output],
    ])
  })

  test.each(['bun-darwin-arm64', 'bun-darwin-x64'])(
    'macOS release target %s is signed and verified',
    (target) => {
      const result = commands('darwin', target)
      expect(result[0]).toContain(`--target=${target}`)
      expect(result.slice(1)).toEqual([
        ['codesign', '--force', '--sign', '-', output],
        ['codesign', '--verify', '--verbose=2', output],
      ])
    },
  )

  test('non-macOS targets are not sent to codesign', () => {
    expect(commands('linux')).toHaveLength(1)
    expect(commands('darwin', 'bun-linux-x64')).toHaveLength(1)
  })
})
