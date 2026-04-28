import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { Agent, type AgentRunResult } from '@src/agent'
import { checkAgentInvocationPermission } from '@src/agent-invocation-permissions'
import { permissionLeaseSchema, type PermissionLease } from '@src/permission-lease'
import { type AgentDefinition, type PermissionConfig, type Result, err, ok } from '@src/types'
import {
  createReadOnlyToolRegistry,
  createTestToolRegistry,
  createWorkerToolRegistry,
  type TestCommandDenial,
} from './registry'
import {
  normalizeSubAgentOutput,
  type SubAgentResult,
  type TestCommandResult,
} from './subagent-result'
import type { ToolExecutionContext, TypedToolExecute } from './types'
import type { SkillActivationResult, SkillCatalogEntry } from './skill-manager'
import {
  collectWorkerDiff,
  createWorkerRuntime,
  type WorkerRuntime,
  type WorkerRuntimeSpec,
} from './worker-runtime'
import {
  workerDiffContextSchema,
  type WorkerDiffContext,
  type WorkerDiffReviewStatus,
} from './worker-diff-approval'

/**
 * Wrap a parent skillCatalogProvider so the child sees only the allowed
 * subset of skills. When `allowedSkills` is undefined or empty, the child
 * inherits the full catalog (existing behavior).
 *
 * Exported for unit testing — production callers pass through
 * `spawn-agent`'s `skills` arg.
 */
export function scopeSkillCatalogProvider(
  parentProvider: (() => SkillCatalogEntry[]) | undefined,
  allowedSkills: string[] | undefined,
): (() => SkillCatalogEntry[]) | undefined {
  if (!parentProvider) return undefined
  if (!allowedSkills || allowedSkills.length === 0) return parentProvider
  const allowSet = new Set(allowedSkills)
  return () => parentProvider().filter((entry) => allowSet.has(entry.name))
}

/**
 * Resolve which skill (if any) the child run should start activated with.
 * Only inherits when the parent explicitly opts in via `inheritSkill: true`.
 *
 * Exported for unit testing.
 */
export function resolveInheritedSkill(
  inheritSkill: boolean | undefined,
  parentActivatedSkill: SkillActivationResult | undefined,
): SkillActivationResult | undefined {
  if (!inheritSkill) return undefined
  return parentActivatedSkill
}

export const name = 'spawn_agent'

export const description =
  'Run a bounded read-only child agent task and return a structured completion or failure result. agentId must be a configured agent definition id such as explore, review, or test; do not pass team_graph task ids or lane labels such as inspector-1.'

export const schema = z.object({
  agentId: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'Use a valid agent id')
    .describe(
      'Configured agent definition id to run as the child agent. Built-ins include explore, review, and test. Do not use team_graph task ids or display lane ids such as inspector-1.',
    ),
  task: z.string().trim().min(1, 'Task must not be empty').describe('Bounded child task to run'),
  contextFiles: z
    .array(z.string().min(1))
    .optional()
    .describe('Optional workspace-relative or absolute context file paths to include'),
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(25)
    .optional()
    .describe('Optional child step limit, capped at 25 for read-only delegation'),
  outputFormat: z
    .enum(['summary', 'markdown', 'json'])
    .describe('Desired child response format: summary, markdown, or json'),
  taskId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for worker: stable task id for the isolated worker run'),
  branchName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for worker: git branch to create for the worker worktree'),
  worktreePath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for worker: absolute or current-process-relative git worktree path'),
  writeScope: z
    .array(z.string().trim().min(1))
    .optional()
    .describe('Required for worker: paths the worker may modify inside the worktree'),
  permissionLease: permissionLeaseSchema
    .optional()
    .describe('Required for worker: scoped permission lease authorizing write tools'),
  verificationCommand: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for worker: exact command to run after worker execution'),
  workerDiff: workerDiffContextSchema
    .optional()
    .describe('Worker output diff context for review/test agents to inspect.'),
  inheritSkill: z
    .boolean()
    .optional()
    .describe(
      "If true and the parent has an activated skill, pass the parent's activated skill through to this child run. Default: false (child operates without an inherited skill).",
    ),
  skills: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional allowlist of skill names visible to this child agent's catalog. If omitted, the child sees the full catalog inherited from the parent.",
    ),
})

export type SpawnAgentStatus = 'completed' | 'failed'

export interface SpawnAgentResult {
  status: SpawnAgentStatus
  agentId: string
  requestedAgentId?: string
  childSessionId?: string
  outputFormat: 'summary' | 'markdown' | 'json'
  text: string
  structuredResult: SubAgentResult
  testResults?: TestCommandResult[]
  testCommandDenials?: TestCommandDenial[]
  taskId?: string
  branchName?: string
  worktreePath?: string
  writeScope?: string[]
  changedFiles?: string[]
  diff?: string
  testsRun?: string[]
  testResult?: TestCommandResult
  unresolvedRisks?: string[]
  workerDiff?: WorkerDiffDisplay
  resultValidation: {
    valid: boolean
    warnings: string[]
  }
  iterations: number
  stopReason: AgentRunResult['stopReason'] | 'permission_denied' | 'child_exception'
  maxIterationsReached: boolean
  contextFiles: Array<{
    path: string
    included: boolean
    error?: string
  }>
  error?: {
    message: string
  }
}

export interface WorkerDiffDisplay extends WorkerDiffContext {
  diffLineCount: number
  reviewStatus: WorkerDiffReviewStatus
}

interface WorkerRuntimeArgs extends z.infer<typeof schema> {
  agentId: 'worker'
  taskId: string
  branchName: string
  worktreePath: string
  writeScope: string[]
  permissionLease: PermissionLease
  verificationCommand: string
}

function hasOnlyReadOnlyPermissions(permissions: PermissionConfig | undefined): boolean {
  return Boolean(
    permissions?.tier0 === true &&
    permissions.tier1 === false &&
    permissions.tier2 === false &&
    permissions.tier3 === false &&
    permissions.tier4 === false,
  )
}

function resolveMaxSteps(
  argsMaxSteps: number | undefined,
  targetAgent: AgentDefinition,
  configuredAutomationMaxSteps: number,
): number {
  if (argsMaxSteps !== undefined) {
    return Math.min(argsMaxSteps, 25)
  }

  return targetAgent.maxSteps ?? configuredAutomationMaxSteps
}

function readContextFiles(
  contextFiles: string[] | undefined,
  basePath: string | undefined,
  title = 'Provided Context Files',
): {
  section: string
  files: SpawnAgentResult['contextFiles']
} {
  if (!contextFiles || contextFiles.length === 0) {
    return { section: '', files: [] }
  }

  const workspace = basePath ?? process.cwd()
  const files: SpawnAgentResult['contextFiles'] = []
  const sections: string[] = []

  for (const path of contextFiles) {
    const absolutePath = isAbsolute(path) ? path : resolve(workspace, path)

    if (!existsSync(absolutePath)) {
      files.push({ path, included: false, error: 'File not found' })
      continue
    }

    try {
      const raw = readFileSync(absolutePath)
      if (raw.subarray(0, 8192).includes(0)) {
        files.push({ path, included: false, error: 'Binary file skipped' })
        continue
      }

      files.push({ path, included: true })
      sections.push(`### ${path}\n\n\`\`\`\n${raw.toString('utf-8')}\n\`\`\``)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      files.push({ path, included: false, error: message })
    }
  }

  if (sections.length === 0) {
    return { section: '', files }
  }

  return {
    section: `\n\n## ${title}\n\n${sections.join('\n\n')}`,
    files,
  }
}

function buildWorkerDiffContextSection(workerDiff: WorkerDiffContext | undefined): string {
  if (!workerDiff) return ''

  const testSummary = workerDiff.testResult
    ? `${workerDiff.testResult.status}: ${workerDiff.testResult.command} exited ${workerDiff.testResult.exitCode}`
    : 'No verification result provided.'
  const risks =
    workerDiff.unresolvedRisks.length > 0
      ? workerDiff.unresolvedRisks.map((risk) => `- ${risk}`).join('\n')
      : 'None reported.'
  const files =
    workerDiff.changedFiles.length > 0
      ? workerDiff.changedFiles.map((path) => `- ${path}`).join('\n')
      : 'No changed files reported.'

  return [
    `\n\n## Worker Diff Context`,
    `Task id: ${workerDiff.taskId}.`,
    workerDiff.branchName ? `Worker branch: ${workerDiff.branchName}.` : '',
    `Worker worktree: ${workerDiff.worktreePath}.`,
    `Review status: ${workerDiff.reviewStatus ?? 'awaiting-review'}.`,
    `Changed files:\n${files}`,
    `Verification: ${testSummary}.`,
    `Unresolved risks:\n${risks}`,
    `Diff:\n\`\`\`diff\n${workerDiff.diff}\n\`\`\``,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: scrubbedGitEnv(),
    }).trim()
  } catch {
    return ''
  }
}

// Strip inherited GIT_* env so this query always reflects `cwd`'s repo,
// not whatever repo the parent process was bound to.
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  return env
}

function uniqueLines(...outputs: string[]): string[] {
  return Array.from(
    new Set(
      outputs
        .flatMap((output) => output.split('\n'))
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort()
}

function getChangedFiles(basePath: string | undefined): { root: string; paths: string[] } | null {
  const cwd = basePath ?? process.cwd()
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd)
  if (!root) {
    return null
  }

  const unstaged = gitOutput(['diff', '--name-only', '--diff-filter=ACMRTUXB'], root)
  const staged = gitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB'], root)
  const untracked = gitOutput(['ls-files', '--others', '--exclude-standard'], root)
  const paths = uniqueLines(unstaged, staged, untracked)

  return { root, paths }
}

function resolveContextFileRequest(
  args: z.infer<typeof schema>,
  basePath: string | undefined,
): {
  contextFiles: string[] | undefined
  basePath: string | undefined
  title: string
} {
  if (args.contextFiles && args.contextFiles.length > 0) {
    return {
      contextFiles: args.contextFiles,
      basePath,
      title: 'Provided Context Files',
    }
  }

  if (
    args.workerDiff &&
    (args.agentId === 'review' || args.agentId === 'test') &&
    args.workerDiff.changedFiles.length > 0
  ) {
    return {
      contextFiles: args.workerDiff.changedFiles,
      basePath: args.workerDiff.worktreePath,
      title: 'Worker Changed File Context',
    }
  }

  if (args.agentId !== 'review') {
    return {
      contextFiles: undefined,
      basePath,
      title: 'Provided Context Files',
    }
  }

  const changed = getChangedFiles(basePath)
  if (!changed || changed.paths.length === 0) {
    return {
      contextFiles: undefined,
      basePath,
      title: 'Changed File Context',
    }
  }

  return {
    contextFiles: changed.paths,
    basePath: changed.root,
    title: 'Changed File Context',
  }
}

function buildChildTask(
  args: z.infer<typeof schema>,
  contextSection: string,
  allowedTestCommands: string[] = [],
): string {
  const reviewGuidance =
    args.agentId === 'review'
      ? [
          `Review output guidance: populate reviewFindings with actionable findings only.`,
          `Each finding must include severity, confidence, and an evidence array. Use severity values critical, high, medium, low, or info.`,
          args.workerDiff
            ? `Review the Worker Diff Context and changed files. Treat the worker output as unapplied until explicit apply_worker_diff approval succeeds.`
            : '',
          `If no actionable issues are found, return reviewFindings as an empty array and explain the absence of findings in summary.`,
        ]
          .filter(Boolean)
          .join('\n')
      : ''
  const testGuidance =
    args.agentId === 'test'
      ? [
          `Test execution guidance: use bash only for an exact command listed below.`,
          `Allowed test commands: ${allowedTestCommands.length > 0 ? allowedTestCommands.join(' | ') : '(none configured)'}.`,
          args.workerDiff
            ? `Run tests against the worker worktree at ${args.workerDiff.worktreePath}; pass that path as cwd when invoking bash.`
            : '',
          `For every test command you run, include testResults entries with command, exitCode, durationMs, outputExcerpt, and status passed or failed.`,
          `If a command is denied or unavailable, report the denial in uncertainty and do not try a different shell command.`,
        ]
          .filter(Boolean)
          .join('\n')
      : ''

  return [
    `Run this task as a read-only delegated agent.`,
    `Output format: ${args.outputFormat}.`,
    `Return only JSON matching this contract: {"summary": string, "claims": [{"claim": string, "evidence": [{"type": "file", "path": string, "line"?: number, "endLine"?: number, "excerpt"?: string} | {"type": "command", "command": string, "excerpt"?: string} | {"type": "output", "excerpt": string, "command"?: string}], "confidence": number between 0 and 1}], "reviewFindings"?: [{"title": string, "severity": "critical" | "high" | "medium" | "low" | "info", "file"?: string, "line"?: number, "body": string, "confidence": number between 0 and 1, "evidence": [{"type": "file", "path": string, "line"?: number, "endLine"?: number, "excerpt"?: string} | {"type": "command", "command": string, "excerpt"?: string} | {"type": "output", "excerpt": string, "command"?: string}]}], "testResults"?: [{"command": string, "exitCode": number, "durationMs": number, "outputExcerpt": string, "status": "passed" | "failed"}], "uncertainty": string[], "suggestedNextSteps": string[]}.`,
    reviewGuidance,
    testGuidance,
    `Task:\n${args.task}`,
    buildWorkerDiffContextSection(args.workerDiff),
    contextSection,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)))
}

function attachTestMetadata(
  result: SubAgentResult,
  testResults: TestCommandResult[],
  denials: TestCommandDenial[],
): SubAgentResult {
  if (testResults.length === 0 && denials.length === 0) {
    return result
  }

  return {
    ...result,
    ...(testResults.length > 0 ? { testResults } : {}),
    uncertainty: uniqueStrings([...result.uncertainty, ...denials.map((denial) => denial.message)]),
    suggestedNextSteps: uniqueStrings([
      ...result.suggestedNextSteps,
      ...(denials.length > 0
        ? ['Rerun the test agent with a command included in agent.allowedTestCommands.']
        : []),
    ]),
  }
}

function failedTestMessage(
  testResults: TestCommandResult[],
  denials: TestCommandDenial[],
): string | null {
  const denied = denials[0]
  if (denied) {
    return denied.message
  }

  const failed = testResults.find((result) => result.status === 'failed')
  if (failed) {
    return `Test command failed: ${failed.command} exited with ${failed.exitCode}`
  }

  return null
}

function parseWorkerArgs(args: z.infer<typeof schema>): Result<WorkerRuntimeArgs> {
  const missing: string[] = []
  if (!args.taskId) missing.push('taskId')
  if (!args.branchName) missing.push('branchName')
  if (!args.worktreePath) missing.push('worktreePath')
  if (!args.writeScope || args.writeScope.length === 0) missing.push('writeScope')
  if (!args.permissionLease) missing.push('permissionLease')
  if (!args.verificationCommand) missing.push('verificationCommand')

  if (missing.length > 0) {
    return err(new Error(`Worker agent requires: ${missing.join(', ')}.`))
  }

  const lease = args.permissionLease as PermissionLease
  if (lease.approvalRequired && !lease.approvedAt) {
    return err(new Error(`Worker permission lease "${lease.id}" is not approved.`))
  }

  const writeScope = args.writeScope ?? []
  const missingLeasePaths = writeScope.filter(
    (scope) =>
      !lease.allowedPaths.some((allowedPath) => isScopeCoveredByLeasePath(scope, allowedPath)),
  )
  if (missingLeasePaths.length > 0) {
    return err(
      new Error(
        `Worker write scope must be covered exactly by the permission lease. Missing: ${missingLeasePaths.join(', ')}`,
      ),
    )
  }

  const requiredTools = ['file-read', 'file-write', 'file-edit', 'bash']
  const missingTools = requiredTools.filter((tool) => !lease.allowedTools.includes(tool))
  if (missingTools.length > 0) {
    return err(
      new Error(`Worker permission lease is missing required tools: ${missingTools.join(', ')}`),
    )
  }

  if (!lease.allowedBash.includes(args.verificationCommand ?? '')) {
    return err(
      new Error('Worker verification command must be included in permissionLease.allowedBash.'),
    )
  }

  return ok(args as WorkerRuntimeArgs)
}

function isScopeCoveredByLeasePath(scope: string, allowedPath: string): boolean {
  const normalizedScope = normalizeScopePattern(scope)
  const normalizedAllowed = normalizeScopePattern(allowedPath)

  if (normalizedScope === normalizedAllowed) return true
  if (normalizedAllowed.endsWith('/**')) {
    const prefix = normalizedAllowed.slice(0, -3)
    return normalizedScope === prefix || normalizedScope.startsWith(`${prefix}/`)
  }
  if (normalizedAllowed.endsWith('/*')) {
    const prefix = normalizedAllowed.slice(0, -2)
    const remainder = normalizedScope.slice(prefix.length + 1)
    return normalizedScope.startsWith(`${prefix}/`) && !remainder.includes('/')
  }

  return false
}

function normalizeScopePattern(scope: string): string {
  return scope
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/g, '')
}

function buildWorkerTask(
  args: WorkerRuntimeArgs,
  runtime: WorkerRuntime,
  contextSection: string,
): string {
  return [
    `Run this task as an isolated write-capable worker.`,
    `Task id: ${args.taskId}.`,
    `Worker git branch: ${args.branchName}.`,
    `Worker cwd: ${runtime.worktreePath}.`,
    `Allowed write scope: ${args.writeScope.join(', ')}.`,
    `Verification command reserved for the runtime: ${args.verificationCommand}.`,
    `Do not edit files outside the allowed write scope. Do not edit the parent worktree.`,
    `Return only JSON matching this contract: {"summary": string, "claims": [{"claim": string, "evidence": [{"type": "file", "path": string, "line"?: number, "endLine"?: number, "excerpt"?: string} | {"type": "command", "command": string, "excerpt"?: string} | {"type": "output", "excerpt": string, "command"?: string}], "confidence": number between 0 and 1}], "testResults"?: [{"command": string, "exitCode": number, "durationMs": number, "outputExcerpt": string, "status": "passed" | "failed"}], "uncertainty": string[], "suggestedNextSteps": string[]}.`,
    `Task:\n${args.task}`,
    contextSection,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

function toWorkerRuntimeSpec(args: WorkerRuntimeArgs): WorkerRuntimeSpec {
  return {
    taskId: args.taskId,
    branchName: args.branchName,
    worktreePath: args.worktreePath,
    writeScope: args.writeScope,
  }
}

function toWorkerDiffDisplay(
  spawnResult: SpawnAgentResult,
  reviewStatus: WorkerDiffReviewStatus,
): WorkerDiffDisplay {
  const diff = spawnResult.diff ?? ''
  return {
    taskId: spawnResult.taskId ?? '',
    ...(spawnResult.branchName ? { branchName: spawnResult.branchName } : {}),
    worktreePath: spawnResult.worktreePath ?? '',
    changedFiles: spawnResult.changedFiles ?? [],
    diff,
    ...(spawnResult.testResult ? { testResult: spawnResult.testResult } : {}),
    unresolvedRisks: spawnResult.unresolvedRisks ?? [],
    reviewStatus,
    diffLineCount: diff.trim().length === 0 ? 0 : diff.split('\n').length,
  }
}

function outputExcerpt(stdout: string, stderr: string, maxLength = 4000): string {
  const output = [
    stdout ? `stdout:\n${stdout.trimEnd()}` : '',
    stderr ? `stderr:\n${stderr.trimEnd()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  if (output.length <= maxLength) return output
  const half = Math.floor((maxLength - 7) / 2)
  return `${output.slice(0, half)}\n...\n${output.slice(output.length - half)}`
}

const READ_ONLY_AGENT_ALIASES: ReadonlyArray<{
  pattern: RegExp
  targetAgentId: 'explore' | 'review' | 'test'
}> = [
  {
    pattern: /^(?:inspect|inspector|explore|explorer|research|researcher|reader)(?:-[a-z0-9]+)*$/,
    targetAgentId: 'explore',
  },
  { pattern: /^(?:review|reviewer|red-team|redteam)(?:-[a-z0-9]+)*$/, targetAgentId: 'review' },
  { pattern: /^(?:test|tester|verify|verifier)(?:-[a-z0-9]+)*$/, targetAgentId: 'test' },
]

function resolveSpawnAgentId(
  requestedAgentId: string,
  definitions: AgentDefinition[],
): { agentId: string; requestedAgentId?: string } {
  if (definitions.some((definition) => definition.id === requestedAgentId)) {
    return { agentId: requestedAgentId }
  }

  const alias = READ_ONLY_AGENT_ALIASES.find((candidate) =>
    candidate.pattern.test(requestedAgentId),
  )
  if (!alias || !definitions.some((definition) => definition.id === alias.targetAgentId)) {
    return { agentId: requestedAgentId }
  }

  return { agentId: alias.targetAgentId, requestedAgentId }
}

function updateLinkedTeamTask(input: {
  context: ToolExecutionContext
  taskId?: string
  agentId: string
  status: 'running' | 'completed' | 'failed'
  reason: string
  errorMessage?: string
}): void {
  if (!input.taskId || !input.context.taskGraphStore) return
  const graphResult = input.context.taskGraphStore.findGraphContainingTask(input.taskId)
  if (!graphResult.ok || !graphResult.value) return

  const graphId = graphResult.value.id
  const result =
    input.status === 'running'
      ? input.context.taskGraphStore.startTask({
          graphId,
          taskId: input.taskId,
          agentId: input.agentId,
        })
      : input.status === 'completed'
        ? input.context.taskGraphStore.completeTask(graphId, input.taskId)
        : input.context.taskGraphStore.failTask(graphId, input.taskId, input.errorMessage)
  if (!result.ok) return

  const graph = 'graph' in result.value ? result.value.graph : result.value
  input.context.emitEvent?.({
    type: 'team-graph-open',
    graph,
    reason: input.reason,
  })
}

export const execute: TypedToolExecute<typeof schema, SpawnAgentResult> = async (
  args,
  context?: ToolExecutionContext,
): Promise<Result<SpawnAgentResult>> => {
  if (!context) {
    return err(new Error('spawn_agent requires an active agent execution context.'))
  }

  const workerArgsResult = args.agentId === 'worker' ? parseWorkerArgs(args) : null
  if (workerArgsResult && !workerArgsResult.ok) {
    return workerArgsResult
  }

  const resolvedAgent = resolveSpawnAgentId(args.agentId, context.config.agent.definitions)

  const permission = checkAgentInvocationPermission({
    parentAgentId: context.agentId,
    targetAgentId: resolvedAgent.agentId,
    definitions: context.config.agent.definitions,
    enabledPhaseGates: workerArgsResult?.ok ? ['worker-runtime'] : [],
  })

  if (!permission.ok) {
    return err(new Error(permission.error.message))
  }

  const { targetAgent } = permission.value
  if (workerArgsResult?.ok) {
    return executeWorkerAgent(workerArgsResult.value, targetAgent, context)
  }

  if (!hasOnlyReadOnlyPermissions(targetAgent.permissions)) {
    return err(
      new Error(`Agent "${resolvedAgent.agentId}" is not read-only and cannot be spawned yet.`),
    )
  }

  const contextFileRequest = resolveContextFileRequest(args, context.basePath)
  const contextFileResult = readContextFiles(
    contextFileRequest.contextFiles,
    contextFileRequest.basePath,
    contextFileRequest.title,
  )
  const linkedTeamAgentId = resolvedAgent.requestedAgentId ?? targetAgent.id
  const maxSteps = resolveMaxSteps(
    args.maxSteps,
    targetAgent,
    context.config.agent.maxSteps.automation,
  )
  const transcriptStore = context.transcriptStore
  const parentSessionId = context.sessionId
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const testResults: TestCommandResult[] = []
  const testCommandDenials: TestCommandDenial[] = []
  let childSessionId: string | undefined

  if (transcriptStore && parentSessionId) {
    const childSessionResult = transcriptStore.createSession(context.basePath ?? null)
    if (!childSessionResult.ok) {
      return err(childSessionResult.error)
    }
    childSessionId = childSessionResult.value

    const parentStartResult = transcriptStore.addMessage(parentSessionId, {
      role: 'tool-call',
      content: `spawn_agent: ${args.agentId}`,
      toolName: name,
      toolArgs: {
        agentId: args.agentId,
        ...(resolvedAgent.requestedAgentId ? { resolvedAgentId: resolvedAgent.agentId } : {}),
        task: args.task,
        childSessionId,
      },
    })
    if (!parentStartResult.ok) {
      return err(parentStartResult.error)
    }
  }

  context.emitEvent?.({
    type: 'subagent-started',
    runId,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    agentId: targetAgent.id,
    task: args.task,
    status: 'running',
    startedAt,
  })
  updateLinkedTeamTask({
    context,
    taskId: args.taskId,
    agentId: linkedTeamAgentId,
    status: 'running',
    reason: `Team task "${args.taskId ?? args.task}" started.`,
  })

  let childAgent: Agent | undefined
  let spawnResult: SpawnAgentResult
  try {
    context.emitEvent?.({
      type: 'subagent-updated',
      runId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      agentId: targetAgent.id,
      task: args.task,
      status: 'running',
      startedAt,
      updatedAt: new Date().toISOString(),
      message: `Subagent ${targetAgent.id} is running.`,
    })

    childAgent = new Agent({
      model: context.model,
      toolRegistry:
        targetAgent.id === 'test'
          ? createTestToolRegistry(context.toolRegistry, {
              allowedCommands: context.config.agent.allowedTestCommands,
              onTestResult: (result) => testResults.push(result),
              onDeniedCommand: (denial) => testCommandDenials.push(denial),
            })
          : createReadOnlyToolRegistry(context.toolRegistry),
      config: context.config,
      transcriptStore,
      basePath: contextFileRequest.basePath ?? context.basePath,
      sessionId: childSessionId,
      maxSteps,
      agentId: targetAgent.id,
      agentDefinition: targetAgent,
      systemPromptBuilder: context.systemPromptBuilder,
      memoryProvider: context.memoryProvider,
      skillCatalogProvider: scopeSkillCatalogProvider(context.skillCatalogProvider, args.skills),
    })

    const inheritedSkill = resolveInheritedSkill(args.inheritSkill, context.activatedSkill)
    const result = await childAgent.run(
      buildChildTask(args, contextFileResult.section, context.config.agent.allowedTestCommands),
      {
        maxSteps,
        runProfile: 'automation',
        ...(inheritedSkill ? { activatedSkill: inheritedSkill } : {}),
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      },
    )
    const normalized = normalizeSubAgentOutput(result.text)
    const structuredResult = attachTestMetadata(normalized.result, testResults, testCommandDenials)
    const testFailureMessage =
      targetAgent.id === 'test' ? failedTestMessage(testResults, testCommandDenials) : null
    const status = result.stopReason === 'completed' && !testFailureMessage ? 'completed' : 'failed'

    spawnResult = {
      status,
      agentId: targetAgent.id,
      ...(resolvedAgent.requestedAgentId
        ? { requestedAgentId: resolvedAgent.requestedAgentId }
        : {}),
      ...(childSessionId ? { childSessionId } : {}),
      outputFormat: args.outputFormat,
      text: result.text,
      structuredResult,
      ...(testResults.length > 0 ? { testResults } : {}),
      ...(testCommandDenials.length > 0 ? { testCommandDenials } : {}),
      resultValidation: {
        valid: normalized.valid,
        warnings: normalized.warnings,
      },
      iterations: result.iterations,
      stopReason: result.stopReason,
      maxIterationsReached: result.maxIterationsReached,
      contextFiles: contextFileResult.files,
      ...(result.stopReason === 'completed' && normalized.valid && !testFailureMessage
        ? {}
        : {
            error: {
              message:
                testFailureMessage ??
                (result.stopReason === 'completed'
                  ? `Child agent returned invalid structured result: ${normalized.warnings.join('; ')}`
                  : `Child agent stopped with reason: ${result.stopReason}`),
            },
          }),
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const normalized = normalizeSubAgentOutput('')
    spawnResult = {
      status: 'failed',
      agentId: targetAgent.id,
      ...(resolvedAgent.requestedAgentId
        ? { requestedAgentId: resolvedAgent.requestedAgentId }
        : {}),
      ...(childSessionId ? { childSessionId } : {}),
      outputFormat: args.outputFormat,
      text: '',
      structuredResult: {
        ...normalized.result,
        uncertainty: [message],
      },
      resultValidation: {
        valid: false,
        warnings: [message],
      },
      iterations: 0,
      stopReason: 'child_exception',
      maxIterationsReached: false,
      contextFiles: contextFileResult.files,
      error: { message },
    }
  }

  const completedAt = new Date().toISOString()
  if (spawnResult.status === 'completed') {
    updateLinkedTeamTask({
      context,
      taskId: args.taskId,
      agentId: linkedTeamAgentId,
      status: 'completed',
      reason: `Team task "${args.taskId ?? args.task}" completed.`,
    })
    context.emitEvent?.({
      type: 'subagent-completed',
      runId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      agentId: targetAgent.id,
      task: args.task,
      status: 'completed',
      startedAt,
      completedAt,
      result: spawnResult.structuredResult,
    })
  } else {
    updateLinkedTeamTask({
      context,
      taskId: args.taskId,
      agentId: linkedTeamAgentId,
      status: 'failed',
      reason: `Team task "${args.taskId ?? args.task}" failed.`,
      errorMessage: spawnResult.error?.message ?? 'Subagent failed.',
    })
    context.emitEvent?.({
      type: 'subagent-failed',
      runId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      agentId: targetAgent.id,
      task: args.task,
      status: 'failed',
      startedAt,
      completedAt,
      error: { message: spawnResult.error?.message ?? 'Subagent failed.' },
      result: spawnResult.structuredResult,
    })
  }

  if (transcriptStore && parentSessionId && childSessionId) {
    if (childAgent) {
      const childTranscriptResult = transcriptStore.addConversationMessages(
        childSessionId,
        childAgent.getConversationHistory(),
      )
      if (!childTranscriptResult.ok) {
        return err(childTranscriptResult.error)
      }
    }

    const childEndResult = transcriptStore.endSession(
      childSessionId,
      `Subagent ${targetAgent.id} ${spawnResult.status}: ${args.task}`,
    )
    if (!childEndResult.ok) {
      return err(childEndResult.error)
    }

    const parentCompleteResult = transcriptStore.addMessage(parentSessionId, {
      role: 'tool-result',
      content: JSON.stringify(spawnResult),
      toolName: name,
    })
    if (!parentCompleteResult.ok) {
      return err(parentCompleteResult.error)
    }

    const runResult = transcriptStore.addSubagentRun({
      id: runId,
      parentSessionId,
      childSessionId,
      agentId: targetAgent.id,
      task: args.task,
      status: spawnResult.status,
      startedAt,
      completedAt,
      finalResult: JSON.stringify(spawnResult.structuredResult),
      errorMessage: spawnResult.error?.message ?? null,
    })
    if (!runResult.ok) {
      return err(runResult.error)
    }
  }

  return ok(spawnResult)
}

async function executeWorkerAgent(
  args: WorkerRuntimeArgs,
  targetAgent: AgentDefinition,
  context: ToolExecutionContext,
): Promise<Result<SpawnAgentResult>> {
  const runtimeResult = createWorkerRuntime(toWorkerRuntimeSpec(args), context.basePath)
  if (!runtimeResult.ok) {
    return err(runtimeResult.error)
  }

  const runtime = runtimeResult.value
  const contextFileRequest = resolveContextFileRequest(args, runtime.worktreePath)
  const contextFileResult = readContextFiles(
    contextFileRequest.contextFiles,
    contextFileRequest.basePath,
    contextFileRequest.title,
  )
  const maxSteps = resolveMaxSteps(
    args.maxSteps,
    targetAgent,
    context.config.agent.maxSteps.automation,
  )
  const transcriptStore = context.transcriptStore
  const parentSessionId = context.sessionId
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  let childSessionId: string | undefined

  try {
    if (transcriptStore && parentSessionId) {
      const childSessionResult = transcriptStore.createSession(runtime.worktreePath)
      if (!childSessionResult.ok) {
        return err(childSessionResult.error)
      }
      childSessionId = childSessionResult.value

      const parentStartResult = transcriptStore.addMessage(parentSessionId, {
        role: 'tool-call',
        content: `spawn_agent: ${args.agentId}`,
        toolName: name,
        toolArgs: {
          agentId: args.agentId,
          taskId: args.taskId,
          task: args.task,
          branchName: args.branchName,
          worktreePath: runtime.worktreePath,
          writeScope: args.writeScope,
          childSessionId,
        },
      })
      if (!parentStartResult.ok) {
        return err(parentStartResult.error)
      }
    }

    context.emitEvent?.({
      type: 'subagent-started',
      runId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      agentId: targetAgent.id,
      task: args.task,
      status: 'running',
      startedAt,
    })

    let childAgent: Agent | undefined
    let spawnResult: SpawnAgentResult
    try {
      context.emitEvent?.({
        type: 'subagent-updated',
        runId,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        agentId: targetAgent.id,
        task: args.task,
        status: 'running',
        startedAt,
        updatedAt: new Date().toISOString(),
        message: `Worker ${targetAgent.id} is running in ${runtime.worktreePath}.`,
      })

      const workerRegistry = createWorkerToolRegistry(context.toolRegistry, {
        worktreePath: runtime.worktreePath,
      })
      childAgent = new Agent({
        model: context.model,
        toolRegistry: workerRegistry,
        config: context.config,
        transcriptStore,
        basePath: runtime.worktreePath,
        sessionId: childSessionId,
        maxSteps,
        agentId: targetAgent.id,
        agentDefinition: targetAgent,
        permissionLease: args.permissionLease,
        systemPromptBuilder: context.systemPromptBuilder,
        memoryProvider: context.memoryProvider,
        skillCatalogProvider: scopeSkillCatalogProvider(context.skillCatalogProvider, args.skills),
      })

      const inheritedSkill = resolveInheritedSkill(args.inheritSkill, context.activatedSkill)
      const result = await childAgent.run(
        buildWorkerTask(args, runtime, contextFileResult.section),
        {
          maxSteps,
          runProfile: 'automation',
          ...(inheritedSkill ? { activatedSkill: inheritedSkill } : {}),
          ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
        },
      )
      const normalized = normalizeSubAgentOutput(result.text)
      const verification = await runWorkerVerification(
        workerRegistry,
        args.permissionLease,
        args.verificationCommand,
        runtime.worktreePath,
        context,
      )
      const diffResult = collectWorkerDiff(runtime.worktreePath)
      const testResult = verification.ok ? verification.value : undefined
      const verificationError = verification.ok ? null : verification.error.message
      const status =
        result.stopReason === 'completed' && normalized.valid && testResult?.status === 'passed'
          ? 'completed'
          : 'failed'
      const unresolvedRisks = uniqueStrings([
        ...normalized.result.uncertainty,
        ...(verificationError ? [verificationError] : []),
        ...(testResult?.status === 'failed'
          ? [`Verification failed: ${args.verificationCommand}`]
          : []),
      ])

      spawnResult = {
        status,
        agentId: targetAgent.id,
        ...(childSessionId ? { childSessionId } : {}),
        outputFormat: args.outputFormat,
        text: result.text,
        structuredResult: {
          ...normalized.result,
          ...(testResult ? { testResults: [testResult] } : {}),
          uncertainty: unresolvedRisks,
        },
        ...(testResult ? { testResults: [testResult], testResult } : {}),
        taskId: args.taskId,
        branchName: args.branchName,
        worktreePath: runtime.worktreePath,
        writeScope: args.writeScope,
        changedFiles: diffResult.changedFiles,
        diff: diffResult.diff,
        testsRun: [args.verificationCommand],
        unresolvedRisks,
        resultValidation: {
          valid: normalized.valid,
          warnings: normalized.warnings,
        },
        iterations: result.iterations,
        stopReason: result.stopReason,
        maxIterationsReached: result.maxIterationsReached,
        contextFiles: contextFileResult.files,
        ...(status === 'completed'
          ? {}
          : {
              error: {
                message:
                  verificationError ??
                  (testResult?.status === 'failed'
                    ? `Verification command failed: ${args.verificationCommand} exited with ${testResult.exitCode}`
                    : result.stopReason === 'completed'
                      ? `Worker returned invalid structured result: ${normalized.warnings.join('; ')}`
                      : `Worker stopped with reason: ${result.stopReason}`),
              },
            }),
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const normalized = normalizeSubAgentOutput('')
      const diffResult = collectWorkerDiff(runtime.worktreePath)
      spawnResult = {
        status: 'failed',
        agentId: targetAgent.id,
        ...(childSessionId ? { childSessionId } : {}),
        outputFormat: args.outputFormat,
        text: '',
        structuredResult: {
          ...normalized.result,
          uncertainty: [message],
        },
        taskId: args.taskId,
        branchName: args.branchName,
        worktreePath: runtime.worktreePath,
        writeScope: args.writeScope,
        changedFiles: diffResult.changedFiles,
        diff: diffResult.diff,
        testsRun: [args.verificationCommand],
        unresolvedRisks: [message],
        resultValidation: {
          valid: false,
          warnings: [message],
        },
        iterations: 0,
        stopReason: 'child_exception',
        maxIterationsReached: false,
        contextFiles: contextFileResult.files,
        error: { message },
      }
    }

    const workerDiff = toWorkerDiffDisplay(
      spawnResult,
      spawnResult.status === 'completed' ? 'awaiting-review' : 'blocked',
    )
    spawnResult = { ...spawnResult, workerDiff }

    const completedAt = new Date().toISOString()
    if (spawnResult.status === 'completed') {
      context.emitEvent?.({
        type: 'subagent-completed',
        runId,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        agentId: targetAgent.id,
        task: args.task,
        status: 'completed',
        startedAt,
        completedAt,
        result: spawnResult.structuredResult,
        workerDiff,
      })
    } else {
      context.emitEvent?.({
        type: 'subagent-failed',
        runId,
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        agentId: targetAgent.id,
        task: args.task,
        status: 'failed',
        startedAt,
        completedAt,
        error: { message: spawnResult.error?.message ?? 'Worker failed.' },
        result: spawnResult.structuredResult,
        workerDiff,
      })
    }

    if (transcriptStore && parentSessionId && childSessionId) {
      if (childAgent) {
        const childTranscriptResult = transcriptStore.addConversationMessages(
          childSessionId,
          childAgent.getConversationHistory(),
        )
        if (!childTranscriptResult.ok) {
          return err(childTranscriptResult.error)
        }
      }

      const childEndResult = transcriptStore.endSession(
        childSessionId,
        `Worker ${targetAgent.id} ${spawnResult.status}: ${args.task}`,
      )
      if (!childEndResult.ok) {
        return err(childEndResult.error)
      }

      const parentCompleteResult = transcriptStore.addMessage(parentSessionId, {
        role: 'tool-result',
        content: JSON.stringify(spawnResult),
        toolName: name,
      })
      if (!parentCompleteResult.ok) {
        return err(parentCompleteResult.error)
      }

      const runResult = transcriptStore.addSubagentRun({
        id: runId,
        parentSessionId,
        childSessionId,
        agentId: targetAgent.id,
        task: args.task,
        status: spawnResult.status,
        startedAt,
        completedAt,
        finalResult: JSON.stringify(spawnResult.structuredResult),
        errorMessage: spawnResult.error?.message ?? null,
      })
      if (!runResult.ok) {
        return err(runResult.error)
      }
    }

    return ok(spawnResult)
  } finally {
    runtime.release()
  }
}

async function runWorkerVerification(
  workerRegistry: ReturnType<typeof createWorkerToolRegistry>,
  permissionLease: PermissionLease,
  command: string,
  worktreePath: string,
  parentContext: ToolExecutionContext,
): Promise<Result<TestCommandResult>> {
  const started = Date.now()
  const result = await workerRegistry.executeTool(
    'bash',
    { command, cwd: worktreePath },
    {
      ...parentContext,
      toolRegistry: workerRegistry,
      basePath: worktreePath,
      permissionLease,
      agentId: 'worker',
    },
  )
  const durationMs = Date.now() - started

  if (!result.ok) {
    return err(result.error)
  }

  const value = result.value as { stdout?: string; stderr?: string; exitCode?: number }
  const exitCode = typeof value.exitCode === 'number' ? value.exitCode : 1
  return ok({
    command,
    exitCode,
    durationMs,
    outputExcerpt: outputExcerpt(value.stdout ?? '', value.stderr ?? ''),
    status: exitCode === 0 ? 'passed' : 'failed',
  })
}
