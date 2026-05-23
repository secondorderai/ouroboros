import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LanguageModel } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { OuroborosConfig } from '@src/config'
import type { ToolExecutionContext } from '@src/tools/types'
import {
  execute,
  setPostgresAnalyticsAdapter,
  validateReadOnlySql,
  type PostgresAdapter,
  type PostgresClient,
  type QueryResult,
} from '@src/tools/postgres-analytics'

function createMockModel(plan: Record<string, unknown>): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', id: 'plan', text: JSON.stringify(plan) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.close()
        },
      }),
      warnings: [],
    }),
  } as unknown as LanguageModel
}

function createStreamingFallbackModel(plan: Record<string, unknown>): LanguageModel {
  const text = JSON.stringify(plan)
  return {
    specificationVersion: 'v3',
    provider: 'openai-chatgpt.responses',
    modelId: 'gpt-5.5',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('Bad Request (status 400; {"detail":"Stream must be set to true"})')
    },
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'plan' })
          controller.enqueue({ type: 'text-delta', id: 'plan', delta: text })
          controller.enqueue({ type: 'text-end', id: 'plan' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 20, text: undefined, reasoning: undefined },
            },
          })
          controller.close()
        },
      }),
      warnings: [],
    }),
  } as unknown as LanguageModel
}

class MockClient implements PostgresClient {
  readonly queries: string[] = []
  released = false

  constructor(private readonly failOnAnalyticsQuery = false) {}

  async query(sql: string): Promise<QueryResult> {
    this.queries.push(sql)
    if (sql.includes('information_schema.columns')) {
      return {
        rows: [
          {
            table_schema: 'public',
            table_name: 'orders',
            column_name: 'status',
            data_type: 'text',
            is_nullable: 'NO',
          },
          {
            table_schema: 'public',
            table_name: 'orders',
            column_name: 'amount',
            data_type: 'numeric',
            is_nullable: 'NO',
          },
        ],
      }
    }
    if (sql.includes('information_schema.table_constraints')) {
      return { rows: [] }
    }
    if (sql.startsWith('SELECT * FROM (')) {
      if (this.failOnAnalyticsQuery) throw new Error('permission denied for table orders')
      return {
        rows: [
          { status: 'paid', total: 12 },
          { status: 'refunded', total: 3 },
        ],
        fields: [{ name: 'status' }, { name: 'total' }],
        rowCount: 2,
      }
    }
    return { rows: [] }
  }

  release(): void {
    this.released = true
  }
}

function makeAdapter(client: MockClient): PostgresAdapter {
  return {
    connect: async (connectionString) => {
      expect(connectionString).toBe('postgres://user:secret@example.test/db')
      return client
    },
  }
}

function makeConfig(): OuroborosConfig {
  return {
    analytics: {
      postgres: {
        connections: [
          {
            id: 'default',
            connectionStringEnv: 'TEST_POSTGRES_URL',
            defaultSchema: 'public',
            statementTimeoutMs: 5000,
            maxRows: 100,
          },
        ],
      },
    },
    artifacts: {
      cdnAllowlist: [
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
        'https://cdnjs.cloudflare.com',
      ],
      maxBytes: 1_048_576,
    },
  } as OuroborosConfig
}

function makeContext(basePath: string, sessionId: string | undefined, model: LanguageModel) {
  const emitted: unknown[] = []
  const context = {
    model,
    toolRegistry: undefined as never,
    config: makeConfig(),
    basePath,
    sessionId,
    agentId: 'test-agent',
    emitEvent: (event: unknown) => emitted.push(event),
  } as ToolExecutionContext
  return { context, emitted }
}

describe('postgres-analytics tool', () => {
  let basePath: string
  let savedPostgresUrl: string | undefined

  beforeEach(() => {
    basePath = join(
      tmpdir(),
      `ouroboros-postgres-analytics-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(basePath, { recursive: true })
    savedPostgresUrl = process.env.TEST_POSTGRES_URL
    process.env.TEST_POSTGRES_URL = 'postgres://user:secret@example.test/db'
  })

  afterEach(() => {
    rmSync(basePath, { recursive: true, force: true })
    if (savedPostgresUrl === undefined) delete process.env.TEST_POSTGRES_URL
    else process.env.TEST_POSTGRES_URL = savedPostgresUrl
    setPostgresAnalyticsAdapter(null)
  })

  test('validateReadOnlySql accepts safe SELECT and reports missing LIMIT', () => {
    const result = validateReadOnlySql(
      'SELECT status, count(*) FROM public.orders GROUP BY status',
      {
        maxRows: 50,
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings).toEqual([
      'Applied outer LIMIT 50 because generated SQL did not include one.',
    ])
  })

  test('validateReadOnlySql rejects writes, multiple statements, and unsafe functions', () => {
    expect(validateReadOnlySql('UPDATE public.orders SET status = status').ok).toBe(false)
    expect(validateReadOnlySql('SELECT 1; SELECT 2').ok).toBe(false)
    expect(validateReadOnlySql('SELECT pg_sleep(10)').ok).toBe(false)
  })

  test('validateReadOnlySql enforces allowTables', () => {
    const allowed = validateReadOnlySql('SELECT * FROM public.orders LIMIT 10', {
      maxRows: 10,
      allowTables: ['public.orders'],
    })
    const denied = validateReadOnlySql('SELECT * FROM public.payments LIMIT 10', {
      maxRows: 10,
      allowTables: ['public.orders'],
    })

    expect(allowed.ok).toBe(true)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.message).toContain('outside allowTables')
  })

  test('executes a natural-language analytics request through read-only transaction', async () => {
    const client = new MockClient()
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context } = makeContext(
      basePath,
      undefined,
      createMockModel({
        sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
        answer: 'Paid orders are the largest group.',
        visualization: 'none',
      }),
    )

    const result = await execute(
      {
        question: 'How many orders are in each status?',
        connectionId: 'default',
        visualization: 'none',
      },
      context,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.answer).toBe('Paid orders are the largest group.')
    expect(result.value.columns).toEqual(['status', 'total'])
    expect(result.value.rows).toEqual([
      { status: 'paid', total: 12 },
      { status: 'refunded', total: 3 },
    ])
    expect(result.value.artifact).toBeUndefined()
    expect(client.queries[0]).toBe('BEGIN READ ONLY')
    expect(client.queries).toContain("SET LOCAL statement_timeout = '5000ms'")
    expect(client.queries.at(-1)).toBe('COMMIT')
    expect(client.released).toBe(true)
  })

  test('creates an HTML artifact for visual analytics requests', async () => {
    const client = new MockClient()
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context, emitted } = makeContext(
      basePath,
      'sess-postgres-analytics',
      createMockModel({
        sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
        answer: 'Order status distribution.',
        title: 'Order Status Distribution',
        visualization: 'chart',
        chartType: 'bar',
      }),
    )

    const result = await execute(
      {
        question: 'Show a chart of order status distribution.',
        connectionId: 'default',
        visualization: 'chart',
      },
      context,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.artifact?.title).toBe('Order Status Distribution')
    expect(result.value.artifact?.path).toBeDefined()
    const artifactPath = result.value.artifact?.path ?? ''
    expect(existsSync(artifactPath)).toBe(true)
    const html = readFileSync(artifactPath, 'utf-8')
    expect(html).toContain('https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js')
    expect(html).not.toContain('chart.js')
    expect(html).toContain('echarts.init')
    expect(html).toContain('chart.setOption')
    expect(html).toContain('window.addEventListener')
    expect(html).toContain('aria-label')
    expect(html).toContain('Visual summary')
    expect(html).toContain('<table>')
    expect(html).toContain('SELECT status, count(*)::int AS total FROM public.orders')
    expect(result.value.artifact?.warnings).toEqual([])
    expect(emitted).toHaveLength(1)
  })

  test('table visualization skips ECharts initialization and keeps the table primary', async () => {
    const client = new MockClient()
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context } = makeContext(
      basePath,
      'sess-postgres-table',
      createMockModel({
        sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
        answer: 'Order status table.',
        title: 'Order Status Table',
        visualization: 'chart',
        chartType: 'table',
      }),
    )

    const result = await execute(
      {
        question: 'Show a table of order status distribution.',
        connectionId: 'default',
        visualization: 'chart',
      },
      context,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const html = readFileSync(result.value.artifact?.path ?? '', 'utf-8')
    expect(html).not.toContain('echarts.init')
    expect(html).not.toContain('chart.js')
    expect(html).toContain('Chart skipped because the selected visualization is a table.')
    expect(html).toContain('<table>')
  })

  test('heatmap and boxplot requests fall back to table with warnings when columns are insufficient', async () => {
    for (const chartType of ['heatmap', 'boxplot'] as const) {
      const client = new MockClient()
      setPostgresAnalyticsAdapter(makeAdapter(client))
      const { context } = makeContext(
        basePath,
        `sess-postgres-${chartType}`,
        createMockModel({
          sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
          answer: 'Order status distribution.',
          title: `Order Status ${chartType}`,
          visualization: 'chart',
          chartType,
        }),
      )

      const result = await execute(
        {
          question: `Show a ${chartType} of order status distribution.`,
          connectionId: 'default',
          visualization: 'chart',
        },
        context,
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.warnings.some((warning) => warning.includes(chartType))).toBe(true)
      const html = readFileSync(result.value.artifact?.path ?? '', 'utf-8')
      expect(html).not.toContain('echarts.init')
      expect(html).toContain('<table>')
      setPostgresAnalyticsAdapter(null)
    }
  })

  test('falls back to streaming plan generation when ChatGPT responses requires stream=true', async () => {
    const client = new MockClient()
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context } = makeContext(
      basePath,
      undefined,
      createStreamingFallbackModel({
        sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
        answer: 'Order status distribution.',
        visualization: 'none',
      }),
    )

    const result = await execute(
      {
        question: 'How many orders are in each status?',
        connectionId: 'default',
        visualization: 'none',
      },
      context,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.answer).toBe('Order status distribution.')
    expect(result.value.rows).toHaveLength(2)
    expect(client.queries.at(-1)).toBe('COMMIT')
  })

  test('rolls back and returns an error when the analytics query fails', async () => {
    const client = new MockClient(true)
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context } = makeContext(
      basePath,
      undefined,
      createMockModel({
        sql: 'SELECT status, count(*)::int AS total FROM public.orders GROUP BY status LIMIT 10',
        answer: 'Order status distribution.',
        visualization: 'none',
      }),
    )

    const result = await execute(
      {
        question: 'How many orders are in each status?',
        connectionId: 'default',
        visualization: 'none',
      },
      context,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('permission denied')
    expect(client.queries.at(-1)).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  test('rolls back when model-generated SQL fails validation', async () => {
    const client = new MockClient()
    setPostgresAnalyticsAdapter(makeAdapter(client))
    const { context } = makeContext(
      basePath,
      undefined,
      createMockModel({
        sql: 'DELETE FROM public.orders',
        answer: 'Unsafe request.',
        visualization: 'none',
      }),
    )

    const result = await execute(
      {
        question: 'Delete old orders',
        connectionId: 'default',
        visualization: 'none',
      },
      context,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('SELECT or WITH')
    expect(client.queries.at(-1)).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })
})
