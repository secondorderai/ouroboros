import { type Result, err, ok } from '@src/types'

export type ParsedModelFlag = {
  provider: 'anthropic' | 'openai' | 'openai-compatible' | 'openai-chatgpt'
  name: string
}

export function parseModelFlag(value: string): Result<ParsedModelFlag> {
  const parts = value.split('/')

  if (parts.length === 1) {
    return ok({ provider: 'anthropic', name: parts[0] })
  }

  if (parts.length === 2) {
    const [providerStr, name] = parts
    const validProviders = ['anthropic', 'openai', 'openai-compatible', 'openai-chatgpt'] as const
    const provider = validProviders.find((candidate) => candidate === providerStr)

    if (!provider) {
      return err(
        new Error(
          `Invalid provider "${providerStr}" in --model flag. ` +
            `Valid providers: ${validProviders.join(', ')}. ` +
            'Usage: --model provider/model-name',
        ),
      )
    }

    return ok({ provider, name })
  }

  return err(new Error(`Invalid --model format: "${value}". Usage: --model provider/model-name`))
}
