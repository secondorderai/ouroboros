/**
 * Crystallize Tool
 *
 * Exposes the full skill crystallization pipeline as a tool the agent can invoke.
 * Orchestrates: Reflect -> Generate -> Validate -> Test -> Promote.
 *
 * Takes a task summary and optionally a transcript, runs the full pipeline,
 * and returns a CrystallizationResult describing the outcome.
 */
import { z } from 'zod'
import { resolve } from 'node:path'
import { type Result, err } from '@src/types'
import type { TypedToolExecute } from './types'
import { crystallize, type CrystallizationResult } from '@src/rsi/crystallize'
import { createProvider } from '@src/llm/provider'
import { loadConfig } from '@src/config'

export const name = 'crystallize'

export const description =
  'Run the full skill crystallization pipeline: reflect on a completed task, ' +
  'generate a reusable skill, validate it, run tests, and promote it to the ' +
  'skill catalog. Returns the pipeline outcome (no-crystallization, generated, ' +
  'test-failed, or promoted).'

export const schema = z.object({
  taskSummary: z.string().describe('Summary of the completed task to crystallize into a skill'),
  transcript: z
    .string()
    .optional()
    .describe('Optional conversation transcript for richer reflection'),
})

export const execute: TypedToolExecute<typeof schema, CrystallizationResult> = async (
  args,
): Promise<Result<CrystallizationResult>> => {
  const { taskSummary, transcript } = args

  // Load config to get LLM provider and skill directories
  const configResult = loadConfig()
  if (!configResult.ok) {
    return err(new Error(`Failed to load config: ${configResult.error.message}`))
  }

  const config = configResult.value

  // Create LLM provider
  const providerResult = createProvider(config.model)
  if (!providerResult.ok) {
    return err(new Error(`Failed to create LLM provider: ${providerResult.error.message}`))
  }

  const llm = providerResult.value

  // Resolve skill directories
  const cwd = process.cwd()
  const skillDirs = {
    staging: resolve(cwd, 'skills/staging'),
    generated: resolve(cwd, 'skills/generated'),
    core: resolve(cwd, 'skills/core'),
  }

  return crystallize(taskSummary, {
    transcript,
    llm,
    skillDirs,
    noveltyThreshold: config.rsi.noveltyThreshold,
  })
}
