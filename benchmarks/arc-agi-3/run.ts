#!/usr/bin/env bun
/**
 * Thin CLI entry for the ARC-AGI-3 benchmark.
 *
 * Parses argv into ArcBenchOptions and delegates to runArcBenchmark in
 * ./src/runner. All orchestration logic lives in the runner so it can be
 * unit-tested without spawning processes.
 */
import { runArcBenchmark } from './src/runner'
import type { ArcBenchOptions } from './src/options'

const USAGE = `Usage: bun run run.ts [options]

Run ARC-AGI-3 games through the Ouroboros agent harness.

Options:
  --games <a,b,c>     Comma-separated game ids to run (e.g. ls20,ft09,vc33)
  --all               Run every game returned by GET /api/games
  --max-steps <n>     LLM-step budget per game (default: 80)
  --tags <a,b>        Comma-separated scorecard tags (default: ouroboros)
  --timeout-min <n>   Wall-clock timeout per game in minutes (default: 30)
  --reasoning-effort <level>
                      Model reasoning effort: minimal|low|medium|high|max
                      (default: high)
  --config <dir>      Use an existing config dir instead of a generated one
  --out <file>        Write results JSON to this file
  --help              Show this help

Exactly one of --games or --all is required.

Environment:
  ARC_API_KEY         Required. Register at https://three.arcprize.org
  ARC_BASE_URL        Optional API base URL override

Examples:
  ARC_API_KEY=... bun run bench -- --games ls20 --max-steps 30
  ARC_API_KEY=... bun run bench -- --games ls20,ft09,vc33 --max-steps 80
`

function fail(message: string): never {
  console.error(`Error: ${message}\n`)
  console.error(USAGE)
  process.exit(2)
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  if (value === undefined) fail(`${flag} requires a value`)
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${flag} must be a positive integer, got: ${value}`)
  }
  return n
}

function parseList(value: string | undefined, flag: string): string[] {
  if (value === undefined) fail(`${flag} requires a value`)
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (items.length === 0) fail(`${flag} requires a non-empty comma list`)
  return items
}

export function parseArgs(argv: string[]): ArcBenchOptions {
  let games: string[] | 'all' | undefined
  let maxSteps = 80
  let tags: string[] = ['ouroboros']
  let timeoutMin = 30
  let reasoningEffort = 'high'
  let configDir: string | undefined
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        console.log(USAGE)
        process.exit(0)
        break
      case '--games':
        if (games === 'all') fail('--games and --all are mutually exclusive')
        games = parseList(argv[++i], '--games')
        break
      case '--all':
        if (Array.isArray(games)) fail('--games and --all are mutually exclusive')
        games = 'all'
        break
      case '--max-steps':
        maxSteps = parsePositiveInt(argv[++i], '--max-steps')
        break
      case '--tags':
        tags = parseList(argv[++i], '--tags')
        break
      case '--timeout-min':
        timeoutMin = parsePositiveInt(argv[++i], '--timeout-min')
        break
      case '--reasoning-effort': {
        const value = argv[++i]
        const levels = ['minimal', 'low', 'medium', 'high', 'max']
        if (value === undefined || !levels.includes(value)) {
          fail(`--reasoning-effort must be one of ${levels.join('|')}, got: ${value}`)
        }
        reasoningEffort = value
        break
      }
      case '--config':
        configDir = argv[++i]
        if (configDir === undefined) fail('--config requires a value')
        break
      case '--out':
        out = argv[++i]
        if (out === undefined) fail('--out requires a value')
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  if (games === undefined) fail('one of --games or --all is required')

  return { games, maxSteps, tags, timeoutMin, reasoningEffort, configDir, out }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  const { exitCode } = await runArcBenchmark(options)
  process.exit(exitCode)
}
