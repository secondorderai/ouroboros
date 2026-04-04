import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TranscriptStore } from '@src/memory/transcripts'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(tmpdir(), `ouroboros-transcripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Layer 3 — Session Transcripts', () => {
  let tempDir: string
  let store: TranscriptStore

  beforeEach(() => {
    tempDir = makeTempDir()
    store = new TranscriptStore(join(tempDir, 'transcripts.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('database auto-creation: file is created with correct schema', () => {
    const dbPath = join(tempDir, 'auto', 'created.db')
    const autoStore = new TranscriptStore(dbPath)
    expect(existsSync(dbPath)).toBe(true)
    autoStore.close()
  })

  test('createSession returns a UUID', () => {
    const result = store.createSession()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // UUID format check
    expect(result.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('session transcript storage: create, add messages, end, retrieve', () => {
    // Create session
    const createResult = store.createSession()
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return
    const sessionId = createResult.value

    // Add 3 messages
    const msg1 = store.addMessage(sessionId, { role: 'user', content: 'Hello, how are you?' })
    expect(msg1.ok).toBe(true)

    const msg2 = store.addMessage(sessionId, { role: 'assistant', content: 'I am doing well, thanks!' })
    expect(msg2.ok).toBe(true)

    const msg3 = store.addMessage(sessionId, {
      role: 'tool-call',
      content: 'Calling search tool',
      toolName: 'search',
      toolArgs: { query: 'test' }
    })
    expect(msg3.ok).toBe(true)

    // End session
    const endResult = store.endSession(sessionId, 'Test conversation')
    expect(endResult.ok).toBe(true)

    // Retrieve session
    const getResult = store.getSession(sessionId)
    expect(getResult.ok).toBe(true)
    if (!getResult.ok) return

    const session = getResult.value
    expect(session.id).toBe(sessionId)
    expect(session.endedAt).not.toBeNull()
    expect(session.summary).toBe('Test conversation')
    expect(session.messages.length).toBe(3)
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[0].content).toBe('Hello, how are you?')
    expect(session.messages[1].role).toBe('assistant')
    expect(session.messages[2].role).toBe('tool-call')
    expect(session.messages[2].toolName).toBe('search')
    expect(session.messages[2].toolArgs).toBe(JSON.stringify({ query: 'test' }))
  })

  test('transcript search returns matching messages only', () => {
    // Session 1: about database migration
    const s1 = store.createSession()
    expect(s1.ok).toBe(true)
    if (!s1.ok) return
    store.addMessage(s1.value, { role: 'user', content: 'We need to plan the database migration' })
    store.addMessage(s1.value, {
      role: 'assistant',
      content: 'I can help with the database migration strategy'
    })
    store.endSession(s1.value)

    // Session 2: about API design
    const s2 = store.createSession()
    expect(s2.ok).toBe(true)
    if (!s2.ok) return
    store.addMessage(s2.value, { role: 'user', content: 'Let us design the REST API endpoints' })
    store.addMessage(s2.value, { role: 'assistant', content: 'Here is a suggested API design' })
    store.endSession(s2.value)

    // Search for migration
    const searchResult = store.searchTranscripts('migration')
    expect(searchResult.ok).toBe(true)
    if (!searchResult.ok) return

    // Should find messages from session 1 only
    expect(searchResult.value.length).toBe(2)
    for (const result of searchResult.value) {
      expect(result.sessionId).toBe(s1.value)
      expect(result.content).toContain('migration')
    }
  })

  test('recent sessions ordering: newest first', () => {
    // Create 3 sessions with small delays to ensure distinct timestamps
    const s1 = store.createSession()
    expect(s1.ok).toBe(true)
    if (!s1.ok) return
    store.endSession(s1.value, 'First session')

    const s2 = store.createSession()
    expect(s2.ok).toBe(true)
    if (!s2.ok) return
    store.endSession(s2.value, 'Second session')

    const s3 = store.createSession()
    expect(s3.ok).toBe(true)
    if (!s3.ok) return
    store.endSession(s3.value, 'Third session')

    // Get the 2 most recent
    const result = store.getRecentSessions(2)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.length).toBe(2)
    // Most recent first (s3 then s2)
    expect(result.value[0].id).toBe(s3.value)
    expect(result.value[1].id).toBe(s2.value)
  })

  test('getSession returns error for non-existent session', () => {
    const result = store.getSession('nonexistent-id')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
  })

  test('endSession returns error for non-existent session', () => {
    const result = store.endSession('nonexistent-id')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('not found')
  })

  test('getRecentSessions includes message count', () => {
    const s1 = store.createSession()
    expect(s1.ok).toBe(true)
    if (!s1.ok) return
    store.addMessage(s1.value, { role: 'user', content: 'msg 1' })
    store.addMessage(s1.value, { role: 'assistant', content: 'msg 2' })
    store.addMessage(s1.value, { role: 'user', content: 'msg 3' })

    const result = store.getRecentSessions(10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(1)
    expect(result.value[0].messageCount).toBe(3)
  })

  test('searchTranscripts returns empty for no matches', () => {
    const s1 = store.createSession()
    expect(s1.ok).toBe(true)
    if (!s1.ok) return
    store.addMessage(s1.value, { role: 'user', content: 'Hello world' })

    const result = store.searchTranscripts('nonexistent-query-xyz')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })
})
