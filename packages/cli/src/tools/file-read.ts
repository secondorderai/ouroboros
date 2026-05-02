import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'file-read'

export const description =
  'Read the contents of a file on disk. Supports optional line range ' +
  '(startLine / endLine, 1-based inclusive). Returns the content with line numbers.'

export const schema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('First line to return (1-based, inclusive)'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Last line to return (1-based, inclusive)'),
})

export interface FileReadResult {
  content: string
  lines: number
  path: string
}

export const execute: TypedToolExecute<typeof schema, FileReadResult> = async (
  args,
): Promise<Result<FileReadResult>> => {
  const { path, startLine, endLine } = args

  if (!existsSync(path)) {
    return err(new Error(`File not found: ${path}`))
  }

  try {
    const raw = readFileSync(path)

    // Simple binary detection: look for null bytes in the first 8KB.
    const sample = raw.subarray(0, 8192)
    if (sample.includes(0)) {
      return err(new Error(`Cannot read binary file: ${path}`))
    }

    const text = raw.toString('utf-8')
    const allLines = text.split('\n')

    const start = startLine ? Math.max(1, startLine) : 1
    const end = endLine ? Math.min(allLines.length, endLine) : allLines.length

    if (start > end) {
      return err(new Error(`Invalid line range: startLine (${start}) > endLine (${end})`))
    }

    // Slice is 0-based; our line numbers are 1-based.
    const selectedLines = allLines.slice(start - 1, end)

    const numbered = selectedLines.map((line, idx) => `${start + idx}\t${line}`).join('\n')

    return ok({
      content: numbered,
      lines: selectedLines.length,
      path,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read file "${path}": ${message}`))
  }
}
export const tier = 0
