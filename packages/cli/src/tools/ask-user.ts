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

export type AskUserPromptHandler = (args: z.infer<typeof schema>) => Promise<Result<AskUserResult>>

let promptHandler: AskUserPromptHandler | null = null

export function setAskUserPromptHandler(handler: AskUserPromptHandler | null): void {
  promptHandler = handler
}

function normalizeResponse(response: string, options?: string[]): AskUserResult {
  if (options && options.length > 0) {
    const num = parseInt(response, 10)
    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return { response: options[num - 1] }
    }

    const match = options.find((o) => o.toLowerCase() === response.toLowerCase())
    if (match) {
      return { response: match }
    }
  }

  return { response }
}

async function readFromTerminal(args: z.infer<typeof schema>): Promise<Result<AskUserResult>> {
  const { question, options } = args

  try {
    let prompt = question
    if (options && options.length > 0) {
      const choices = options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n')
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

    return ok({ response: response.trim() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to read user input: ${message}`))
  }
}

export const execute: TypedToolExecute<typeof schema, AskUserResult> = async (
  args,
): Promise<Result<AskUserResult>> => {
  const result = promptHandler ? await promptHandler(args) : await readFromTerminal(args)
  if (!result.ok) return result
  return ok(normalizeResponse(result.value.response.trim(), args.options))
}
export const tier = 1
