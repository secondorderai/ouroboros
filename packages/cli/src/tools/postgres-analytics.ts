import { Pool, type PoolClient, type QueryResult as PgQueryResult } from 'pg'
import { z } from 'zod'
import { generateResponse, streamResponse } from '@src/llm/streaming'
import type { LLMCallOptions, LLMMessage } from '@src/llm/types'
import { type Result, err, ok } from '@src/types'
import type { OuroborosConfig } from '@src/config'
import type { ToolExecutionContext, TypedToolExecute } from './types'
import {
  execute as createArtifact,
  schema as createArtifactSchema,
  type CreateArtifactResult,
} from './create-artifact'

export const name = 'postgres-analytics'

export const description =
  'Answer natural-language analytics questions against a configured PostgreSQL database. ' +
  'The tool is read-only: it introspects schema, generates and validates a safe SELECT/WITH query, ' +
  'runs it in a read-only transaction with row and timeout limits, and can create HTML dashboard artifacts. ' +
  'Do not use it for writes, migrations, cleanup, permissions, maintenance, or admin operations.'

export const schema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .describe('Natural-language analytics question or visual request.'),
  connectionId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .default('default')
    .describe('Configured analytics.postgres connection id. Defaults to default.'),
  visualization: z
    .enum(['auto', 'none', 'chart', 'diagram', 'infographic', 'dashboard'])
    .optional()
    .default('auto')
    .describe('Requested visual output. Use auto unless the user explicitly asks for a format.'),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe('Optional row cap, further bounded by connection config.'),
})

const analysisPlanSchema = z.object({
  sql: z.string().min(1),
  answer: z.string().min(1).optional(),
  title: z.string().min(1).max(120).optional(),
  visualization: z
    .enum(['none', 'chart', 'diagram', 'infographic', 'dashboard'])
    .optional()
    .default('none'),
  chartType: z
    .enum(['bar', 'line', 'pie', 'scatter', 'table', 'histogram', 'boxplot', 'heatmap'])
    .optional(),
  rationale: z.string().optional(),
})

type AnalyticsChartType = z.infer<typeof analysisPlanSchema>['chartType'] extends infer T
  ? Exclude<T, undefined>
  : never

export interface PostgresAnalyticsResult {
  answer: string
  sql: string
  executedSql: string
  rowCount: number
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
  warnings: string[]
  artifact?: CreateArtifactResult
}

export interface SqlValidationResult {
  sql: string
  warnings: string[]
}

interface QueryField {
  name: string
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  fields?: QueryField[]
  rowCount?: number | null
}

export interface PostgresClient {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  release(): void | Promise<void>
}

export interface PostgresAdapter {
  connect(connectionString: string): Promise<PostgresClient>
}

interface TableColumn {
  schema: string
  table: string
  column: string
  dataType: string
  nullable: boolean
}

interface ForeignKey {
  schema: string
  table: string
  column: string
  foreignSchema: string
  foreignTable: string
  foreignColumn: string
}

interface SchemaSnapshot {
  columns: TableColumn[]
  foreignKeys: ForeignKey[]
}

interface ResolvedConnection {
  id: string
  connectionString: string
  defaultSchema: string
  statementTimeoutMs: number
  maxRows: number
  allowTables?: string[]
}

class PgAdapter implements PostgresAdapter {
  async connect(connectionString: string): Promise<PostgresClient> {
    const pool = new Pool({ connectionString })
    const client = await pool.connect()
    return new PooledClient(client, pool)
  }
}

class PooledClient implements PostgresClient {
  constructor(
    private readonly client: PoolClient,
    private readonly pool: Pool,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const result = (await this.client.query(sql, params)) as PgQueryResult<Record<string, unknown>>
    return {
      rows: result.rows,
      fields: result.fields.map((field) => ({ name: field.name })),
      rowCount: result.rowCount,
    }
  }

  async release(): Promise<void> {
    this.client.release()
    await this.pool.end()
  }
}

let adapter: PostgresAdapter = new PgAdapter()

export function setPostgresAnalyticsAdapter(nextAdapter: PostgresAdapter | null): void {
  adapter = nextAdapter ?? new PgAdapter()
}

export function validateReadOnlySql(
  inputSql: string,
  options: { maxRows: number; allowTables?: string[] } = { maxRows: 500 },
): Result<SqlValidationResult> {
  const sql = inputSql.trim()
  if (!sql) return err(new Error('Generated SQL is empty.'))
  if (sql.includes(';')) {
    return err(new Error('Generated SQL must contain exactly one statement and no semicolons.'))
  }

  const uncommented = stripSqlComments(sql)
  const normalized = uncommented.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!/^(select|with)\b/.test(normalized)) {
    return err(new Error('Generated SQL must start with SELECT or WITH.'))
  }

  const forbidden =
    /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|begin|commit|rollback|vacuum|analyze|refresh|reindex|cluster|listen|notify|set|reset)\b/
  if (forbidden.test(normalized)) {
    return err(
      new Error('Generated SQL contains a forbidden write, admin, or transaction keyword.'),
    )
  }

  const unsafeFunction =
    /\b(pg_sleep|dblink|lo_import|lo_export|pg_read_file|pg_ls_dir|pg_stat_file|pg_logdir_ls|pg_reload_conf|pg_terminate_backend|pg_cancel_backend|set_config)\s*\(/i
  if (unsafeFunction.test(uncommented)) {
    return err(new Error('Generated SQL calls a forbidden PostgreSQL function.'))
  }

  if (options.allowTables && options.allowTables.length > 0) {
    const allowed = new Set(options.allowTables.map(normalizeRelationName))
    for (const relation of extractReferencedRelations(uncommented)) {
      const normalizedRelation = normalizeRelationName(relation)
      const shortName = normalizedRelation.split('.').at(-1) ?? normalizedRelation
      if (!allowed.has(normalizedRelation) && !allowed.has(shortName)) {
        return err(new Error(`Generated SQL references table "${relation}" outside allowTables.`))
      }
    }
  }

  const warnings: string[] = []
  if (!/\blimit\s+\d+\b/i.test(uncommented)) {
    warnings.push(
      `Applied outer LIMIT ${options.maxRows} because generated SQL did not include one.`,
    )
  }

  return ok({ sql, warnings })
}

export const execute: TypedToolExecute<typeof schema, PostgresAnalyticsResult> = async (
  args,
  context,
) => {
  if (!context?.model) return err(new Error('postgres-analytics requires an active model context.'))

  const connectionResult = resolveConnection(context.config, args.connectionId)
  if (!connectionResult.ok) return connectionResult
  const connection = connectionResult.value
  const maxRows = Math.min(args.maxRows ?? connection.maxRows, connection.maxRows)

  let client: PostgresClient | undefined
  let transactionStarted = false
  try {
    client = await adapter.connect(connection.connectionString)
    await client.query('BEGIN READ ONLY')
    transactionStarted = true
    await client.query(`SET LOCAL statement_timeout = '${connection.statementTimeoutMs}ms'`)

    const snapshot = await introspectSchema(client, connection)
    const planResult = await generateAnalysisPlan({
      context,
      question: args.question,
      requestedVisualization: args.visualization,
      snapshot,
      maxRows,
    })
    if (!planResult.ok) {
      await client.query('ROLLBACK').catch(() => {})
      transactionStarted = false
      return planResult
    }
    const plan = planResult.value

    const validation = validateReadOnlySql(plan.sql, {
      maxRows,
      allowTables: connection.allowTables,
    })
    if (!validation.ok) {
      await client.query('ROLLBACK').catch(() => {})
      transactionStarted = false
      return validation
    }

    const executedSql = `SELECT * FROM (${validation.value.sql}) AS ouroboros_analytics_result LIMIT ${maxRows}`
    const queryResult = await client.query(executedSql)
    await client.query('COMMIT')
    transactionStarted = false

    const rows = normalizeRows(queryResult.rows).slice(0, maxRows)
    const columns = queryResult.fields?.map((field) => field.name) ?? inferColumns(rows)
    const truncated = (queryResult.rowCount ?? rows.length) > rows.length
    const warnings = [...validation.value.warnings]
    const answer = buildAnswer(plan.answer, args.question, rows, columns)
    const artifactResult = await maybeCreateArtifact({
      args,
      context,
      title: plan.title ?? titleFromQuestion(args.question),
      answer,
      sql: validation.value.sql,
      rows,
      columns,
      chartType: plan.chartType ?? inferChartType(rows, columns),
      visualization: plan.visualization,
      warnings,
    })
    if (!artifactResult.ok) return artifactResult

    return ok({
      answer,
      sql: validation.value.sql,
      executedSql,
      rowCount: rows.length,
      columns,
      rows,
      truncated,
      warnings,
      ...(artifactResult.value ? { artifact: artifactResult.value } : {}),
    })
  } catch (error) {
    if (client && transactionStarted) {
      await client.query('ROLLBACK').catch(() => {})
    }
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`PostgreSQL analytics query failed: ${message}`))
  } finally {
    await client?.release()
  }
}

function resolveConnection(
  config: OuroborosConfig,
  connectionId: string,
): Result<ResolvedConnection> {
  const connections = config.analytics.postgres.connections
  const connection = connections.find((candidate) => candidate.id === connectionId)
  if (!connection) {
    return err(
      new Error(
        `No PostgreSQL analytics connection "${connectionId}" is configured in analytics.postgres.connections.`,
      ),
    )
  }

  const connectionString = process.env[connection.connectionStringEnv]
  if (!connectionString) {
    return err(
      new Error(
        `Environment variable ${connection.connectionStringEnv} is required for PostgreSQL analytics connection "${connectionId}".`,
      ),
    )
  }

  return ok({
    id: connection.id,
    connectionString,
    defaultSchema: connection.defaultSchema,
    statementTimeoutMs: connection.statementTimeoutMs,
    maxRows: connection.maxRows,
    allowTables: connection.allowTables,
  })
}

async function introspectSchema(
  client: PostgresClient,
  connection: ResolvedConnection,
): Promise<SchemaSnapshot> {
  const columnResult = await client.query(
    `
      SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_schema, table_name, ordinal_position
    `,
    [connection.defaultSchema],
  )
  const fkResult = await client.query(
    `
      SELECT
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
      ORDER BY tc.table_schema, tc.table_name, kcu.column_name
    `,
    [connection.defaultSchema],
  )

  return {
    columns: columnResult.rows.map((row) => ({
      schema: stringValue(row.table_schema),
      table: stringValue(row.table_name),
      column: stringValue(row.column_name),
      dataType: stringValue(row.data_type),
      nullable: stringValue(row.is_nullable) === 'YES',
    })),
    foreignKeys: fkResult.rows.map((row) => ({
      schema: stringValue(row.table_schema),
      table: stringValue(row.table_name),
      column: stringValue(row.column_name),
      foreignSchema: stringValue(row.foreign_table_schema),
      foreignTable: stringValue(row.foreign_table_name),
      foreignColumn: stringValue(row.foreign_column_name),
    })),
  }
}

async function generateAnalysisPlan(input: {
  context: ToolExecutionContext
  question: string
  requestedVisualization: string
  snapshot: SchemaSnapshot
  maxRows: number
}): Promise<Result<z.infer<typeof analysisPlanSchema>>> {
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content:
        'You generate safe PostgreSQL analytics SQL. Return only JSON. ' +
        'The SQL must be one read-only SELECT or WITH query. Do not include semicolons. ' +
        'Do not write data, change settings, call admin functions, or use transaction statements. ' +
        `Prefer LIMIT ${input.maxRows} or lower. Use only tables and columns present in the schema snapshot.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: input.question,
        requestedVisualization: input.requestedVisualization,
        schema: summarizeSchema(input.snapshot),
        responseShape: {
          sql: 'SELECT ...',
          answer: 'brief plain-English interpretation',
          title: 'short artifact title',
          visualization: 'none|chart|diagram|infographic|dashboard',
          chartType: 'bar|line|pie|scatter|table|histogram|boxplot|heatmap',
          rationale: 'why this query answers the question',
        },
      }),
    },
  ]

  const generated = await generatePlanText(input.context.model, messages, {
    temperature: 0.1,
    maxTokens: 2500,
    abortSignal: input.context.abortSignal,
  })
  if (!generated.ok) return generated

  const parsedJson = parseJsonObject(generated.value)
  if (!parsedJson.ok) return parsedJson
  const parsedPlan = analysisPlanSchema.safeParse(parsedJson.value)
  if (!parsedPlan.success) {
    const issues = parsedPlan.error.issues.map((issue) => issue.message).join('; ')
    return err(new Error(`Model returned an invalid PostgreSQL analytics plan: ${issues}`))
  }

  return ok(parsedPlan.data)
}

async function generatePlanText(
  model: ToolExecutionContext['model'],
  messages: LLMMessage[],
  options: LLMCallOptions,
): Promise<Result<string>> {
  const generated = await generateResponse(model, messages, options)
  if (generated.ok) return ok(generated.value.text)
  if (!isStreamRequiredError(generated.error)) return generated

  const streamed = streamResponse(model, messages, options)
  if (!streamed.ok) return streamed

  let text = ''
  for await (const chunk of streamed.value.stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.textDelta
    } else if (chunk.type === 'error') {
      return err(chunk.error)
    }
  }

  return ok(text)
}

function isStreamRequiredError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes('stream must be set to true')
}

function parseJsonObject(text: string): Result<unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return err(new Error('Model did not return a JSON object for PostgreSQL analytics.'))
  }

  try {
    return ok(JSON.parse(text.slice(start, end + 1)) as unknown)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return err(new Error(`Failed to parse PostgreSQL analytics plan JSON: ${message}`))
  }
}

async function maybeCreateArtifact(input: {
  args: z.infer<typeof schema>
  context: ToolExecutionContext
  title: string
  answer: string
  sql: string
  rows: Record<string, unknown>[]
  columns: string[]
  chartType: AnalyticsChartType
  visualization: 'none' | 'chart' | 'diagram' | 'infographic' | 'dashboard'
  warnings: string[]
}): Promise<Result<CreateArtifactResult | undefined>> {
  const requested = input.args.visualization
  const shouldCreate =
    requested !== 'none' &&
    (requested !== 'auto' || input.visualization !== 'none' || input.rows.length > 0)
  if (!shouldCreate) return ok(undefined)
  if (!input.context.sessionId) {
    input.warnings.push('Skipped visual artifact because no active session is available.')
    return ok(undefined)
  }

  const html = buildArtifactHtml(input)
  const artifact = await createArtifact(
    createArtifactSchema.parse({
      title: input.title,
      description: input.answer.slice(0, 500),
      html,
    }),
    input.context,
  )
  return artifact
}

function buildArtifactHtml(input: {
  title: string
  answer: string
  sql: string
  rows: Record<string, unknown>[]
  columns: string[]
  chartType: AnalyticsChartType
  warnings: string[]
}): string {
  const chartPlan = buildChartPlan(input)
  const tableHead = input.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')
  const tableRows = input.rows
    .map(
      (row) =>
        `<tr>${input.columns
          .map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  const chartScript = chartPlan.option
    ? `
      const chart = echarts.init(document.getElementById('chart'));
      chart.setOption(${safeJson(chartPlan.option)});
      window.addEventListener('resize', () => chart.resize());`
    : ''

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)}</title>
    ${chartPlan.option ? '<script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>' : ''}
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f7f7f4; color: #1f2428; }
      main { max-width: 1120px; margin: 0 auto; padding: 32px; }
      h1 { font-size: 30px; line-height: 1.15; margin: 0 0 10px; }
      p { margin: 0 0 22px; color: #4b5359; }
      h2 { font-size: 15px; line-height: 1.2; margin: 0 0 8px; }
      .grid { display: grid; grid-template-columns: ${chartPlan.option ? 'minmax(0, 1.1fr) minmax(320px, .9fr)' : '1fr'}; gap: 24px; align-items: start; }
      .panel { background: #ffffff; border: 1px solid #d9ddd8; border-radius: 8px; padding: 20px; }
      .chart-wrap { height: 360px; min-height: 360px; }
      .fallback-note { color: #667078; font-size: 13px; margin: 0; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #e6e8e4; vertical-align: top; }
      th { color: #374047; background: #f1f3ef; font-weight: 650; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #202427; color: #f2f5f1; border-radius: 8px; padding: 14px; font-size: 12px; }
      @media (max-width: 780px) { main { padding: 20px; } .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.answer)}</p>
      <div class="grid">
        ${
          chartPlan.option
            ? `<section class="panel" aria-labelledby="chart-title" aria-describedby="chart-description">
          <h2 id="chart-title">Visual summary</h2>
          <p id="chart-description">${escapeHtml(chartPlan.description)}</p>
          <div id="chart" class="chart-wrap" role="img" aria-label="${escapeHtml(chartPlan.description)}">Chart fallback: ${escapeHtml(chartPlan.description)}</div>
        </section>`
            : `<section class="panel" aria-labelledby="data-title">
          <h2 id="data-title">Data table</h2>
          <p class="fallback-note">${escapeHtml(chartPlan.description)}</p>
        </section>`
        }
        <section class="panel">
          <table>
            <thead><tr>${tableHead}</tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </section>
      </div>
      <section class="panel" style="margin-top:24px">
        <pre>${escapeHtml(input.sql)}</pre>
      </section>
    </main>
    <script>
      ${chartScript}
    </script>
  </body>
</html>`
}

interface ChartPlan {
  option?: Record<string, unknown>
  description: string
}

interface ChartInput {
  title: string
  rows: Record<string, unknown>[]
  columns: string[]
  chartType: AnalyticsChartType
  warnings: string[]
}

function buildChartPlan(input: ChartInput): ChartPlan {
  if (input.chartType === 'table') {
    return { description: 'Chart skipped because the selected visualization is a table.' }
  }
  if (input.rows.length === 0 || input.columns.length === 0) {
    return { description: 'No rows are available to chart; review the data table.' }
  }

  switch (input.chartType) {
    case 'pie':
      return buildPieChartPlan(input)
    case 'scatter':
      return buildScatterChartPlan(input)
    case 'histogram':
      return buildAxisChartPlan(input, 'bar', 'Histogram buckets')
    case 'boxplot':
      return buildBoxplotChartPlan(input)
    case 'heatmap':
      return buildHeatmapChartPlan(input)
    case 'line':
      return buildAxisChartPlan(input, 'line', 'Line chart')
    case 'bar':
    default:
      return buildAxisChartPlan(input, 'bar', 'Bar chart')
  }
}

function buildAxisChartPlan(
  input: ChartInput,
  seriesType: 'bar' | 'line',
  label: string,
): ChartPlan {
  const labelColumn = input.columns[0]
  const numericColumn = findNumericColumns(input.rows, input.columns)[0]
  if (!numericColumn)
    return fallbackChartPlan(input, `${label} requires at least one numeric column.`)

  const labels = input.rows.map((row, index) => String(row[labelColumn] ?? index + 1))
  const data = input.rows.map((row) => Number(row[numericColumn] ?? 0))
  const description = `${label} showing ${numericColumn} across ${labelColumn}.`
  return {
    description,
    option: baseChartOption(input.title, description, {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value' },
      series: [{ name: numericColumn, type: seriesType, data }],
    }),
  }
}

function buildPieChartPlan(input: ChartInput): ChartPlan {
  const labelColumn = input.columns[0]
  const numericColumn = findNumericColumns(input.rows, input.columns)[0]
  if (!numericColumn)
    return fallbackChartPlan(input, 'Pie chart requires at least one numeric column.')

  const data = input.rows.map((row, index) => ({
    name: String(row[labelColumn] ?? index + 1),
    value: Number(row[numericColumn] ?? 0),
  }))
  const description = `Pie chart showing ${numericColumn} by ${labelColumn}.`
  return {
    description,
    option: baseChartOption(input.title, description, {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, type: 'scroll' },
      series: [{ name: numericColumn, type: 'pie', radius: ['35%', '70%'], data }],
    }),
  }
}

function buildScatterChartPlan(input: ChartInput): ChartPlan {
  const [xColumn, yColumn] = findNumericColumns(input.rows, input.columns)
  if (!xColumn || !yColumn) {
    return fallbackChartPlan(input, 'Scatter chart requires at least two numeric columns.')
  }

  const data = input.rows.map((row) => [Number(row[xColumn] ?? 0), Number(row[yColumn] ?? 0)])
  const description = `Scatter plot comparing ${xColumn} and ${yColumn}.`
  return {
    description,
    option: baseChartOption(input.title, description, {
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', name: xColumn },
      yAxis: { type: 'value', name: yColumn },
      series: [{ name: `${xColumn} vs ${yColumn}`, type: 'scatter', data }],
    }),
  }
}

function buildBoxplotChartPlan(input: ChartInput): ChartPlan {
  const quartiles = resolveBoxplotColumns(input.columns)
  if (!quartiles) {
    return fallbackChartPlan(input, 'Boxplot requires min, q1, median, q3, and max style columns.')
  }

  const labels = input.rows.map((row, index) =>
    String(row[findLabelColumn(input.columns) ?? ''] ?? index + 1),
  )
  const data = input.rows.map((row) =>
    [quartiles.min, quartiles.q1, quartiles.median, quartiles.q3, quartiles.max].map((column) =>
      Number(row[column] ?? 0),
    ),
  )
  const description = 'Boxplot showing min, quartiles, median, and max values.'
  return {
    description,
    option: baseChartOption(input.title, description, {
      tooltip: { trigger: 'item' },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value' },
      series: [{ name: 'Distribution', type: 'boxplot', data }],
    }),
  }
}

function buildHeatmapChartPlan(input: ChartInput): ChartPlan {
  const numericColumn = findNumericColumns(input.rows, input.columns)[0]
  const dimensionColumns = input.columns.filter((column) => column !== numericColumn)
  const [xColumn, yColumn] = dimensionColumns
  if (!numericColumn || !xColumn || !yColumn) {
    return fallbackChartPlan(
      input,
      'Heatmap requires two dimension columns and one numeric metric column.',
    )
  }

  const xCategories = uniqueStrings(input.rows.map((row) => row[xColumn]))
  const yCategories = uniqueStrings(input.rows.map((row) => row[yColumn]))
  const data = input.rows.map((row) => [
    xCategories.indexOf(String(row[xColumn] ?? '')),
    yCategories.indexOf(String(row[yColumn] ?? '')),
    Number(row[numericColumn] ?? 0),
  ])
  const values = data.map((point) => point[2])
  const description = `Heatmap showing ${numericColumn} by ${xColumn} and ${yColumn}.`
  return {
    description,
    option: baseChartOption(input.title, description, {
      tooltip: { position: 'top' },
      xAxis: { type: 'category', data: xCategories },
      yAxis: { type: 'category', data: yCategories },
      visualMap: {
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
      },
      series: [{ name: numericColumn, type: 'heatmap', data, label: { show: false } }],
    }),
  }
}

function baseChartOption(
  title: string,
  description: string,
  option: Record<string, unknown>,
): Record<string, unknown> {
  return {
    title: { text: title, subtext: description, left: 'center', top: 0 },
    color: ['#4f7f73', '#d18f42', '#596f9d', '#8b6f99', '#c75f5f'],
    grid: { left: 52, right: 24, top: 78, bottom: 52, containLabel: true },
    toolbox: { feature: { saveAsImage: {}, dataZoom: {}, restore: {} }, right: 8 },
    ...option,
  }
}

function fallbackChartPlan(
  input: { chartType: AnalyticsChartType; warnings: string[] },
  reason: string,
): ChartPlan {
  input.warnings.push(`Rendered data table instead of ${input.chartType} chart: ${reason}`)
  return { description: `${reason} Review the data table for results.` }
}

function findNumericColumns(rows: Record<string, unknown>[], columns: string[]): string[] {
  return columns.filter((column) => rows.some((row) => typeof row[column] === 'number'))
}

function findLabelColumn(columns: string[]): string | undefined {
  const quartileNames = new Set([
    'min',
    'minimum',
    'q1',
    'p25',
    'median',
    'p50',
    'q3',
    'p75',
    'max',
    'maximum',
  ])
  return columns.find((column) => !quartileNames.has(normalizeColumnToken(column)))
}

function resolveBoxplotColumns(
  columns: string[],
): { min: string; q1: string; median: string; q3: string; max: string } | undefined {
  const byToken = new Map(columns.map((column) => [normalizeColumnToken(column), column]))
  const min = byToken.get('min') ?? byToken.get('minimum')
  const q1 = byToken.get('q1') ?? byToken.get('p25') ?? byToken.get('percentile25')
  const median = byToken.get('median') ?? byToken.get('p50') ?? byToken.get('percentile50')
  const q3 = byToken.get('q3') ?? byToken.get('p75') ?? byToken.get('percentile75')
  const max = byToken.get('max') ?? byToken.get('maximum')
  if (!min || !q1 || !median || !q3 || !max) return undefined
  return { min, q1, median, q3, max }
}

function normalizeColumnToken(column: string): string {
  return column.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? ''))))
}

function buildAnswer(
  modelAnswer: string | undefined,
  question: string,
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  if (modelAnswer) return modelAnswer
  if (rows.length === 0) return `No rows matched the request: ${question}`
  return `Found ${rows.length} row${rows.length === 1 ? '' : 's'} across ${columns.length} column${columns.length === 1 ? '' : 's'} for: ${question}`
}

function summarizeSchema(snapshot: SchemaSnapshot): string {
  const byTable = new Map<string, TableColumn[]>()
  for (const column of snapshot.columns) {
    const key = `${column.schema}.${column.table}`
    byTable.set(key, [...(byTable.get(key) ?? []), column])
  }

  const tables = Array.from(byTable.entries()).map(([table, columns]) => {
    const columnText = columns
      .map((column) => `${column.column} ${column.dataType}${column.nullable ? '' : ' not null'}`)
      .join(', ')
    return `${table}(${columnText})`
  })
  const foreignKeys = snapshot.foreignKeys.map(
    (fk) =>
      `${fk.schema}.${fk.table}.${fk.column} -> ${fk.foreignSchema}.${fk.foreignTable}.${fk.foreignColumn}`,
  )
  return [...tables, ...foreignKeys.map((fk) => `FK ${fk}`)].join('\n')
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function extractReferencedRelations(sql: string): string[] {
  const relations: string[] = []
  const pattern =
    /\b(?:from|join)\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sql)) !== null) {
    const relation = match[1]?.replace(/\s+/g, '')
    if (relation && !relation.startsWith('(')) relations.push(relation)
  }
  return relations
}

function normalizeRelationName(name: string): string {
  return name
    .split('.')
    .map((part) => part.trim().replace(/^"|"$/g, '').toLowerCase())
    .join('.')
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = normalizeValue(value)
    }
    return normalized
  })
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return value
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
}

function inferChartType(rows: Record<string, unknown>[], columns: string[]): AnalyticsChartType {
  if (rows.length === 0 || columns.length < 2) return 'table'
  const numericColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === 'number'),
  )
  return numericColumns.length > 0 ? 'bar' : 'table'
}

function titleFromQuestion(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 80) return trimmed
  return `${trimmed.slice(0, 77)}...`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export const tier = 1
