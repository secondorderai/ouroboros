import { z } from 'zod'
import { createInterface } from 'node:readline'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'ask-user'

export const description =
  'Prompt the user with a question in the terminal and wait for their response. ' +
  'Optionally provide a list of options for multiple choice.'

export const schema = z.object({
  question: z.string().describe('The question to ask the user'),
  options: z
    .array(z.string())
    .optional()
    .describe('Optional list of choices for multiple-choice questions'),
})

export interface AskUserResult {
  response: string
}

export const execute: TypedToolExecute<typeof schema, AskUserResult> = async (
  args,
): Promise<Result<AskUserResult>> => {
  const { question, options } = args

  try {
    let prompt = question
    if (options && options.length > 0) {
      const choices = options
        .map((opt, i) => `  ${i + 1}. ${opt}`)
        .join('\n')
      prompt = `${question}\n${choices}\n> `
    } else {
      prompt = `${question}\n> `
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const response = await new Promise<string>((resolve, reject) => {
      rl.question(prompt, (answer) => {
        rl.close()
        resolve(answer.trim())
      })
      rl.on('error', (error) => {
        rl.close()
        reject(error)
      })
    })

    // If options were provided, try to map numeric input to the option.
    if (options && options.length > 0) {
      const num = parseInt(response, 10)
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        return ok({ response: options[num - 1] })
      }
      // Accept the raw text if it matches an option (case-insensitive).
      const match = options.find(
        (o) => o.toLowerCase() === response.toLowerCase(),
      )
      if (match) {
        return ok({ response: match })
      }
      // Return raw response even if it doesn't match — the agent can decide.
    }

    return ok({ response })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read user input: ${message}`))
  }
}
