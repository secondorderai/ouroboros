#!/usr/bin/env bun

/**
 * Ouroboros CLI Entry Point
 *
 * Parses arguments with Commander.js and launches either:
 * - Interactive REPL (default, no arguments)
 * - Single-shot mode (piped input or `-m "prompt"`)
 *
 * CLI flags:
 *   --model <provider/model>           Override model selection
 *   --reasoning-effort <effort>        Reasoning effort (minimal|low|medium|high|max)
 *   --verbose / -v                     Show tool call details
 *   --no-stream                        Wait for full response before printing
 *   --config <path>                    Path to directory containing .ouroboros config file
 *   --max-steps <steps>                Override autonomous step limit for this process
 */

import { Agent, type AgentEvent, type AgentEventHandler } from '@src/agent'
import { ModeManager, PLAN_MODE } from '@src/modes'
import { setModeManager as setEnterModeModeManager } from '@src/modes/tools/enter-mode'
import { setModeManager as setSubmitPlanModeManager } from '@src/modes/tools/submit-plan'
import { setModeManager as setExitModeModeManager } from '@src/modes/tools/exit-mode'
import { listAuth } from '@src/auth'
import {
  OpenAIChatGPTAuthManager,
  OPENAI_CHATGPT_AUTH_METHODS,
  OPENAI_CHATGPT_PROVIDER,
} from '@src/auth/openai-chatgpt'
import { Renderer } from '@src/cli/renderer'
import { parseModelFlag } from '@src/cli/model-flag'
import { startRepl } from '@src/cli/repl'
import { createRSIEventHandler, writeRSIEvent } from '@src/cli/rsi-output'
import { createSingleShotHandler } from '@src/cli/single-shot'
import { loadConfig, resolveConfigDir, type OuroborosConfig } from '@src/config'
import { startJsonRpcServer } from '@src/json-rpc/server'
import { createProvider } from '@src/llm/provider'
import { activateSkillForRun, resolveSlashSkillInvocation } from '@src/skills/skill-invocation'
import { createRegistry } from '@src/tools/registry'
import { McpManager } from '@src/mcp/manager'
import { RSIOrchestrator } from '@src/rsi/orchestrator'
import type { RSIEvent } from '@src/rsi/types'
import { TranscriptStore } from '@src/memory/transcripts'
import { resolve as resolvePath } from 'node:path'
import { Command } from 'commander'

// ── CLI program definition ──────────────────────────────────────────

const program = new Command()

program
  .name('ouroboros')
  .description('Ouroboros — a recursive self-improving AI agent')
  .version('0.1.0')
  .option('--model <model>', 'Override model selection (e.g., openai/gpt-5.4)')
  .option(
    '--reasoning-effort <effort>',
    'Reasoning effort (minimal|low|medium|high|max). Maps to Anthropic adaptive thinking on Claude 4.6+ or to OpenAI reasoning_effort on o-series and GPT-5. Ignored for unsupported models.',
  )
  .option('-v, --verbose', 'Show tool call details (name, args, result)')
  .option('--no-stream', 'Wait for full response before printing')
  .option('--config <path>', 'Path to .ouroboros config file directory')
  .option('--max-steps <steps>', 'Override autonomous step limit for this process')
  .option('-m, --message <prompt>', 'Process a single prompt and exit')
  .option('--debug-tools', 'Print registered tool names and exit')
  .option('--no-rsi', 'Disable all RSI (self-improvement) hooks')
  .option('--json-rpc', 'Start in JSON-RPC 2.0 server mode (stdin/stdout)')
  .option('--plan', 'Enter plan mode for the first message')
  .action(runMain)

const authCommand = program.command('auth').description('Manage provider authentication')

authCommand.command('list').description('List stored provider authentication').action(runAuthList)

authCommand
  .command('login')
  .description('Log in to a provider')
  .option('--provider <provider>', 'Provider to authenticate', OPENAI_CHATGPT_PROVIDER)
  .option('--method <method>', 'Login method: browser or headless', 'browser')
  .action(runAuthLogin)

authCommand
  .command('logout')
  .description('Remove stored provider authentication')
  .option('--provider <provider>', 'Provider to remove', OPENAI_CHATGPT_PROVIDER)
  .action(runAuthLogout)

// ── Dream subcommand ────────────────────────────────────────────────

program
  .command('dream')
  .description('Manually trigger the dream cycle (memory consolidation)')
  .option('--mode <mode>', 'Dream mode: consolidate-only or full', 'consolidate-only')
  .option('--config <path>', 'Path to .ouroboros config file directory')
  .action(async (dreamOpts: { mode?: string; config?: string }) => {
    const configResult = loadConfig(dreamOpts.config)
    if (!configResult.ok) {
      process.stderr.write(`${configResult.error.message}\n`)
      process.exit(1)
    }

    const config = configResult.value
    const configDir = resolveConfigDir(dreamOpts.config)
    const providerResult = createProvider(config.model)
    if (!providerResult.ok) {
      process.stderr.write(`${providerResult.error.message}\n`)
      process.exit(1)
    }

    process.stdout.write('[RSI] Starting dream cycle...\n')

    // Open the transcript store so the dream cycle can analyze recent
    // sessions in 'full' / 'propose-only' modes. Failure is non-fatal —
    // we fall back to structured-memory consolidation only and warn the user.
    const dbPath = resolvePath(configDir, '.ouroboros-transcripts.db')
    const transcriptStoreResult = TranscriptStore.create(dbPath)
    let transcriptStore: TranscriptStore | undefined
    if (transcriptStoreResult.ok) {
      transcriptStore = transcriptStoreResult.value
    } else {
      process.stderr.write(
        `[RSI] Warning: transcript store unavailable, transcript analysis will be skipped: ${transcriptStoreResult.error.message}\n`,
      )
    }

    const orchestrator = new RSIOrchestrator({
      config,
      llm: providerResult.value,
      onEvent: (event: RSIEvent) => {
        writeRSIEvent(event)
      },
      ...(transcriptStore ? { transcriptStore } : {}),
    })

    const mode = dreamOpts.mode === 'full' ? 'full' : 'consolidate-only'
    const result = await orchestrator.triggerDream({ mode: mode as 'consolidate-only' | 'full' })

    if (result.ok) {
      process.stdout.write(
        `[RSI] Dream complete: ${result.value.topicsMerged} merged, ${result.value.topicsCreated} created\n`,
      )
      process.exit(0)
    } else {
      process.stderr.write(`[RSI] Dream failed: ${result.error.message}\n`)
      process.exit(1)
    }
  })

// ── Main ─────────────────────────────────────────────────────────────

async function runMain(): Promise<void> {
  const opts = program.opts<{
    model?: string
    reasoningEffort?: string
    verbose?: boolean
    stream: boolean
    config?: string
    maxSteps?: string
    message?: string
    debugTools?: boolean
    rsi: boolean
    jsonRpc?: boolean
    plan?: boolean
  }>()

  // Load config
  const configResult = loadConfig(opts.config)
  if (!configResult.ok) {
    process.stderr.write(`${configResult.error.message}\n`)
    process.exit(1)
  }

  let config = configResult.value
  const maxStepsOverride = parseMaxStepsFlag(opts.maxSteps)
  if (maxStepsOverride instanceof Error) {
    process.stderr.write(`${maxStepsOverride.message}\n`)
    process.exit(1)
  }

  // Apply --model override
  if (opts.model) {
    const parseResult = parseModelFlag(opts.model)
    if (!parseResult.ok) {
      process.stderr.write(`${parseResult.error.message}\n`)
      process.exit(1)
    }
    config = {
      ...config,
      model: {
        ...config.model,
        provider: parseResult.value.provider,
        name: parseResult.value.name,
      },
    }
  }

  // Apply --reasoning-effort override
  if (opts.reasoningEffort !== undefined) {
    const validEfforts = ['minimal', 'low', 'medium', 'high', 'max'] as const
    type Effort = (typeof validEfforts)[number]
    if (!validEfforts.includes(opts.reasoningEffort as Effort)) {
      process.stderr.write(
        `Invalid --reasoning-effort "${opts.reasoningEffort}". Valid values: ${validEfforts.join(', ')}.\n`,
      )
      process.exit(1)
    }
    config = {
      ...config,
      model: { ...config.model, reasoningEffort: opts.reasoningEffort as Effort },
    }
  }

  // ── JSON-RPC server mode ───────────────────────────────────────────
  // Must branch early — the server creates its own provider, registry,
  // and manages its own Agent lifecycle.
  if (opts.jsonRpc === true) {
    const configDir = resolveConfigDir(opts.config)
    await startJsonRpcServer({ config, configDir, maxStepsOverride })
    // startJsonRpcServer runs indefinitely — this line is never reached.
    return
  }

  const verbose = opts.verbose === true
  const noStream = !opts.stream
  const prompt = await detectPrompt(opts.message)
  const configDir = resolveConfigDir(opts.config)

  // Create LLM provider
  const providerResult = createProvider(config.model)
  if (!providerResult.ok) {
    process.stderr.write(`${providerResult.error.message}\n`)
    process.exit(1)
  }

  // Create tool registry with built-in tools pre-registered
  const registry = await createRegistry()

  // Connect any MCP servers configured in .ouroboros and register their tools.
  const mcpManager = new McpManager({
    config: config.mcp,
    registry,
    log: (message) => {
      if (verbose) process.stderr.write(`${message}\n`)
    },
  })
  await mcpManager.start()
  const stopMcp = (): void => {
    void mcpManager.stop()
  }
  process.once('SIGTERM', stopMcp)
  process.once('SIGINT', stopMcp)
  process.once('beforeExit', stopMcp)

  if (opts.debugTools === true) {
    const toolNames = registry
      .getTools()
      .map((tool) => tool.name)
      .sort()
    process.stdout.write(`${toolNames.length} tools registered\n`)
    for (const name of toolNames) {
      process.stdout.write(`- ${name}\n`)
    }
    process.exit(0)
  }

  // Create ModeManager and register plan mode
  const modeManager = new ModeManager((event) => {
    eventProxy({ ...event } as AgentEvent)
  })
  modeManager.registerMode(PLAN_MODE)

  // Wire ModeManager into mode tools
  setEnterModeModeManager(modeManager)
  setSubmitPlanModeManager(modeManager)
  setExitModeModeManager(modeManager)

  // Create RSI orchestrator (lazily — only if RSI is enabled)
  const rsiEnabled = opts.rsi !== false
  let rsiOrchestrator: RSIOrchestrator | undefined
  let handleRSIEvent = createRSIEventHandler(prompt !== null)
  if (rsiEnabled) {
    rsiOrchestrator = new RSIOrchestrator({
      config,
      llm: providerResult.value,
      onEvent: (event: RSIEvent) => {
        handleRSIEvent(event)
      },
    })
  }

  // Create a mutable event dispatch target.
  // The Agent stores `onEvent` at construction time, so we use a proxy
  // that forwards to whatever handler is currently set.
  let currentHandler: AgentEventHandler = () => {}
  const eventProxy: AgentEventHandler = (event: AgentEvent) => {
    currentHandler(event)
  }

  // Create agent
  const agent = new Agent({
    model: providerResult.value,
    toolRegistry: registry,
    onEvent: eventProxy,
    config,
    basePath: configDir,
    rsiOrchestrator,
    modeManager,
  })

  if (prompt !== null) {
    // Single-shot mode
    handleRSIEvent = createRSIEventHandler(true)
    const { handler } = createSingleShotHandler({ verbose, noStream })
    currentHandler = handler

    const parsedPrompt = parseSingleShotPrompt(prompt, config, configDir)
    if (!parsedPrompt.ok) {
      process.stderr.write(`${parsedPrompt.error.message}\n`)
      process.exit(1)
    }

    const skillActivation = parsedPrompt.value.skillName
      ? await activateSkillForRun(parsedPrompt.value.skillName, config, configDir)
      : undefined
    if (skillActivation && !skillActivation.ok) {
      process.stderr.write(`${skillActivation.error.message}\n`)
      process.exit(1)
    }

    // If --plan flag is set, prepend plan mode trigger
    const effectivePrompt =
      opts.plan && !parsedPrompt.value.planMode
        ? `[User requests plan mode] ${parsedPrompt.value.message}`
        : parsedPrompt.value.message

    try {
      const result = await agent.run(effectivePrompt, {
        runProfile: 'singleShot',
        maxSteps: maxStepsOverride,
        activatedSkill: skillActivation?.value,
      })
      // Ensure output ends with a newline
      process.stdout.write('\n')
      process.exit(result.stopReason === 'max_steps' ? 1 : 0)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      process.stderr.write(`Fatal error: ${message}\n`)
      process.exit(1)
    }
  } else {
    // Interactive REPL mode
    handleRSIEvent = createRSIEventHandler(false)
    const renderer = new Renderer({
      verbose,
      isTTY: process.stdout.isTTY === true,
    })

    renderer.writeBanner(config.model.provider, config.model.name)

    await startRepl({
      agent,
      verbose,
      maxSteps: maxStepsOverride,
      config,
      basePath: configDir,
      setEventHandler: (handler: AgentEventHandler) => {
        currentHandler = handler
      },
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseMaxStepsFlag(value: string | undefined): number | undefined | Error {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return new Error('--max-steps must be a positive integer')
  }

  return parsed
}

type ParsedPromptResult =
  | { ok: true; value: { message: string; skillName?: string; planMode?: boolean } }
  | { ok: false; error: Error }

function parseSingleShotPrompt(
  prompt: string,
  config: OuroborosConfig,
  basePath: string,
): ParsedPromptResult {
  const trimmed = prompt.trimStart()
  if (/^\/plan(?:\s|$)/.test(trimmed)) {
    const planMessage = trimmed.slice(5).trim()
    if (!planMessage) {
      return { ok: false, error: new Error('Usage: /plan <task description>') }
    }
    return {
      ok: true,
      value: { message: `[User requests plan mode] ${planMessage}`, planMode: true },
    }
  }

  return resolveSlashSkillInvocation(prompt, config, basePath)
}

/**
 * Parse the --model flag value.
 *
 * Accepted formats:
 *   "anthropic/claude-sonnet-4-20250514"  → provider=anthropic, name=claude-sonnet-4-20250514
 *   "openai/gpt-5.4"               → provider=openai, name=gpt-5.4
 *   "claude-sonnet-4-20250514"            → provider=anthropic (default), name=claude-sonnet-4-20250514
 */
async function runAuthList(): Promise<void> {
  const configDir = resolveConfigDir()
  const authResult = listAuth(configDir)
  if (!authResult.ok) {
    process.stderr.write(`${authResult.error.message}\n`)
    process.exit(1)
  }

  const entries = Object.entries(authResult.value)
  if (entries.length === 0) {
    process.stdout.write('No stored provider authentication.\n')
    return
  }

  for (const [provider, info] of entries) {
    const account = info.accountId ? ` account=${info.accountId}` : ''
    process.stdout.write(`${provider} type=${info.type}${account}\n`)
  }
}

async function runAuthLogin(options: { provider?: string; method?: string }): Promise<void> {
  const provider = options.provider ?? OPENAI_CHATGPT_PROVIDER
  if (provider !== OPENAI_CHATGPT_PROVIDER) {
    process.stderr.write(`Unsupported auth provider "${provider}".\n`)
    process.exit(1)
  }

  const method = (options.method ?? 'browser').toLowerCase()
  if (
    !OPENAI_CHATGPT_AUTH_METHODS.includes(method as (typeof OPENAI_CHATGPT_AUTH_METHODS)[number])
  ) {
    process.stderr.write(`Unsupported auth method "${method}". Use browser or headless.\n`)
    process.exit(1)
  }

  const manager = new OpenAIChatGPTAuthManager()
  const startResult = await manager.startLogin(
    method as (typeof OPENAI_CHATGPT_AUTH_METHODS)[number],
  )
  if (!startResult.ok) {
    process.stderr.write(`${startResult.error.message}\n`)
    process.exit(1)
  }

  process.stdout.write(`${startResult.value.instructions}\n${startResult.value.url}\n`)
  if (startResult.value.method === 'browser') {
    const openResult = await manager.openStartedFlow(startResult.value)
    if (!openResult.ok) {
      process.stderr.write(`${openResult.error.message}\n`)
      process.stderr.write(`Open this URL manually:\n${startResult.value.url}\n`)
    }
  }

  const waitResult = await manager.waitForCompletion(startResult.value.flowId)
  if (!waitResult.ok) {
    process.stderr.write(`${waitResult.error.message}\n`)
    process.exit(1)
  }

  if (!waitResult.value.success) {
    process.stderr.write(`${waitResult.value.error ?? 'Authentication failed'}\n`)
    process.exit(1)
  }

  const account = waitResult.value.accountId ? ` (account ${waitResult.value.accountId})` : ''
  process.stdout.write(`ChatGPT subscription login successful${account}.\n`)
}

async function runAuthLogout(options: { provider?: string }): Promise<void> {
  const provider = options.provider ?? OPENAI_CHATGPT_PROVIDER
  if (provider !== OPENAI_CHATGPT_PROVIDER) {
    process.stderr.write(`Unsupported auth provider "${provider}".\n`)
    process.exit(1)
  }

  const manager = new OpenAIChatGPTAuthManager()
  const result = await manager.logout()
  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`)
    process.exit(1)
  }

  process.stdout.write(`Removed stored authentication for ${provider}.\n`)
}

/**
 * Detect the prompt for single-shot mode.
 *
 * Returns the prompt string if in single-shot mode, or null for interactive mode.
 *
 * Single-shot is triggered by:
 * 1. `-m "prompt"` flag
 * 2. Piped stdin (stdin is not a TTY)
 */
async function detectPrompt(messageFlag?: string): Promise<string | null> {
  // Explicit -m flag takes priority
  if (messageFlag) {
    return messageFlag
  }

  // Check for piped stdin
  if (!process.stdin.isTTY) {
    return readStdin()
  }

  // No prompt detected — interactive mode
  return null
}

/**
 * Read all of stdin into a string (for piped input).
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []

  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim())
    })

    process.stdin.on('error', reject)
  })
}

// ── Entry point ─────────────────────────────────────────────────────

// Bun compiled binaries use the same 2-prefix argv format as Node
// (process.argv = ["bun", "/$bunfs/root/<name>", ...userArgs]), so
// the default Commander.js `from: 'node'` works for both dev and prod.
program.parseAsync(process.argv).catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  process.stderr.write(`Fatal error: ${message}\n`)
  process.exit(1)
})
