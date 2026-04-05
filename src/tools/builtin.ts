import type { ToolDefinition } from './types'

import * as askUserTool from './ask-user'
import * as bashTool from './bash'
import * as fileEditTool from './file-edit'
import * as fileReadTool from './file-read'
import * as fileWriteTool from './file-write'
import * as memoryTool from './memory'
import * as selfTestTool from './self-test'
import * as skillManagerTool from './skill-manager'
import * as todoTool from './todo'
import * as webFetchTool from './web-fetch'
import * as webSearchTool from './web-search'

export const BUILTIN_TOOLS: ToolDefinition[] = [
  askUserTool,
  bashTool,
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  memoryTool,
  selfTestTool,
  skillManagerTool,
  todoTool,
  webFetchTool,
  webSearchTool,
] as ToolDefinition[]
