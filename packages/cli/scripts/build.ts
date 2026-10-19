import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..')

export function buildCommands(options: {
  output: string
  target?: string
  platform: NodeJS.Platform
  bunExecutable: string
}): string[][] {
  const { output, target, platform, bunExecutable } = options
  const commands = [
    [
      bunExecutable,
      'build',
      '--compile',
      '--minify',
      '--sourcemap',
      './src/cli.ts',
      ...(target ? [`--target=${target}`] : []),
      '--outfile',
      output,
    ],
  ]

  // The Bun-compiled Mach-O can have an invalid linker signature. macOS kills
  // it before main() runs unless the final file is signed and verified.
  if (platform === 'darwin' && (!target || target.startsWith('bun-darwin-'))) {
    commands.push(['codesign', '--force', '--sign', '-', output])
    commands.push(['codesign', '--verify', '--verbose=2', output])
  }

  return commands
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: packageDir,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${exitCode}`)
  }
}

if (import.meta.main) {
  if (Bun.argv.length > 4) {
    throw new Error('Usage: bun scripts/build.ts [output] [target]')
  }

  const output = resolve(packageDir, Bun.argv[2] ?? 'dist/ouroboros')
  mkdirSync(dirname(output), { recursive: true })

  for (const command of buildCommands({
    output,
    target: Bun.argv[3],
    platform: process.platform,
    bunExecutable: process.execPath,
  })) {
    await run(command)
  }
}
