import type { ToolDefinition } from './types'

import * as askUserTool from './ask-user'
import * as bashTool from './bash'
import * as codeExecTool from './code-exec'
import * as createArtifactTool from './create-artifact'
import * as crystallizeTool from './crystallize'
import * as dreamTool from './dream'
import * as evolutionTool from './evolution'
import * as fileEditTool from './file-edit'
import * as fileReadTool from './file-read'
import * as fileWriteTool from './file-write'
import * as memoryTool from './memory'
import * as reflectTool from './reflect'
import * as selfTestTool from './self-test'
import * as skillGenTool from './skill-gen'
import * as skillManagerTool from './skill-manager'
import * as spawnAgentTool from './spawn-agent'
import * as teamAdvisorTool from './team-advisor'
import * as teamGraphTool from './team-graph'
import * as todoTool from './todo'
import * as webFetchTool from './web-fetch'
import * as webSearchTool from './web-search'
import * as workerDiffApprovalTool from './worker-diff-approval'

// Mode tools
import * as enterModeTool from '@src/modes/tools/enter-mode'
import * as submitPlanTool from '@src/modes/tools/submit-plan'
import * as exitModeTool from '@src/modes/tools/exit-mode'

export const BUILTIN_TOOLS: ToolDefinition[] = [
  askUserTool,
  bashTool,
  codeExecTool,
  createArtifactTool,
  crystallizeTool,
  dreamTool,
  evolutionTool,
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  memoryTool,
  reflectTool,
  selfTestTool,
  skillGenTool,
  skillManagerTool,
  spawnAgentTool,
  teamAdvisorTool,
  teamGraphTool,
  todoTool,
  webFetchTool,
  webSearchTool,
  workerDiffApprovalTool,
  // Mode system
  enterModeTool,
  submitPlanTool,
  exitModeTool,
] as ToolDefinition[]
