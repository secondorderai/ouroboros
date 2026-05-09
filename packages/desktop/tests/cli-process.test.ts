import { afterEach, describe, expect, mock, test } from 'bun:test'

const mockedApp = {
  isPackaged: false,
  getAppPath: () => '/tmp/ouroboros-desktop-app',
  getPath: (name: string) => {
    if (name === 'userData') return '/tmp/ouroboros-user-data'
    if (name === 'home') return '/tmp/ouroboros-home'
    return '/tmp'
  },
}

mock.module('electron', () => ({
  app: mockedApp,
  dialog: { showErrorBox: () => {} },
}))

async function createManager() {
  const { CLIProcessManager } = await import('../src/main/cli-process')
  return new CLIProcessManager({ onStdoutLine: () => {} }) as unknown as {
    getCliPath: () => { command: string; args: string[] }
    getCliWorkingDirectory: () => string
  }
}

describe('CLIProcessManager config discovery', () => {
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...savedEnv }
    mockedApp.isPackaged = false
  })

  test('dev CLI spawn passes userData config and uses userData cwd', async () => {
    delete process.env.NODE_ENV
    delete process.env.OUROBOROS_CLI_PATH

    const manager = await createManager()
    const cliPath = manager.getCliPath()

    expect(cliPath.args).toContain('--json-rpc')
    expect(cliPath.args).toContain('--config')
    expect(cliPath.args[cliPath.args.indexOf('--config') + 1]).toBe('/tmp/ouroboros-user-data')
    expect(manager.getCliWorkingDirectory()).toBe('/tmp/ouroboros-user-data')
  })

  test('packaged CLI spawn also passes userData config', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.OUROBOROS_CLI_PATH
    mockedApp.isPackaged = true
    ;(process as unknown as { resourcesPath: string }).resourcesPath = '/tmp/ouroboros-resources'

    const manager = await createManager()
    const cliPath = manager.getCliPath()

    expect(cliPath.args).toEqual(['--json-rpc', '--config', '/tmp/ouroboros-user-data'])
    expect(manager.getCliWorkingDirectory()).toBe('/tmp/ouroboros-user-data')
  })
})
