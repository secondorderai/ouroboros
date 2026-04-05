import type { ToolDefinition } from './types'

import * as askUserTool from './ask-user'
import * as bashTool from './bash'
import * as fileEditTool from './file-edit'
import * as fileReadTool from './file-read'
import * as fileWriteTool from './file-write'
import * as memoryTool from './memory'
import * as skillManagerTool from './skill-manager'
import * as todoTool from './todo'
import * as webFetchTool from './web-fetch'
import * as webSearchTool from './web-search'

function toToolDefinition(mod: {
  name: string
  description: string
  schema: ToolDefinition['schema']
  execute: ToolDefinition['execute']
}): ToolDefinition {
  return {
    name: mod.name,
    description: mod.description,
    schema: mod.schema,
    execute: mod.execute,
  }
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  toToolDefinition(askUserTool),
  toToolDefinition(bashTool),
  toToolDefinition(fileEditTool),
  toToolDefinition(fileReadTool),
  toToolDefinition(fileWriteTool),
  toToolDefinition(memoryTool),
  toToolDefinition(skillManagerTool),
  toToolDefinition(todoTool),
  toToolDefinition(webFetchTool),
  toToolDefinition(webSearchTool),
]
