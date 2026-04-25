import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TranscriptStore } from '@src/memory/transcripts'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-transcripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('Layer 3 — Session Transcripts', () => {
  let tempDir: string
  let store: TranscriptStore

  beforeEach(() => {
    tempDir = makeTempDir()
    const result = TranscriptStore.create(join(tempDir, 'transcripts.db'))
    if (!result.ok) throw new Error(`Setup failed: ${result.error.message}`)
    store = result.value
  })

  afterEach(() => {
    store.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('database auto-creation: file is created with correct schema', () => {
    const dbPath = join(tempDir, 'auto', 'created.db')
    const result = TranscriptStore.create(dbPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(dbPath)).toBe(true)
    result.value.close()
  })

  test('createSession returns a UUID', () => {
    const result = store.createSession()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // UUID format check
    expect(result.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('sessions persist workspace path metadata', () => {
    const workspace = join(tempDir, 'workspace')
    const createResult = store.createSession(workspace)
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    const getResult = store.getSession(createResult.value)
    expect(getResult.ok).toBe(true)
    if (!getResult.ok) return
    expect(getResult.value.workspacePath).toBe(workspace)

    const updatedWorkspace = join(tempDir, 'other-workspace')
    const updateResult = store.updateSessionWorkspace(createResult.value, updatedWorkspace)
    expect(updateResult.ok).toBe(true)

    const updatedResult = store.getSession(createResult.value)
    expect(updatedResult.ok).toBe(true)
    if (!updatedResult.ok) return
    expect(updatedResult.value.workspacePath).toBe(updatedWorkspace)

    const recentResult = store.getRecentSessions(10)
    expect(recentResult.ok).toBe(true)
    if (!recentResult.ok) return
    expect(recentResult.value[0].workspacePath).toBe(updatedWorkspace)
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

    const msg2 = store.addMessage(sessionId, {
      role: 'assistant',
      content: 'I am doing well, thanks!',
    })
    expect(msg2.ok).toBe(true)

    const msg3 = store.addMessage(sessionId, {
      role: 'tool-call',
      content: 'Calling search tool',
      toolName: 'search',
      toolArgs: { query: 'test' },
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
      content: 'I can help with the database migration strategy',
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

  test('opens databases created before subagent run persistence', () => {
    store.close()

    const dbPath = join(tempDir, 'legacy-transcripts.db')
    const legacyDb = new Database(dbPath)
    legacyDb.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT
      )
    `)
    legacyDb.run(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool-call', 'tool-result')),
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_args TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `)
    legacyDb
      .prepare('INSERT INTO sessions (id, started_at, summary) VALUES (?, ?, ?)')
      .run('legacy-session', '2026-01-01T00:00:00.000Z', 'Legacy session')
    legacyDb
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'legacy-message',
        'legacy-session',
        'user',
        'Hello from the old schema',
        '2026-01-01T00:00:01.000Z',
      )
    legacyDb.close()

    const legacyStore = new TranscriptStore(dbPath)
    store = legacyStore

    const sessions = legacyStore.getRecentSessions(10)
    expect(sessions.ok).toBe(true)
    if (!sessions.ok) return
    expect(sessions.value).toHaveLength(1)
    expect(sessions.value[0]).toMatchObject({
      id: 'legacy-session',
      summary: 'Legacy session',
      workspacePath: null,
      messageCount: 1,
    })

    const runs = legacyStore.getSubagentRunsForParent('legacy-session')
    expect(runs.ok).toBe(true)
    if (!runs.ok) return
    expect(runs.value).toEqual([])
  })

  test('per-message metadata round-trips through SQLite', () => {
    const created = store.createSession()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value

    const userId = store.addMessage(sessionId, { role: 'user', content: 'plan it' })
    expect(userId.ok).toBe(true)

    const assistantId = store.addMessage(sessionId, {
      role: 'assistant',
      content: 'Here is the plan.',
      metadata: { activatedSkills: ['meta-thinking', 'self-test'], extra: 42 },
    })
    expect(assistantId.ok).toBe(true)

    const loaded = store.getSession(sessionId)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const userMsg = loaded.value.messages.find((m) => m.role === 'user')
    expect(userMsg?.metadata).toBeNull()

    const assistantMsg = loaded.value.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.metadata).toEqual({
      activatedSkills: ['meta-thinking', 'self-test'],
      extra: 42,
    })
  })

  test('migrates pre-metadata databases by adding the metadata column', () => {
    store.close()

    const dbPath = join(tempDir, 'pre-metadata.db')
    const legacyDb = new Database(dbPath)
    legacyDb.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT
      )
    `)
    legacyDb.run(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool-call', 'tool-result')),
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_args TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `)
    legacyDb
      .prepare('INSERT INTO sessions (id, started_at, summary) VALUES (?, ?, ?)')
      .run('legacy', '2026-01-01T00:00:00.000Z', null)
    legacyDb
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m1', 'legacy', 'assistant', 'old reply', '2026-01-01T00:00:01.000Z')
    legacyDb.close()

    const upgraded = new TranscriptStore(dbPath)
    store = upgraded

    // Existing rows should hydrate with metadata=null and not crash.
    const loaded = upgraded.getSession('legacy')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.messages[0].metadata).toBeNull()

    // And we can write metadata against the upgraded schema.
    const created = upgraded.createSession()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value
    upgraded.addMessage(sessionId, {
      role: 'assistant',
      content: 'fresh reply',
      metadata: { activatedSkills: ['meta-thinking'] },
    })
    const fresh = upgraded.getSession(sessionId)
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.value.messages[0].metadata).toEqual({ activatedSkills: ['meta-thinking'] })
  })
})
