#!/usr/bin/env bun

/**
 * Ouroboros CLI Entry Point
 *
 * Parses arguments with Commander.js and launches either:
 * - Interactive REPL (default, no arguments)
 * - Single-shot mode (piped input or `-m "prompt"`)
 *
 * CLI flags:
 *   --model <provider/model>  Override model selection
 *   --verbose / -v            Show tool call details
 *   --no-stream               Wait for full response before printing
 *   --config <path>           Path to directory containing .ouroboros config file
 */

import { Agent, type AgentEvent, type AgentEventHandler } from '@src/agent'
import { Renderer } from '@src/cli/renderer'
import { startRepl } from '@src/cli/repl'
import { createSingleShotHandler } from '@src/cli/single-shot'
import { loadConfig } from '@src/config'
import { createProvider } from '@src/llm/provider'
import { createRegistry } from '@src/tools/registry'
import { type Result, err, ok } from '@src/types'
import { Command } from 'commander'

// ── CLI program definition ──────────────────────────────────────────

const program = new Command()

program
  .name('ouroboros')
  .description('Ouroboros — a recursive self-improving AI agent')
  .version('0.1.0')
  .option('--model <model>', 'Override model selection (e.g., openai/gpt-5.4)')
  .option('-v, --verbose', 'Show tool call details (name, args, result)')
  .option('--no-stream', 'Wait for full response before printing')
  .option('--config <path>', 'Path to .ouroboros config file directory')
  .option('-m, --message <prompt>', 'Process a single prompt and exit')
  .option('--debug-tools', 'Print registered tool names and exit')

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  program.parse(process.argv)
  const opts = program.opts<{
    model?: string
    verbose?: boolean
    stream: boolean
    config?: string
    message?: string
    debugTools?: boolean
  }>()

  // Load config
  const configResult = loadConfig(opts.config)
  if (!configResult.ok) {
    process.stderr.write(`${configResult.error.message}\n`)
    process.exit(1)
  }

  let config = configResult.value

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

  const verbose = opts.verbose === true
  const noStream = !opts.stream

  // Create LLM provider
  const providerResult = createProvider(config.model)
  if (!providerResult.ok) {
    process.stderr.write(`${providerResult.error.message}\n`)
    process.exit(1)
  }

  // Create tool registry with built-in tools pre-registered
  const registry = await createRegistry()

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
  })

  // Determine mode: single-shot or interactive
  const prompt = await detectPrompt(opts.message)

  if (prompt !== null) {
    // Single-shot mode
    const { handler } = createSingleShotHandler({ verbose, noStream })
    currentHandler = handler

    try {
      const result = await agent.run(prompt)
      // Ensure output ends with a newline
      process.stdout.write('\n')
      process.exit(result.maxIterationsReached ? 1 : 0)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      process.stderr.write(`Fatal error: ${message}\n`)
      process.exit(1)
    }
  } else {
    // Interactive REPL mode
    const renderer = new Renderer({
      verbose,
      isTTY: process.stdout.isTTY === true,
    })

    renderer.writeBanner(config.model.provider, config.model.name)

    await startRepl({
      agent,
      verbose,
      setEventHandler: (handler: AgentEventHandler) => {
        currentHandler = handler
      },
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse the --model flag value.
 *
 * Accepted formats:
 *   "anthropic/claude-sonnet-4-20250514"  → provider=anthropic, name=claude-sonnet-4-20250514
 *   "openai/gpt-5.4"               → provider=openai, name=gpt-5.4
 *   "claude-sonnet-4-20250514"            → provider=anthropic (default), name=claude-sonnet-4-20250514
 */
function parseModelFlag(
  value: string,
): Result<{ provider: 'anthropic' | 'openai' | 'openai-compatible'; name: string }> {
  const parts = value.split('/')

  if (parts.length === 1) {
    // No provider prefix — use default
    return ok({ provider: 'anthropic', name: parts[0] })
  }

  if (parts.length === 2) {
    const [providerStr, name] = parts
    const validProviders = ['anthropic', 'openai', 'openai-compatible'] as const
    const provider = validProviders.find((p) => p === providerStr)

    if (!provider) {
      return err(
        new Error(
          `Invalid provider "${providerStr}" in --model flag. ` +
            `Valid providers: ${validProviders.join(', ')}. ` +
            `Usage: --model provider/model-name`,
        ),
      )
    }

    return ok({ provider, name })
  }

  return err(new Error(`Invalid --model format: "${value}". Usage: --model provider/model-name`))
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

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e)
  process.stderr.write(`Fatal error: ${message}\n`)
  process.exit(1)
})
