import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packageDir = join(import.meta.dir, '..')

async function run(
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

test('built CLI has a valid macOS signature and launches without SIGKILL', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ouroboros-build-test-'))
  const binary = join(tempDir, process.platform === 'win32' ? 'ouroboros.exe' : 'ouroboros')

  try {
    const build = await run([process.execPath, 'scripts/build.ts', binary])
    expect(build.exitCode, build.stderr).toBe(0)

    if (process.platform === 'darwin') {
      const signature = await run(['codesign', '--verify', '--verbose=2', binary])
      expect(signature.exitCode, signature.stderr).toBe(0)
    }

    const launch = await run([binary, '--version'])
    expect(launch.exitCode, launch.stderr).toBe(0)
    expect(launch.stdout.trim()).toBe('0.1.0')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}, 90_000)
