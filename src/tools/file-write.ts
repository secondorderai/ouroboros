import { z } from 'zod'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'file-write'

export const description =
  'Create or overwrite a file with the given content. ' +
  'Parent directories are created automatically if they do not exist.'

export const schema = z.object({
  path: z.string().describe('Absolute or relative path to the file'),
  content: z.string().describe('Content to write to the file'),
})

export interface FileWriteResult {
  bytesWritten: number
  path: string
}

export const execute: TypedToolExecute<typeof schema, FileWriteResult> = async (
  args,
): Promise<Result<FileWriteResult>> => {
  const { path, content } = args

  try {
    // Ensure parent directory exists.
    mkdirSync(dirname(path), { recursive: true })

    writeFileSync(path, content, 'utf-8')

    return ok({
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
      path,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to write file "${path}": ${message}`))
  }
}
