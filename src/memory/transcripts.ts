/**
 * Layer 3 — Session Transcripts
 *
 * SQLite-backed storage for session transcripts.
 * Uses bun:sqlite at runtime (Bun's built-in SQLite, API-compatible with better-sqlite3).
 * The ticket specifies better-sqlite3 but Bun does not support native addons;
 * bun:sqlite provides the same synchronous API and is the recommended replacement.
 *
 * Provides session lifecycle management and keyword search.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Result, ok, err } from '@src/types'

// ── Types ──────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool-call' | 'tool-result'

export interface TranscriptMessage {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  toolName: string | null
  toolArgs: string | null
  createdAt: string
}

export interface Session {
  id: string
  startedAt: string
  endedAt: string | null
  summary: string | null
}

export interface SessionWithMessages extends Session {
  messages: TranscriptMessage[]
}

export interface SessionSummary {
  id: string
  startedAt: string
  endedAt: string | null
  summary: string | null
  messageCount: number
}

export interface SearchResult {
  messageId: string
  sessionId: string
  role: MessageRole
  content: string
  toolName: string | null
  createdAt: string
  sessionStartedAt: string
}

export interface AddMessageInput {
  role: MessageRole
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
}

// ── Database initialization ────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool-call', 'tool-result')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_args TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
`

// ── Row types for bun:sqlite queries ───────────────────────────────

interface SessionRow {
  id: string
  started_at: string
  ended_at: string | null
  summary: string | null
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  tool_name: string | null
  tool_args: string | null
  created_at: string
}

interface SearchRow {
  message_id: string
  session_id: string
  role: string
  content: string
  tool_name: string | null
  created_at: string
  session_started_at: string
}

interface SessionSummaryRow {
  id: string
  started_at: string
  ended_at: string | null
  summary: string | null
  message_count: number
}

/**
 * TranscriptStore wraps a SQLite database for session transcript storage.
 * Create one instance per application lifecycle.
 */
export class TranscriptStore {
  private db: Database

  constructor(dbPath: string) {
    const absolutePath = resolve(dbPath)
    const dir = dirname(absolutePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(absolutePath)
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA foreign_keys = ON')
    this.db.run(SCHEMA_SQL)
  }

  /**
   * Create a new session and return its ID.
   */
  createSession(): Result<string> {
    try {
      const id = crypto.randomUUID()
      const startedAt = new Date().toISOString()
      this.db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(id, startedAt)
      return ok(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to create session: ${message}`))
    }
  }

  /**
   * Append a message to a session.
   */
  addMessage(sessionId: string, input: AddMessageInput): Result<string> {
    try {
      const id = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const toolArgs = input.toolArgs ? JSON.stringify(input.toolArgs) : null
      this.db
        .prepare(
          'INSERT INTO messages (id, session_id, role, content, tool_name, tool_args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, sessionId, input.role, input.content, input.toolName ?? null, toolArgs, createdAt)
      return ok(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to add message: ${message}`))
    }
  }

  /**
   * Mark a session as ended with an optional summary.
   */
  endSession(sessionId: string, summary?: string): Result<void> {
    try {
      const endedAt = new Date().toISOString()
      const result = this.db
        .prepare('UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?')
        .run(endedAt, summary ?? null, sessionId)
      if (result.changes === 0) {
        return err(new Error(`Session "${sessionId}" not found`))
      }
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to end session: ${message}`))
    }
  }

  /**
   * Retrieve a full session with all its messages.
   */
  getSession(sessionId: string): Result<SessionWithMessages> {
    try {
      const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | null

      if (!session) {
        return err(new Error(`Session "${sessionId}" not found`))
      }

      const rows = this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as MessageRow[]

      const messages: TranscriptMessage[] = rows.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        content: row.content,
        toolName: row.tool_name,
        toolArgs: row.tool_args,
        createdAt: row.created_at
      }))

      return ok({
        id: session.id,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        summary: session.summary,
        messages
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get session: ${message}`))
    }
  }

  /**
   * Keyword search across message content using LIKE.
   */
  searchTranscripts(query: string): Result<SearchResult[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id AS message_id, m.session_id, m.role, m.content, m.tool_name, m.created_at,
                  s.started_at AS session_started_at
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ?
           ORDER BY m.created_at DESC`
        )
        .all(`%${query}%`) as SearchRow[]

      const results: SearchResult[] = rows.map(row => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        content: row.content,
        toolName: row.tool_name,
        createdAt: row.created_at,
        sessionStartedAt: row.session_started_at
      }))

      return ok(results)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to search transcripts: ${message}`))
    }
  }

  /**
   * List recent sessions in reverse chronological order.
   */
  getRecentSessions(limit: number = 10): Result<SessionSummary[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.started_at, s.ended_at, s.summary,
                  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s
           ORDER BY s.started_at DESC, s.rowid DESC
           LIMIT ?`
        )
        .all(limit) as SessionSummaryRow[]

      const sessions: SessionSummary[] = rows.map(row => ({
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        summary: row.summary,
        messageCount: row.message_count
      }))

      return ok(sessions)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get recent sessions: ${message}`))
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }
}
