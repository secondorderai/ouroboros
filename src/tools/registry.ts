import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { type Result, err } from '@src/types'
import { BUILTIN_TOOLS } from './builtin'
import type { ToolDefinition, ToolMetadata } from './types'

/** Files that should never be loaded as tools. */
const SKIP_FILES = new Set(['types.ts', 'registry.ts', '.gitkeep'])

/**
 * The tool registry.
 *
 * Auto-discovers tool modules from a directory, validates their exports,
 * and provides lookup / dispatch helpers used by the agent loop.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  /** Register a single tool definition (useful for testing). */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
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

  /** Return a single tool definition by name, or undefined. */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size
  }

  /**
   * Validate arguments against the tool's schema, then execute.
   *
   * Returns `Result` — never throws, even if the tool itself misbehaves.
   */
  async executeTool(name: string, args: unknown): Promise<Result<unknown>> {
    const tool = this.tools.get(name)
    if (!tool) {
      return err(new Error(`Unknown tool: "${name}"`))
    }

    // Validate args against the Zod schema.
    const parsed = tool.schema.safeParse(args)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      return err(new Error(`Invalid arguments for tool "${name}": ${issues}`))
    }

    try {
      return await tool.execute(parsed.data)
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
