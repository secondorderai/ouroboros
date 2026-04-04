import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'file-edit'

export const description =
  'Edit a file by replacing an exact string match. The `oldString` must appear ' +
  'exactly once in the file; the operation fails if there are zero or multiple matches.'

export const schema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  oldString: z.string().describe('The exact string to find (must match exactly once)'),
  newString: z.string().describe('The replacement string'),
})

export interface FileEditResult {
  content: string
  path: string
}

export const execute: TypedToolExecute<typeof schema, FileEditResult> = async (
  args,
): Promise<Result<FileEditResult>> => {
  const { path, oldString, newString } = args

  if (!existsSync(path)) {
    return err(new Error(`File not found: ${path}`))
  }

  try {
    const content = readFileSync(path, 'utf-8')

    // Count occurrences of oldString.
    let count = 0
    let searchFrom = 0
    while (true) {
      const idx = content.indexOf(oldString, searchFrom)
      if (idx === -1) break
      count++
      searchFrom = idx + 1
    }

    if (count === 0) {
      return err(new Error(`No matches found for the provided oldString in "${path}"`))
    }
    if (count > 1) {
      return err(
        new Error(
          `Found ${count} matches for the provided oldString in "${path}". ` +
            'The oldString must match exactly once — provide more context to disambiguate.',
        ),
      )
    }

    const newContent = content.replace(oldString, newString)
    writeFileSync(path, newContent, 'utf-8')

    return ok({ content: newContent, path })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to edit file "${path}": ${message}`))
  }
}
