import { afterEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

const expectedAgentBrowserBinary =
  process.platform === 'darwin' && process.arch === 'x64'
    ? 'agent-browser-darwin-x64'
    : process.platform === 'win32'
      ? 'agent-browser-win32-x64.exe'
      : process.platform === 'linux' && process.arch === 'arm64'
        ? 'agent-browser-linux-arm64'
        : process.platform === 'linux'
          ? 'agent-browser-linux-x64'
          : 'agent-browser-darwin-arm64'

async function createManager() {
  const { CLIProcessManager } = await import('../src/main/cli-process')
  return new CLIProcessManager({ onStdoutLine: () => {} }) as unknown as {
    getCliPath: () => { command: string; args: string[] }
    getCliWorkingDirectory: () => string
    getAgentBrowserDir: () => string
    getAgentBrowserBinPath: () => string
    getCliEnvironment: () => NodeJS.ProcessEnv
  }
}

async function createManagerWithCdp(port: number) {
  const { CLIProcessManager } = await import('../src/main/cli-process')
  return new CLIProcessManager({
    onStdoutLine: () => {},
    getAutomationBrowserCdpPort: () => port,
    getAutomationBrowserCdpStatePath: () => '/tmp/ouroboros-user-data/automation-browser-cdp.json',
  }) as unknown as {
    getCliEnvironment: () => NodeJS.ProcessEnv
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
    expect(manager.getAgentBrowserDir()).toBe('/tmp/ouroboros-desktop-app/resources/agent-browser')
    expect(manager.getAgentBrowserBinPath()).toBe(
      `/tmp/ouroboros-desktop-app/resources/agent-browser/bin/${expectedAgentBrowserBinary}`,
    )
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
    expect(manager.getAgentBrowserDir()).toBe('/tmp/ouroboros-resources/agent-browser')
    expect(manager.getAgentBrowserBinPath()).toBe(
      `/tmp/ouroboros-resources/agent-browser/bin/${expectedAgentBrowserBinary}`,
    )
  })

  test('CLI env includes bundled skill and Agent Browser paths', async () => {
    delete process.env.NODE_ENV
    process.env.PATH = '/usr/bin'

    const manager = await createManager()
    const env = manager.getCliEnvironment()

    expect(env.OUROBOROS_BUILTIN_SKILLS_DIR).toBe(
      '/tmp/ouroboros-desktop-app/resources/skills/builtin',
    )
    expect(env.OUROBOROS_AGENT_BROWSER_DIR).toBe(
      '/tmp/ouroboros-desktop-app/resources/agent-browser',
    )
    expect(env.OUROBOROS_AGENT_BROWSER_BIN).toBe(
      `/tmp/ouroboros-desktop-app/resources/agent-browser/bin/${expectedAgentBrowserBinary}`,
    )
    expect(env.PATH?.split(':')[0]).toBe('/tmp/ouroboros-desktop-app/resources/agent-browser/bin')
  })

  test('CLI env includes managed Automation Browser CDP port when running', async () => {
    delete process.env.NODE_ENV

    const manager = await createManagerWithCdp(9333)
    const env = manager.getCliEnvironment()

    expect(env.OUROBOROS_AGENT_BROWSER_CDP).toBe('9333')
    expect(env.OUROBOROS_AGENT_BROWSER_CDP_FILE).toBe(
      '/tmp/ouroboros-user-data/automation-browser-cdp.json',
    )
  })

  test('electron-builder packages Agent Browser resources', () => {
    const yml = readFileSync(resolve(import.meta.dir, '../electron-builder.yml'), 'utf-8')

    expect(yml).toContain('from: resources/agent-browser/')
    expect(yml).toContain('to: agent-browser/')
  })
})
