import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { schema } from '@src/tools/ask-user'

// We mock readline.createInterface to test the execute function without
// actually reading from stdin.
const mockQuestion = mock()
const mockClose = mock()
const mockOn = mock()

mock.module('node:readline', () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: mockClose,
    on: mockOn,
  }),
}))

// Import execute AFTER mocking so it picks up the mock.
const { execute } = await import('@src/tools/ask-user')

describe('AskUserTool', () => {
  beforeEach(() => {
    mockQuestion.mockReset()
    mockClose.mockReset()
    mockOn.mockReset()
    // Default: mockOn does nothing (no error).
    mockOn.mockImplementation(() => {})
  })

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------
  test('schema requires question field', () => {
    expect(() => schema.parse({})).toThrow()
  })

  test('schema accepts question without options', () => {
    const parsed = schema.parse({ question: 'What?' })
    expect(parsed.question).toBe('What?')
    expect(parsed.options).toBeUndefined()
  })

  test('schema accepts question with options array', () => {
    const parsed = schema.parse({ question: 'Pick one', options: ['A', 'B'] })
    expect(parsed.options).toEqual(['A', 'B'])
  })

  test('schema rejects non-string question', () => {
    expect(() => schema.parse({ question: 42 })).toThrow()
  })

  // -----------------------------------------------------------------------
  // Execute: basic text input
  // -----------------------------------------------------------------------
  test('returns user text input', async () => {
    mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb('hello world')
    })

    const args = schema.parse({ question: 'What is your name?' })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.response).toBe('hello world')
    }
  })

  // -----------------------------------------------------------------------
  // Execute: numeric option selection
  // -----------------------------------------------------------------------
  test('maps numeric input to option (valid index)', async () => {
    mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb('2')
    })

    const args = schema.parse({ question: 'Pick:', options: ['Red', 'Green', 'Blue'] })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.response).toBe('Green')
    }
  })

  test('returns raw response for out-of-range numeric input', async () => {
    mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb('99')
    })

    const args = schema.parse({ question: 'Pick:', options: ['A', 'B'] })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.response).toBe('99')
    }
  })

  test('matches option text case-insensitively', async () => {
    mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb('green')
    })

    const args = schema.parse({ question: 'Pick:', options: ['Red', 'Green', 'Blue'] })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.response).toBe('Green')
    }
  })

  test('returns raw text when it does not match any option', async () => {
    mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb('purple')
    })

    const args = schema.parse({ question: 'Pick:', options: ['Red', 'Green'] })
    const result = await execute(args)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.response).toBe('purple')
    }
  })
})
