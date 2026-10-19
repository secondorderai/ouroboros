import { describe, expect, test } from 'bun:test'
import { getLocalReplResponse } from '@src/cli/repl'

describe('REPL help', () => {
  test('handles help and /help locally, without treating ordinary prompts as commands', () => {
    for (const input of ['help', '/help']) {
      const response = getLocalReplResponse(input)
      expect(response).toContain('Interactive commands')
      expect(response).toContain('auth login --provider openai-chatgpt')
    }
    expect(getLocalReplResponse('help me debug this')).toBeUndefined()
  })
})
