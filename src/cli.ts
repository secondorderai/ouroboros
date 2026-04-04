#!/usr/bin/env bun

/**
 * Ouroboros CLI entry point.
 * This is a placeholder for Phase 1 — the full REPL and argument parsing
 * will be implemented in a subsequent ticket.
 */
import { loadConfig } from '@src/config'

function main() {
  const result = loadConfig()

  if (!result.ok) {
    console.error(result.error.message)
    process.exit(1)
  }

  console.log('Ouroboros v0.1.0')
  console.log(`Provider: ${result.value.model.provider}`)
  console.log(`Model: ${result.value.model.name}`)
}

main()
