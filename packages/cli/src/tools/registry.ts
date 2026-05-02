import { readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, join } from 'node:path'
import { z } from 'zod'
import { enforcePermissionLease } from '@src/permission-lease'
import { requestTierApproval } from '@src/tier-approval'
import { type Result, err, ok } from '@src/types'
import { BUILTIN_TOOLS } from './builtin'
import type { ToolDefinition, ToolExecutionContext, ToolMetadata, ToolTier } from './types'
import type { TestCommandResult } from './subagent-result'

/** Files that should never be loaded as tools. */
const SKIP_FILES = new Set(['types.ts', 'registry.ts', '.gitkeep'])

/** Prefix used for every MCP-adapted tool name (e.g. `mcp__github__search`). */
export const MCP_TOOL_PREFIX = 'mcp__'

/** Reason returned when an MCP tool is requested from a child registry. */
const MCP_DENIAL_REASON = 'MCP tools are unavailable in child agent registries'

const READ_ONLY_ALLOWED_TOOL_NAMES = new Set(['file-read', 'web-fetch', 'web-search'])

const READ_ONLY_DENIED_TOOL_REASONS = new Map<string, string>([
  ['ask-user', 'read-only child agents cannot block on interactive user input'],
  ['bash', 'read-only child agents cannot execute shell commands'],
  ['code-exec', 'read-only child agents cannot execute generated code'],
  ['crystallize', 'read-only child agents cannot perform RSI crystallization'],
  ['dream', 'read-only child agents cannot perform RSI dream operations'],
  ['enter-mode', 'read-only child agents cannot change agent modes'],
  ['evolution', 'read-only child agents cannot modify evolution state'],
  ['exit-mode', 'read-only child agents cannot change agent modes'],
  ['file-edit', 'read-only child agents cannot edit files'],
  ['file-write', 'read-only child agents cannot write files'],
  ['memory', 'read-only child agents cannot mutate memory'],
  ['reflect', 'read-only child agents cannot perform privileged reflection'],
  ['self-test', 'read-only child agents cannot run privileged self-tests'],
  ['skill-gen', 'read-only child agents cannot create or modify skills'],
  ['skill-manager', 'read-only child agents cannot manage skills'],
  ['spawn_agent', 'read-only child agents cannot spawn nested agents'],
  ['submit-plan', 'read-only child agents cannot submit mode plans'],
  ['todo', 'read-only child agents cannot mutate task state'],
])

const TEST_AGENT_ALLOWED_TOOL_NAMES = new Set([...READ_ONLY_ALLOWED_TOOL_NAMES, 'bash'])

const TEST_AGENT_DENIED_TOOL_REASONS = new Map(READ_ONLY_DENIED_TOOL_REASONS)
TEST_AGENT_DENIED_TOOL_REASONS.delete('bash')

const WORKER_ALLOWED_TOOL_NAMES = new Set([
  'file-read',
  'file-write',
  'file-edit',
  'bash',
  'code-exec',
  'web-fetch',
  'web-search',
])

const WORKER_DENIED_TOOL_REASONS = new Map<string, string>([
  ['ask-user', 'worker child agents cannot block on interactive user input'],
  ['crystallize', 'worker child agents cannot perform RSI crystallization'],
  ['dream', 'worker child agents cannot perform RSI dream operations'],
  ['enter-mode', 'worker child agents cannot change agent modes'],
  ['evolution', 'worker child agents cannot modify evolution state'],
  ['exit-mode', 'worker child agents cannot change agent modes'],
  ['memory', 'worker child agents cannot mutate parent memory'],
  ['reflect', 'worker child agents cannot perform privileged reflection'],
  ['self-test', 'worker child agents cannot run privileged self-tests'],
  ['skill-gen', 'worker child agents cannot create or modify skills'],
  ['skill-manager', 'worker child agents cannot manage skills'],
  ['spawn_agent', 'worker child agents cannot spawn nested agents'],
  ['submit-plan', 'worker child agents cannot submit mode plans'],
  ['todo', 'worker child agents cannot mutate parent task state'],
])

export interface TestCommandDenial {
  command: string
  message: string
}

export interface TestToolRegistryOptions {
  allowedCommands: string[]
  onTestResult?: (result: TestCommandResult) => void
  onDeniedCommand?: (denial: TestCommandDenial) => void
}

export interface WorkerToolRegistryOptions {
  worktreePath: string
}

/**
 * The tool registry.
 *
 * Auto-discovers tool modules from a directory, validates their exports,
 * and provides lookup / dispatch helpers used by the agent loop.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private deniedTools = new Map<string, string>()
  /** Optional config permissions for runtime tier enforcement. */
  private configPermissions?: {
    tier0: boolean
    tier1: boolean
    tier2: boolean
    tier3: boolean
    tier4: boolean
  }

  /** Set config permissions for runtime tier enforcement. No-op when undefined. */
  setConfigPermissions(permissions?: {
    tier0: boolean
    tier1: boolean
    tier2: boolean
    tier3: boolean
    tier4: boolean
  }): void {
    this.configPermissions = permissions
  }

  /** Register a single tool definition (useful for testing). */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
    this.deniedTools.delete(tool.name)
  }

  /** Mark a tool name as explicitly denied without exposing it in metadata. */
  denyTool(name: string, reason: string): void {
    this.tools.delete(name)
    this.deniedTools.set(name, reason)
  }

  /**
   * Auto-discover and register all valid tool modules in the given directory.
   *
   * Skips files in `SKIP_FILES` and any module that doesn't conform to
   * the `ToolDefinition` interface (logs a warning instead of crashing).
   */
  async discover(directory?: string): Promise<void> {
    const dir = directory ?? resolve(import.meta.dir)

    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !SKIP_FILES.has(f))
    } catch {
      // Directory doesn't exist or isn't readable — nothing to discover.
      return
    }

    for (const file of files) {
      const modulePath = join(dir, file)
      try {
        const mod = await import(modulePath)
        if (isToolDefinition(mod)) {
          this.tools.set(mod.name, mod as ToolDefinition)
        } else if (isToolDefinition(mod.default)) {
          this.tools.set(mod.default.name, mod.default as ToolDefinition)
        }
        // Silently skip modules that don't export a valid tool definition.
      } catch {
        // Import failed — skip this file.
      }
    }
  }

  /** Return metadata for all registered tools (for system prompt injection). */
  getTools(): ToolMetadata[] {
    return Array.from(this.tools.values()).map(toMetadata)
  }

  /** Return the tier of a registered tool, or undefined. */
  getToolTier(name: string): ToolTier | undefined {
    const tool = this.tools.get(name)
    if (!tool) return undefined
    return tool.tier ?? 1
  }

  /** Return tool names that would be blocked by the given permission config. */
  toolsDisabledByTier(permissions: {
    tier0: boolean
    tier1: boolean
    tier2: boolean
    tier3: boolean
    tier4: boolean
  }): string[] {
    const disabled: string[] = []
    const tierKeys: (keyof typeof permissions)[] = ['tier0', 'tier1', 'tier2', 'tier3', 'tier4']
    for (const [toolName, tool] of this.tools.entries()) {
      const tier = tool.tier ?? 1
      const tierKey = tierKeys[tier] as keyof typeof permissions
      if (!permissions[tierKey]) {
        disabled.push(toolName)
      }
    }
    return disabled
  }

  /** Return a single tool definition by name, or undefined. */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }

  /** Return registered tool definitions for deriving isolated registries. */
  entries(): Array<[string, ToolDefinition]> {
    return Array.from(this.tools.entries())
  }

  /**
   * Validate arguments against the tool's schema, then execute.
   *
   * Returns `Result` — never throws, even if the tool itself misbehaves.
   */
  async executeTool(
    name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ): Promise<Result<unknown>> {
    const tool = this.tools.get(name)
    if (!tool) {
      const denialReason = this.deniedTools.get(name)
      if (denialReason) {
        return err(new Error(`Tool "${name}" is denied by read-only policy: ${denialReason}`))
      }
      return err(new Error(`Unknown tool: "${name}"`))
    }

    // Validate args before approval so malformed tool calls do not generate
    // one-off approval prompts.
    const parsed = tool.schema.safeParse(args)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      return err(new Error(`Invalid arguments for tool "${name}": ${issues}`))
    }

    // Runtime tier enforcement: a disabled tier requires explicit one-off
    // approval for this validated tool call, then execution continues normally.
    if (this.configPermissions) {
      const toolTier = resolveToolTier(tool, parsed.data)
      const tierKeys: (keyof typeof this.configPermissions)[] = [
        'tier0',
        'tier1',
        'tier2',
        'tier3',
        'tier4',
      ]
      const tierKey = tierKeys[toolTier]
      if (!this.configPermissions[tierKey]) {
        if (toolTier >= 1) {
          const approval = await requestTierApproval(name, toolTier as 1 | 2 | 3 | 4, args)
          if (!approval.ok) return approval
        } else {
          return err(
            new Error(
              `Tool "${name}" requires tier ${toolTier} which is not enabled in your config permissions.`,
            ),
          )
        }
      }
    }

    if (context?.permissionLease) {
      const leaseResult = await enforcePermissionLease(
        context.permissionLease,
        name,
        parsed.data,
        context,
      )
      if (!leaseResult.ok) {
        return leaseResult
      }
    }

    try {
      return await tool.execute(parsed.data, context)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err(new Error(`Tool "${name}" threw unexpectedly: ${message}`))
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isToolDefinition(obj: unknown): obj is ToolDefinition {
  if (obj == null || typeof obj !== 'object') return false
  const t = obj as Record<string, unknown>
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    t.schema instanceof z.ZodType &&
    typeof t.execute === 'function'
  )
}

function toMetadata(tool: ToolDefinition): ToolMetadata {
  // MCP-adapted tools carry a pre-built JSON Schema; pass it through verbatim
  // so the server-supplied parameter shape reaches the LLM unchanged.
  if (tool.jsonParameters) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonParameters,
    }
  }
  // Use zodToJsonSchema-compatible approach: Zod's .shape gives us the raw
  // shape. For a lightweight conversion we just describe the schema fields.
  let parameters: Record<string, unknown>
  if (tool.schema instanceof z.ZodObject) {
    parameters = zodSchemaToJsonSchema(tool.schema)
  } else {
    parameters = {}
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters,
  }
}

/**
 * Minimal Zod-to-JSON-Schema converter.
 *
 * Covers the primitive types we actually use in tool schemas
 * (string, number, boolean, enum, array, optional wrappers).
 * For anything more complex, consider `zod-to-json-schema` package.
 */
function zodSchemaToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const { jsonSchema, isOptional } = zodTypeToJsonSchema(value as z.ZodTypeAny)
    properties[key] = jsonSchema
    if (!isOptional) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function zodTypeToJsonSchema(schema: z.ZodTypeAny): {
  jsonSchema: Record<string, unknown>
  isOptional: boolean
} {
  const def = schema._def as unknown as Record<string, unknown>

  // Unwrap optional / default
  if (schema instanceof z.ZodOptional) {
    const inner = zodTypeToJsonSchema(def.innerType as z.ZodTypeAny)
    return { jsonSchema: inner.jsonSchema, isOptional: true }
  }
  if (schema instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(def.innerType as z.ZodTypeAny)
    return { jsonSchema: { ...inner.jsonSchema, default: def.defaultValue }, isOptional: true }
  }

  // Primitives
  if (schema instanceof z.ZodString) {
    return { jsonSchema: { type: 'string' }, isOptional: false }
  }
  if (schema instanceof z.ZodNumber) {
    return { jsonSchema: { type: 'number' }, isOptional: false }
  }
  if (schema instanceof z.ZodBoolean) {
    return { jsonSchema: { type: 'boolean' }, isOptional: false }
  }

  // Enum
  if (schema instanceof z.ZodEnum) {
    const values = (schema as unknown as { options: string[] }).options
    return { jsonSchema: { type: 'string', enum: values }, isOptional: false }
  }

  // Array
  if (schema instanceof z.ZodArray) {
    const inner = zodTypeToJsonSchema((schema as z.ZodArray<z.ZodTypeAny>).element)
    return { jsonSchema: { type: 'array', items: inner.jsonSchema }, isOptional: false }
  }

  // Fallback
  return { jsonSchema: {}, isOptional: false }
}

/**
 * Convenience: create a registry with built-in tools pre-registered.
 *
 * In dev, `discover()` can load tool modules from the filesystem. In compiled
 * production binaries, source `.ts` files do not exist on disk, so runtime
 * discovery would produce an empty registry. We therefore always register the
 * statically imported built-in tools first, and only perform filesystem
 * discovery when an explicit directory is provided (for extensibility).
 */
export async function createRegistry(directory?: string): Promise<ToolRegistry> {
  const registry = new ToolRegistry()

  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool)
  }

  if (directory) {
    await registry.discover(directory)
  }

  return registry
}

/**
 * Derive an isolated registry for read-only child agents.
 *
 * Only tools that cannot mutate local state or perform privileged operations
 * are exposed in metadata. Known unsafe built-ins are explicitly denied so a
 * forced or stale child tool call records a clear error instead of executing.
 */
export function createReadOnlyToolRegistry(parent: ToolRegistry): ToolRegistry {
  const registry = new ToolRegistry()

  for (const [toolName, tool] of parent.entries()) {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      registry.denyTool(toolName, MCP_DENIAL_REASON)
      continue
    }
    if (READ_ONLY_ALLOWED_TOOL_NAMES.has(toolName)) {
      registry.register(tool)
    } else {
      registry.denyTool(
        toolName,
        READ_ONLY_DENIED_TOOL_REASONS.get(toolName) ??
          'tool is not included in the read-only child registry',
      )
    }
  }

  for (const [toolName, reason] of READ_ONLY_DENIED_TOOL_REASONS.entries()) {
    if (!registry.getTool(toolName)) {
      registry.denyTool(toolName, reason)
    }
  }

  return registry
}

function outputExcerpt(stdout: string, stderr: string, maxLength = 4000): string {
  const output = [
    stdout ? `stdout:\n${stdout.trimEnd()}` : '',
    stderr ? `stderr:\n${stderr.trimEnd()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  if (output.length <= maxLength) {
    return output
  }

  const half = Math.floor((maxLength - 7) / 2)
  return `${output.slice(0, half)}\n...\n${output.slice(output.length - half)}`
}

function createRestrictedTestBashTool(
  parentBashTool: ToolDefinition,
  options: TestToolRegistryOptions,
): ToolDefinition {
  const allowedCommands = new Set(options.allowedCommands.map((command) => command.trim()))

  return {
    ...parentBashTool,
    description:
      'Execute one configured allowed test command and return command, exit code, duration, output excerpt, and pass/fail status. Arbitrary shell commands are denied before execution.',
    execute: async (args: unknown, context?: ToolExecutionContext): Promise<Result<unknown>> => {
      const command = (args as { command?: unknown }).command
      if (typeof command !== 'string') {
        return err(new Error('Test command policy requires a string command.'))
      }

      const normalizedCommand = command.trim()
      if (!allowedCommands.has(normalizedCommand)) {
        const allowedList =
          allowedCommands.size > 0 ? Array.from(allowedCommands).join(', ') : '(none configured)'
        const message = `Command "${normalizedCommand}" is not allowed for test agents. Allowed commands: ${allowedList}`
        options.onDeniedCommand?.({ command: normalizedCommand, message })
        return err(new Error(message))
      }

      const started = Date.now()
      const forwardedArgs = typeof args === 'object' && args !== null ? args : {}
      const cwd = (forwardedArgs as { cwd?: unknown }).cwd ?? context?.basePath
      const result = await parentBashTool.execute(
        { ...forwardedArgs, command: normalizedCommand, ...(cwd ? { cwd } : {}) },
        context,
      )
      const durationMs = Date.now() - started

      if (!result.ok) {
        return result
      }

      const value = result.value as { stdout?: string; stderr?: string; exitCode?: number }
      const exitCode = typeof value.exitCode === 'number' ? value.exitCode : 1
      const testResult: TestCommandResult = {
        command: normalizedCommand,
        exitCode,
        durationMs,
        outputExcerpt: outputExcerpt(value.stdout ?? '', value.stderr ?? ''),
        status: exitCode === 0 ? 'passed' : 'failed',
      }
      options.onTestResult?.(testResult)
      return ok(testResult)
    },
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function isInsideDirectory(path: string, directory: string): boolean {
  const rel = normalizePath(relative(directory, path))
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))
}

function resolveToolTier(tool: ToolDefinition, args: unknown): ToolTier {
  return tool.resolveTier?.(args) ?? tool.tier ?? 1
}

function resolveWorktreePath(path: string, worktreePath: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(worktreePath, path)
}

function createWorkerPathTool(
  tool: ToolDefinition,
  options: WorkerToolRegistryOptions,
): ToolDefinition {
  return {
    ...tool,
    execute: async (args: unknown, context?: ToolExecutionContext): Promise<Result<unknown>> => {
      const path = (args as { path?: unknown }).path
      if (typeof path !== 'string') {
        return err(new Error(`Worker ${tool.name} requires a string path.`))
      }

      const resolvedPath = resolveWorktreePath(path, options.worktreePath)
      if (!isInsideDirectory(resolvedPath, options.worktreePath)) {
        return err(
          new Error(
            `Worker ${tool.name} path "${path}" is outside worktree ${options.worktreePath}`,
          ),
        )
      }

      const forwardedArgs = typeof args === 'object' && args !== null ? args : {}
      return tool.execute({ ...forwardedArgs, path: resolvedPath }, context)
    },
  }
}

function createWorkerBashTool(
  tool: ToolDefinition,
  options: WorkerToolRegistryOptions,
): ToolDefinition {
  return {
    ...tool,
    execute: async (args: unknown, context?: ToolExecutionContext): Promise<Result<unknown>> => {
      const forwardedArgs = typeof args === 'object' && args !== null ? args : {}
      const requestedCwd = (forwardedArgs as { cwd?: unknown }).cwd
      const cwd =
        typeof requestedCwd === 'string'
          ? resolveWorktreePath(requestedCwd, options.worktreePath)
          : options.worktreePath

      if (!isInsideDirectory(cwd, options.worktreePath)) {
        return err(new Error(`Worker bash cwd "${String(requestedCwd)}" is outside worktree.`))
      }

      return tool.execute({ ...forwardedArgs, cwd }, context)
    },
  }
}

/**
 * Derive an isolated registry for restricted test child agents.
 *
 * The test agent may inspect files and run bash only through an exact command
 * allowlist. Denied commands are rejected before the shell is invoked.
 */
export function createTestToolRegistry(
  parent: ToolRegistry,
  options: TestToolRegistryOptions,
): ToolRegistry {
  const registry = new ToolRegistry()

  for (const [toolName, tool] of parent.entries()) {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      registry.denyTool(toolName, MCP_DENIAL_REASON)
      continue
    }
    if (toolName === 'bash') {
      registry.register(createRestrictedTestBashTool(tool, options))
    } else if (TEST_AGENT_ALLOWED_TOOL_NAMES.has(toolName)) {
      registry.register(tool)
    } else {
      registry.denyTool(
        toolName,
        TEST_AGENT_DENIED_TOOL_REASONS.get(toolName) ??
          'tool is not included in the restricted test child registry',
      )
    }
  }

  if (!registry.getTool('bash')) {
    registry.denyTool('bash', 'restricted test child agents require the bash tool to be registered')
  }

  for (const [toolName, reason] of TEST_AGENT_DENIED_TOOL_REASONS.entries()) {
    if (!registry.getTool(toolName)) {
      registry.denyTool(toolName, reason)
    }
  }

  return registry
}

/**
 * Derive an isolated registry for write-capable workers.
 *
 * The permission lease still authorizes each restricted operation. This registry
 * additionally forces filesystem paths and shell cwd values into the worker
 * worktree so relative tool calls cannot accidentally mutate the parent tree.
 */
export function createWorkerToolRegistry(
  parent: ToolRegistry,
  options: WorkerToolRegistryOptions,
): ToolRegistry {
  const registry = new ToolRegistry()

  for (const [toolName, tool] of parent.entries()) {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      registry.denyTool(toolName, MCP_DENIAL_REASON)
      continue
    }
    if (!WORKER_ALLOWED_TOOL_NAMES.has(toolName)) {
      registry.denyTool(
        toolName,
        WORKER_DENIED_TOOL_REASONS.get(toolName) ??
          'tool is not included in the isolated worker registry',
      )
      continue
    }

    if (toolName === 'file-read' || toolName === 'file-write' || toolName === 'file-edit') {
      registry.register(createWorkerPathTool(tool, options))
    } else if (toolName === 'bash') {
      registry.register(createWorkerBashTool(tool, options))
    } else {
      registry.register(tool)
    }
  }

  for (const toolName of WORKER_ALLOWED_TOOL_NAMES) {
    if (!registry.getTool(toolName)) {
      registry.denyTool(toolName, 'worker child agents require this tool to be registered')
    }
  }

  for (const [toolName, reason] of WORKER_DENIED_TOOL_REASONS.entries()) {
    if (!registry.getTool(toolName)) {
      registry.denyTool(toolName, reason)
    }
  }

  return registry
}
