import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

interface CliOptions {
  planPath: string
  scenarioPath?: string
  dialogResponsesPath?: string
  policyResponsesPath?: string
  outputDir?: string
  debugPort: number
  timeoutMs: number
  headed: boolean
  dryRun: boolean
  agentBrowserBin: string
  codexBin: string
  model?: string
}

interface RuntimePaths {
  runtimeDir: string
  scenarioPath: string
  dialogResponsesPath: string
  policyResponsesPath: string
  statePath: string
  mockLogPath: string
  installUpdateLogPath: string
  externalUrlLogPath: string
  openArtifactLogPath: string
  saveArtifactLogPath: string
  bootLogPath: string
  updateDownloadedPath: string
  userDataDir: string
}

interface CommandResult {
  command: string[]
  exitCode: number | null
  stdout: string
  stderr: string
}

interface IntentResult {
  verdict: Verdict
  summary: string
  artifacts: string[]
  command?: string[]
  exitCode?: number | null
  stdout?: string
  stderr?: string
}

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
const DEFAULT_DEBUG_PORT = 9222

export function repoRootFromScript(scriptUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(scriptUrl)), '../../..')
}

export function slugifyPlanName(planPath: string): string {
  const base = basename(planPath).replace(/\.[^.]+$/, '')
  const slug = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'intent-plan'
}

export function buildRunId(planPath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${slugifyPlanName(planPath)}`
}

export function parseArgs(args: string[]): CliOptions {
  let planPath = ''
  const options: CliOptions = {
    planPath,
    debugPort: Number(process.env.OUROBOROS_ELECTRON_DEBUG_PORT ?? DEFAULT_DEBUG_PORT),
    timeoutMs: Number(process.env.OUROBOROS_INTENT_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    headed: process.env.OUROBOROS_TEST_HIDE_WINDOW === '0',
    dryRun: false,
    agentBrowserBin: process.env.AGENT_BROWSER_BIN ?? 'agent-browser',
    codexBin: process.env.CODEX_BIN ?? 'codex',
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const next = (): string => {
      const value = args[i + 1]
      if (!value) throw new Error(`Missing value for ${arg}`)
      i += 1
      return value
    }

    switch (arg) {
      case '--scenario':
        options.scenarioPath = next()
        break
      case '--dialog-responses':
        options.dialogResponsesPath = next()
        break
      case '--policy-responses':
        options.policyResponsesPath = next()
        break
      case '--output-dir':
        options.outputDir = next()
        break
      case '--debug-port':
        options.debugPort = Number(next())
        break
      case '--timeout-ms':
        options.timeoutMs = Number(next())
        break
      case '--agent-browser-bin':
        options.agentBrowserBin = next()
        break
      case '--codex-bin':
        options.codexBin = next()
        break
      case '--model':
        options.model = next()
        break
      case '--headed':
        options.headed = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        throw new Error(usage())
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
        if (planPath) throw new Error(`Unexpected extra argument: ${arg}`)
        planPath = arg
        options.planPath = arg
    }
  }

  if (!options.planPath) throw new Error(usage())
  if (!Number.isInteger(options.debugPort) || options.debugPort <= 0) {
    throw new Error('--debug-port must be a positive integer')
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }

  return options
}

export function buildAgentPrompt(params: {
  planMarkdown: string
  planPath: string
  outputDir: string
  debugPort: number
  agentBrowserBin: string
  runtimePaths: RuntimePaths
}): string {
  return `You are running Ouroboros desktop intent E2E testing.

Use the ouroboros-intent-e2e skill.
Drive the already-launched Electron app using Agent Browser against CDP port ${params.debugPort}.
Follow the repo skill at .agents/skills/ouroboros-intent-e2e/SKILL.md.

Hard rules:
- Test only the running app. Do not inspect source code while executing this plan.
- Do not modify repo source files while executing the test.
- Start by loading current Agent Browser guidance: ${params.agentBrowserBin} skills get core and ${params.agentBrowserBin} skills get electron.
- Connect with: ${params.agentBrowserBin} connect ${params.debugPort}
- Use snapshot-act-snapshot discipline; refs become stale after UI changes.
- Capture screenshots, console output, and page errors into ${params.outputDir}.
- Write report.md, result.json, screenshots, console output, and page errors into ${params.outputDir}.
- Specifically write ${join(params.outputDir, 'report.md')} and ${join(params.outputDir, 'result.json')}.
- The result JSON must contain: verdict, summary, checks, bugs, artifacts, consoleErrors.
- verdict must be PASS, FAIL, or INCONCLUSIVE.
- Agent Browser is only the browser automation tool in this flow; do not use agent-browser chat.

Runtime files you may inspect for test evidence:
- mock CLI log: ${params.runtimePaths.mockLogPath}
- boot log: ${params.runtimePaths.bootLogPath}
- external URL log: ${params.runtimePaths.externalUrlLogPath}
- open artifact log: ${params.runtimePaths.openArtifactLogPath}
- save artifact log: ${params.runtimePaths.saveArtifactLogPath}

Test plan path: ${params.planPath}

${params.planMarkdown}
`
}

function usage(): string {
  return `Usage: bun run test:intent:e2e -- <test-plan.md> [options]

Options:
  --scenario <path>           JSON mock CLI scenario file
  --dialog-responses <path>   JSON dialog responses file
  --policy-responses <path>   JSON policy responses file
  --output-dir <path>         Artifact directory
  --debug-port <port>         Electron CDP port, default ${DEFAULT_DEBUG_PORT}
  --timeout-ms <ms>           Agent run timeout, default ${DEFAULT_TIMEOUT_MS}
  --agent-browser-bin <path>  agent-browser binary, default agent-browser
  --codex-bin <path>          Codex binary, default codex
  --model <name>              Model passed to Codex exec
  --headed                    Show Electron window
  --dry-run                   Prepare artifacts and prompt without launching`
}

async function createRuntimePaths(outputDir: string): Promise<RuntimePaths> {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'ouroboros-intent-e2e-'))
  return {
    runtimeDir,
    scenarioPath: join(runtimeDir, 'scenario.json'),
    dialogResponsesPath: join(runtimeDir, 'dialog-responses.json'),
    policyResponsesPath: join(runtimeDir, 'policy-responses.json'),
    statePath: join(runtimeDir, 'mock-state.json'),
    mockLogPath: join(outputDir, 'mock-cli.log'),
    installUpdateLogPath: join(outputDir, 'install-update.log'),
    externalUrlLogPath: join(outputDir, 'external-url.log'),
    openArtifactLogPath: join(outputDir, 'open-artifact.log'),
    saveArtifactLogPath: join(outputDir, 'save-artifact.log'),
    bootLogPath: join(outputDir, 'boot.log'),
    updateDownloadedPath: join(runtimeDir, 'update-downloaded.txt'),
    userDataDir: join(runtimeDir, 'user-data'),
  }
}

async function copyJsonOrDefault(
  sourcePath: string | undefined,
  destinationPath: string,
  fallback: unknown,
): Promise<void> {
  if (sourcePath) {
    await writeFile(destinationPath, await readFile(resolve(sourcePath), 'utf8'))
    return
  }
  await writeFile(destinationPath, `${JSON.stringify(fallback, null, 2)}\n`)
}

async function prepareRuntime(options: CliOptions, outputDir: string): Promise<RuntimePaths> {
  const paths = await createRuntimePaths(outputDir)
  await mkdir(paths.userDataDir, { recursive: true })
  await copyJsonOrDefault(options.scenarioPath, paths.scenarioPath, {})
  await copyJsonOrDefault(options.dialogResponsesPath, paths.dialogResponsesPath, [])
  await copyJsonOrDefault(options.policyResponsesPath, paths.policyResponsesPath, [])
  await writeFile(paths.updateDownloadedPath, '')
  return paths
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }

  throw new Error(`Timed out waiting for Electron CDP on port ${port}: ${lastError}`)
}

function launchElectron(params: {
  repoRoot: string
  runtimePaths: RuntimePaths
  debugPort: number
  headed: boolean
}): ChildProcess {
  const desktopDir = join(params.repoRoot, 'packages/desktop')
  const electronBin = join(desktopDir, 'node_modules/.bin/electron')
  const mainPath = join(desktopDir, 'out/main/index.js')

  if (!existsSync(mainPath)) {
    throw new Error(`Build output missing: ${mainPath}. Run bun run --filter @ouroboros/desktop build:vite`)
  }

  return spawn(
    electronBin,
    [
      mainPath,
      `--remote-debugging-port=${params.debugPort}`,
      '--enable-logging',
      `--log-file=${params.runtimePaths.bootLogPath}`,
    ],
    {
      cwd: desktopDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OUROBOROS_TEST_HIDE_WINDOW: params.headed ? '0' : '1',
        OUROBOROS_TEST_RUNTIME_DIR: params.runtimePaths.runtimeDir,
        OUROBOROS_TEST_SCENARIO_PATH: params.runtimePaths.scenarioPath,
        OUROBOROS_TEST_DIALOG_RESPONSES_PATH: params.runtimePaths.dialogResponsesPath,
        OUROBOROS_TEST_POLICY_RESPONSES_PATH: params.runtimePaths.policyResponsesPath,
        OUROBOROS_TEST_STATE_PATH: params.runtimePaths.statePath,
        OUROBOROS_TEST_MOCK_LOG_PATH: params.runtimePaths.mockLogPath,
        OUROBOROS_TEST_INSTALL_UPDATE_LOG_PATH: params.runtimePaths.installUpdateLogPath,
        OUROBOROS_TEST_EXTERNAL_URL_LOG_PATH: params.runtimePaths.externalUrlLogPath,
        OUROBOROS_TEST_OPEN_ARTIFACT_LOG_PATH: params.runtimePaths.openArtifactLogPath,
        OUROBOROS_TEST_SAVE_ARTIFACT_LOG_PATH: params.runtimePaths.saveArtifactLogPath,
        OUROBOROS_TEST_BOOT_LOG_PATH: params.runtimePaths.bootLogPath,
        OUROBOROS_TEST_UPDATE_DOWNLOADED_PATH: params.runtimePaths.updateDownloadedPath,
        OUROBOROS_TEST_USER_DATA_DIR: params.runtimePaths.userDataDir,
      },
    },
  )
}

async function runCommand(
  command: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<CommandResult> {
  const proc = spawn(command[0], command.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  proc.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  if (stdin != null) {
    proc.stdin?.end(stdin)
  } else {
    proc.stdin?.end()
  }

  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      rejectExit(new Error(`Command timed out after ${timeoutMs}ms: ${command.join(' ')}`))
    }, timeoutMs)

    proc.on('error', (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })

  return { command, exitCode, stdout, stderr }
}

export function buildCodexCommand(params: {
  codexBin: string
  repoRoot: string
  outputDir: string
  model?: string
}): string[] {
  const command = [
    params.codexBin,
    '--ask-for-approval',
    'never',
    'exec',
    '--cd',
    params.repoRoot,
    '--sandbox',
    'danger-full-access',
    '--output-last-message',
    join(params.outputDir, 'codex-final.md'),
  ]

  if (params.model) {
    command.push('--model', params.model)
  }

  command.push('-')
  return command
}

async function runCodex(params: {
  options: CliOptions
  promptPath: string
  outputDir: string
  repoRoot: string
}): Promise<IntentResult> {
  const prompt = await readFile(params.promptPath, 'utf8')
  const command = buildCodexCommand({
    codexBin: params.options.codexBin,
    repoRoot: params.repoRoot,
    outputDir: params.outputDir,
    model: params.options.model,
  })

  const result = await runCommand(command, params.options.timeoutMs, prompt)
  const transcriptPath = join(params.outputDir, 'codex-transcript.txt')
  await writeFile(
    transcriptPath,
    [
      `$ ${result.command.join(' ')}`,
      '',
      '--- stdout ---',
      result.stdout,
      '',
      '--- stderr ---',
      result.stderr,
    ].join('\n'),
  )

  return {
    verdict: result.exitCode === 0 ? 'PASS' : 'FAIL',
    summary:
      result.exitCode === 0
        ? 'Codex completed the intent plan.'
        : 'Codex exited with a non-zero status.',
    artifacts: [transcriptPath, join(params.outputDir, 'codex-final.md')],
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeFallbackResult(outputDir: string, result: IntentResult): Promise<void> {
  const resultPath = join(outputDir, 'result.json')
  const reportPath = join(outputDir, 'report.md')
  if (!(await pathExists(resultPath))) {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  }
  if (!(await pathExists(reportPath))) {
    await writeFile(
      reportPath,
      [
        '# Intent E2E Result',
        '',
        `Verdict: ${result.verdict}`,
        '',
        result.summary,
        '',
        '## Artifacts',
        '',
        ...result.artifacts.map((artifact) => `- ${artifact}`),
        '',
      ].join('\n'),
    )
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  const repoRoot = repoRootFromScript()
  const absolutePlanPath = isAbsolute(options.planPath)
    ? options.planPath
    : resolve(repoRoot, options.planPath)
  const planMarkdown = await readFile(absolutePlanPath, 'utf8')
  const runId = buildRunId(absolutePlanPath)
  const outputDir = resolve(
    repoRoot,
    options.outputDir ?? join('packages/desktop/test-results/intent-e2e', runId),
  )
  await mkdir(outputDir, { recursive: true })

  const runtimePaths = await prepareRuntime(options, outputDir)
  const prompt = buildAgentPrompt({
    planMarkdown,
    planPath: absolutePlanPath,
    outputDir,
    debugPort: options.debugPort,
    agentBrowserBin: options.agentBrowserBin,
    runtimePaths,
  })
  const promptPath = join(outputDir, 'prompt.md')
  await writeFile(promptPath, prompt)

  if (options.dryRun) {
    const result: IntentResult = {
      verdict: 'INCONCLUSIVE',
      summary: 'Dry run prepared runtime files and prompt without launching Electron.',
      artifacts: [promptPath, runtimePaths.scenarioPath],
    }
    await writeFallbackResult(outputDir, result)
    console.log(`Dry run complete: ${outputDir}`)
    return
  }

  let electronProc: ChildProcess | null = null
  try {
    electronProc = launchElectron({
      repoRoot,
      runtimePaths,
      debugPort: options.debugPort,
      headed: options.headed,
    })
    await waitForCdp(options.debugPort, 15_000)
    const result = await runCodex({ options, promptPath, outputDir, repoRoot })
    await writeFallbackResult(outputDir, result)
    console.log(`Intent E2E ${result.verdict}: ${outputDir}`)
    if (result.verdict === 'FAIL') process.exitCode = 1
  } finally {
    electronProc?.kill('SIGTERM')
    if (!process.env.OUROBOROS_INTENT_E2E_KEEP_RUNTIME) {
      await rm(runtimePaths.runtimeDir, { recursive: true, force: true })
    }
  }
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
