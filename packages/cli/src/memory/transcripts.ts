/**
 * Layer 3 — Session Transcripts
 *
 * SQLite-backed storage for session transcripts.
 * Uses bun:sqlite (Bun's built-in SQLite driver).
 *
 * Provides session lifecycle management and keyword search.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { llmUserContentToText, type LLMMessage } from '@src/llm/types'
import {
  createPermissionLease,
  type CreatePermissionLeaseInput,
  type PermissionLease,
} from '@src/permission-lease'
import type { TaskGraph } from '@src/team/task-graph'
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
  title: string | null
  titleSource: 'auto' | 'manual' | null
  workspacePath: string | null
}

export interface SessionWithMessages extends Session {
  messages: TranscriptMessage[]
}

export interface SessionSummary {
  id: string
  startedAt: string
  endedAt: string | null
  summary: string | null
  title: string | null
  titleSource: 'auto' | 'manual' | null
  messageCount: number
  workspacePath: string | null
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

export type SubagentRunStatus = 'completed' | 'failed'

export interface SubagentRun {
  id: string
  parentSessionId: string
  childSessionId: string
  agentId: string
  task: string
  status: SubagentRunStatus
  startedAt: string
  completedAt: string
  finalResult: string | null
  errorMessage: string | null
}

export interface AddSubagentRunInput {
  id?: string
  parentSessionId: string
  childSessionId: string
  agentId: string
  task: string
  status: SubagentRunStatus
  startedAt?: string
  completedAt?: string
  finalResult?: string | null
  errorMessage?: string | null
}

export interface AddPermissionLeaseInput extends CreatePermissionLeaseInput {}

// ── Database initialization ────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  title TEXT,
  title_source TEXT CHECK(title_source IN ('auto', 'manual')),
  workspace_path TEXT
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

CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  final_result TEXT,
  error_message TEXT,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_session_id ON subagent_runs(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_child_session_id ON subagent_runs(child_session_id);

CREATE TABLE IF NOT EXISTS permission_leases (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  allowed_paths TEXT NOT NULL,
  allowed_bash TEXT NOT NULL,
  max_tool_calls INTEGER,
  expires_at TEXT,
  approval_required INTEGER NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  denied_call_count INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT
);

	CREATE INDEX IF NOT EXISTS idx_permission_leases_agent_run_id ON permission_leases(agent_run_id);

	CREATE TABLE IF NOT EXISTS task_graphs (
	  id TEXT PRIMARY KEY,
	  graph_json TEXT NOT NULL,
	  status TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_task_graphs_updated_at ON task_graphs(updated_at);
	`

// ── Row types for bun:sqlite queries ───────────────────────────────

interface SessionRow {
  id: string
  started_at: string
  ended_at: string | null
  summary: string | null
  title?: string | null
  title_source?: string | null
  workspace_path?: string | null
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
  title?: string | null
  title_source?: string | null
  message_count: number
  workspace_path?: string | null
}

interface SubagentRunRow {
  id: string
  parent_session_id: string
  child_session_id: string
  agent_id: string
  task: string
  status: string
  started_at: string
  completed_at: string
  final_result: string | null
  error_message: string | null
}

interface PermissionLeaseRow {
  id: string
  agent_run_id: string
  allowed_tools: string
  allowed_paths: string
  allowed_bash: string
  max_tool_calls: number | null
  expires_at: string | null
  approval_required: number
  approved_at: string | null
  created_at: string
  tool_call_count: number
  denied_call_count: number
  last_event_at: string | null
}

interface TaskGraphRow {
  id: string
  graph_json: string
  status: string
  updated_at: string
}

/**
 * TranscriptStore wraps a SQLite database for session transcript storage.
 * Create one instance per application lifecycle.
 */
export class TranscriptStore {
  private db: Database

  /**
   * Recommended way to create a TranscriptStore.
   * Returns a Result instead of throwing on database errors.
   */
  static create(dbPath: string): Result<TranscriptStore> {
    try {
      return ok(new TranscriptStore(dbPath))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to initialize transcript database: ${message}`))
    }
  }

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
    this.migrateSchema()
  }

  private migrateSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'workspace_path')) {
      this.db.run('ALTER TABLE sessions ADD COLUMN workspace_path TEXT')
    }
    if (!columns.some((column) => column.name === 'title')) {
      this.db.run('ALTER TABLE sessions ADD COLUMN title TEXT')
    }
    if (!columns.some((column) => column.name === 'title_source')) {
      this.db.run(
        "ALTER TABLE sessions ADD COLUMN title_source TEXT CHECK(title_source IN ('auto', 'manual'))",
      )
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        final_result TEXT,
        error_message TEXT,
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `)
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_session_id ON subagent_runs(parent_session_id)',
    )
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_subagent_runs_child_session_id ON subagent_runs(child_session_id)',
    )

    this.db.run(`
      CREATE TABLE IF NOT EXISTS permission_leases (
        id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL,
        allowed_tools TEXT NOT NULL,
        allowed_paths TEXT NOT NULL,
        allowed_bash TEXT NOT NULL,
        max_tool_calls INTEGER,
        expires_at TEXT,
        approval_required INTEGER NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        denied_call_count INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT
      )
    `)
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_permission_leases_agent_run_id ON permission_leases(agent_run_id)',
    )

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_graphs (
        id TEXT PRIMARY KEY,
        graph_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_task_graphs_updated_at ON task_graphs(updated_at)')
  }

  /**
   * Create a new session and return its ID.
   */
  createSession(workspacePath?: string | null): Result<string> {
    try {
      const id = crypto.randomUUID()
      const startedAt = new Date().toISOString()
      this.db
        .prepare('INSERT INTO sessions (id, started_at, workspace_path) VALUES (?, ?, ?)')
        .run(id, startedAt, workspacePath ?? null)
      return ok(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to create session: ${message}`))
    }
  }

  /**
   * Update the workspace path associated with a session.
   */
  updateSessionWorkspace(sessionId: string, workspacePath: string | null): Result<void> {
    try {
      const result = this.db
        .prepare('UPDATE sessions SET workspace_path = ? WHERE id = ?')
        .run(workspacePath, sessionId)
      if (result.changes === 0) {
        return err(new Error(`Session "${sessionId}" not found`))
      }
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to update session workspace: ${message}`))
    }
  }

  /**
   * Update the human-visible title associated with a session.
   */
  updateSessionTitle(
    sessionId: string,
    title: string,
    source: 'auto' | 'manual' = 'auto',
  ): Result<void> {
    try {
      const cleanedTitle = title.trim()
      if (cleanedTitle.length === 0) {
        return err(new Error('Session title must be non-empty'))
      }
      const result = this.db
        .prepare('UPDATE sessions SET title = ?, title_source = ? WHERE id = ?')
        .run(cleanedTitle, source, sessionId)
      if (result.changes === 0) {
        return err(new Error(`Session "${sessionId}" not found`))
      }
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to update session title: ${message}`))
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
          'INSERT INTO messages (id, session_id, role, content, tool_name, tool_args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, sessionId, input.role, input.content, input.toolName ?? null, toolArgs, createdAt)
      return ok(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to add message: ${message}`))
    }
  }

  /**
   * Persist an LLM conversation into a session transcript.
   */
  addConversationMessages(sessionId: string, history: LLMMessage[]): Result<void> {
    for (const message of history) {
      if (message.role === 'system') {
        const addResult = this.addMessage(sessionId, {
          role: 'system',
          content: message.content,
        })
        if (!addResult.ok) return addResult
        continue
      }

      if (message.role === 'user') {
        const addResult = this.addMessage(sessionId, {
          role: 'user',
          content: llmUserContentToText(message.content),
        })
        if (!addResult.ok) return addResult
        continue
      }

      if (message.role === 'assistant') {
        if (message.content.trim().length > 0) {
          const addResult = this.addMessage(sessionId, {
            role: 'assistant',
            content: message.content,
          })
          if (!addResult.ok) return addResult
        }

        for (const toolCall of message.toolCalls ?? []) {
          const addResult = this.addMessage(sessionId, {
            role: 'tool-call',
            content: `${toolCall.toolName}: ${JSON.stringify(toolCall.input)}`,
            toolName: toolCall.toolName,
            toolArgs: toolCall.input,
          })
          if (!addResult.ok) return addResult
        }
        continue
      }

      for (const toolResult of message.content) {
        const addResult = this.addMessage(sessionId, {
          role: 'tool-result',
          content: JSON.stringify(toolResult.result),
          toolName: toolResult.toolName,
        })
        if (!addResult.ok) return addResult
      }
    }

    return ok(undefined)
  }

  /**
   * Persist metadata linking a child agent run to its parent session.
   */
  addSubagentRun(input: AddSubagentRunInput): Result<string> {
    try {
      const id = input.id ?? crypto.randomUUID()
      const completedAt = input.completedAt ?? new Date().toISOString()
      const startedAt = input.startedAt ?? completedAt
      this.db
        .prepare(
          `INSERT INTO subagent_runs (
             id, parent_session_id, child_session_id, agent_id, task, status,
             started_at, completed_at, final_result, error_message
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.parentSessionId,
          input.childSessionId,
          input.agentId,
          input.task,
          input.status,
          startedAt,
          completedAt,
          input.finalResult ?? null,
          input.errorMessage ?? null,
        )
      return ok(id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to add subagent run: ${message}`))
    }
  }

  /**
   * List child agent runs spawned from a parent session.
   */
  getSubagentRunsForParent(parentSessionId: string): Result<SubagentRun[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM subagent_runs
           WHERE parent_session_id = ?
           ORDER BY started_at ASC, rowid ASC`,
        )
        .all(parentSessionId) as SubagentRunRow[]

      return ok(rows.map(toSubagentRun))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get subagent runs: ${message}`))
    }
  }

  /**
   * Get the run record for a child session.
   */
  getSubagentRunForChild(childSessionId: string): Result<SubagentRun | null> {
    try {
      const row = this.db
        .prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?')
        .get(childSessionId) as SubagentRunRow | null

      return ok(row ? toSubagentRun(row) : null)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get subagent run: ${message}`))
    }
  }

  /**
   * Persist a permission lease for auditability.
   */
  addPermissionLease(input: AddPermissionLeaseInput): Result<string> {
    try {
      const lease = createPermissionLease(input)
      this.db
        .prepare(
          `INSERT INTO permission_leases (
             id, agent_run_id, allowed_tools, allowed_paths, allowed_bash,
             max_tool_calls, expires_at, approval_required, approved_at, created_at,
             tool_call_count, denied_call_count, last_event_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          lease.id,
          lease.agentRunId,
          JSON.stringify(lease.allowedTools),
          JSON.stringify(lease.allowedPaths),
          JSON.stringify(lease.allowedBash),
          lease.maxToolCalls ?? null,
          lease.expiresAt ?? null,
          lease.approvalRequired ? 1 : 0,
          lease.approvedAt ?? null,
          lease.createdAt,
          lease.toolCallCount,
          lease.deniedCallCount,
          null,
        )
      return ok(lease.id)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to add permission lease: ${message}`))
    }
  }

  /**
   * Increment the successful restricted tool call count for a lease.
   */
  recordPermissionLeaseToolCall(leaseId: string): Result<void> {
    return this.recordPermissionLeaseCounter(leaseId, 'tool_call_count')
  }

  /**
   * Increment the denied restricted tool call count for a lease.
   */
  recordPermissionLeaseDenial(leaseId: string): Result<void> {
    return this.recordPermissionLeaseCounter(leaseId, 'denied_call_count')
  }

  /**
   * List permission leases associated with a subagent run.
   */
  getPermissionLeasesForAgentRun(agentRunId: string): Result<PermissionLease[]> {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM permission_leases
           WHERE agent_run_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(agentRunId) as PermissionLeaseRow[]

      return ok(rows.map(toPermissionLease))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get permission leases: ${message}`))
    }
  }

  saveTaskGraph(graph: TaskGraph): Result<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO task_graphs (id, graph_json, status, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             graph_json = excluded.graph_json,
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .run(graph.id, JSON.stringify(graph), graph.status, graph.updatedAt)
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to save task graph: ${message}`))
    }
  }

  loadTaskGraph(graphId: string): Result<TaskGraph | null> {
    try {
      const row = this.db
        .prepare('SELECT * FROM task_graphs WHERE id = ?')
        .get(graphId) as TaskGraphRow | null
      if (!row) return ok(null)
      return parseTaskGraphRow(row)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to load task graph: ${message}`))
    }
  }

  deleteTaskGraph(graphId: string): Result<void> {
    try {
      this.db.prepare('DELETE FROM task_graphs WHERE id = ?').run(graphId)
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to delete task graph: ${message}`))
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
      const session = this.db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId) as SessionRow | null

      if (!session) {
        return err(new Error(`Session "${sessionId}" not found`))
      }

      const rows = this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(sessionId) as MessageRow[]

      const messages: TranscriptMessage[] = rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        content: row.content,
        toolName: row.tool_name,
        toolArgs: row.tool_args,
        createdAt: row.created_at,
      }))

      return ok({
        id: session.id,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        summary: session.summary,
        title: session.title ?? null,
        titleSource: normalizeTitleSource(session.title_source),
        workspacePath: session.workspace_path ?? null,
        messages,
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
      const escaped = query.replace(/[%_\\]/g, '\\$&')
      const rows = this.db
        .prepare(
          `SELECT m.id AS message_id, m.session_id, m.role, m.content, m.tool_name, m.created_at,
                  s.started_at AS session_started_at
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           WHERE m.content LIKE ? ESCAPE '\\'
           ORDER BY m.created_at DESC
           LIMIT 100`,
        )
        .all(`%${escaped}%`) as SearchRow[]

      const results: SearchResult[] = rows.map((row) => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        role: row.role as MessageRole,
        content: row.content,
        toolName: row.tool_name,
        createdAt: row.created_at,
        sessionStartedAt: row.session_started_at,
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
          `SELECT s.id, s.started_at, s.ended_at, s.summary, s.workspace_path,
                  s.title, s.title_source,
                  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
           FROM sessions s
           ORDER BY s.started_at DESC, s.rowid DESC
           LIMIT ?`,
        )
        .all(limit) as SessionSummaryRow[]

      const sessions: SessionSummary[] = rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        summary: row.summary,
        title: row.title ?? null,
        titleSource: normalizeTitleSource(row.title_source),
        messageCount: row.message_count,
        workspacePath: row.workspace_path ?? null,
      }))

      return ok(sessions)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to get recent sessions: ${message}`))
    }
  }

  /**
   * Delete a session and all its messages.
   */
  deleteSession(sessionId: string): Result<void> {
    try {
      // Delete dependent rows first for databases created before ON DELETE CASCADE.
      const runs = this.db
        .prepare('SELECT id FROM subagent_runs WHERE parent_session_id = ? OR child_session_id = ?')
        .all(sessionId, sessionId) as Array<{ id: string }>
      for (const run of runs) {
        this.db.prepare('DELETE FROM permission_leases WHERE agent_run_id = ?').run(run.id)
      }
      this.db
        .prepare('DELETE FROM subagent_runs WHERE parent_session_id = ? OR child_session_id = ?')
        .run(sessionId, sessionId)
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      if (result.changes === 0) {
        return err(new Error(`Session "${sessionId}" not found`))
      }
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to delete session: ${message}`))
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }

  private recordPermissionLeaseCounter(
    leaseId: string,
    column: 'tool_call_count' | 'denied_call_count',
  ): Result<void> {
    try {
      const result = this.db
        .prepare(
          `UPDATE permission_leases
           SET ${column} = ${column} + 1, last_event_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), leaseId)
      if (result.changes === 0) {
        return err(new Error(`Permission lease "${leaseId}" not found`))
      }
      return ok(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Failed to update permission lease: ${message}`))
    }
  }
}

function toSubagentRun(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    agentId: row.agent_id,
    task: row.task,
    status: row.status as SubagentRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    finalResult: row.final_result,
    errorMessage: row.error_message,
  }
}

function normalizeTitleSource(value: string | null | undefined): 'auto' | 'manual' | null {
  return value === 'auto' || value === 'manual' ? value : null
}

function toPermissionLease(row: PermissionLeaseRow): PermissionLease {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    allowedTools: parseJsonStringArray(row.allowed_tools),
    allowedPaths: parseJsonStringArray(row.allowed_paths),
    allowedBash: parseJsonStringArray(row.allowed_bash),
    ...(row.max_tool_calls !== null ? { maxToolCalls: row.max_tool_calls } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    approvalRequired: row.approval_required === 1,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    toolCallCount: row.tool_call_count,
    deniedCallCount: row.denied_call_count,
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseTaskGraphRow(row: TaskGraphRow): Result<TaskGraph> {
  try {
    const parsed = JSON.parse(row.graph_json) as TaskGraph
    return ok(parsed)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return err(new Error(`Failed to parse task graph "${row.id}": ${message}`))
  }
}
