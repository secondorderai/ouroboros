import { z } from 'zod'
import { TaskGraphStore, type TaskGraph, type CreateTaskNodeInput } from '@src/team/task-graph'
import {
  createWorkflowTemplate,
  WORKFLOW_TEMPLATE_NAMES,
  type WorkflowTemplateName,
} from '@src/team/workflow-templates'
import { type Result, err, ok } from '@src/types'
import type { TypedToolExecute, ToolExecutionContext } from './types'

export const name = 'team_graph'

export const description =
  'Create, open, update, and inspect persistent team task graphs. Use this when the user asks for a team plan, task graph, workflow template, or to show the team graph in desktop. Required key: `action`. Example: {action: "create", name: "Refactor auth", tasks: [{title: "Audit handlers", description: "..."}]}. Do NOT use `nodes`/`edges`/`title` — those are not valid keys. assignedAgentId is only a graph lane/display id; spawn_agent.agentId must be a configured agent definition such as explore.'

const qualityGateSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1),
    required: z.boolean().optional(),
    status: z.enum(['pending', 'passed', 'failed']).optional(),
  })
  .strict()

const taskInputSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    dependencies: z.array(z.string().trim().min(1)).optional(),
    assignedAgentId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional display lane id for the graph only. This is not a spawn_agent target id.',
      ),
    requiredArtifacts: z.array(z.string().trim().min(1)).optional(),
    qualityGates: z.array(qualityGateSchema).optional(),
  })
  .strict()

const STRAY_KEYS = ['nodes', 'edges', 'title'] as const

export const schema = z
  .object({
    action: z
      .enum([
        'create',
        'create-workflow',
        'open',
        'get',
        'start',
        'pause',
        'fail',
        'cancel',
        'cleanup',
        'add-task',
        'assign-task',
        'send-message',
      ])
      .describe('Team graph operation to perform.'),
    graphId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    tasks: z.array(taskInputSchema).optional(),
    task: taskInputSchema.optional(),
    taskId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    template: z.enum(WORKFLOW_TEMPLATE_NAMES).optional(),
    taskContext: z.string().trim().min(1).optional(),
    openInDesktop: z.boolean().default(true).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const stray = STRAY_KEYS.filter((k) => k in (val as Record<string, unknown>))
    if (stray.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `team_graph does not accept ${stray.join('/')}. Use {action: "create", name, tasks: [{title, description, dependencies?, assignedAgentId?}]}.`,
      })
    }
  })

export interface TeamGraphToolResult {
  graph?: TaskGraph
  cleaned?: true
  graphId?: string
  opened?: boolean
  message: string
}

function requireContext(context?: ToolExecutionContext): Result<ToolExecutionContext> {
  if (!context) return err(new Error('team_graph requires an active agent execution context.'))
  return ok(context)
}

function getStore(context: ToolExecutionContext): TaskGraphStore {
  return context.taskGraphStore ?? new TaskGraphStore(context.transcriptStore)
}

function requireString(value: string | undefined, name: string): Result<string> {
  if (!value) return err(new Error(`team_graph action requires ${name}.`))
  return ok(value)
}

function emitGraph(
  context: ToolExecutionContext,
  graph: TaskGraph,
  openInDesktop: boolean | undefined,
  reason: string,
): void {
  context.emitEvent?.({
    type: openInDesktop ? 'team-graph-open' : 'team-graph-updated',
    graph,
    reason,
  })
}

export const execute: TypedToolExecute<typeof schema, TeamGraphToolResult> = async (
  args,
  maybeContext,
): Promise<Result<TeamGraphToolResult>> => {
  const contextResult = requireContext(maybeContext)
  if (!contextResult.ok) return contextResult
  const context = contextResult.value
  const store = getStore(context)
  const openInDesktop = args.openInDesktop ?? true

  switch (args.action) {
    case 'create': {
      const result = store.createGraph({
        name: args.name,
        tasks: args.tasks as CreateTaskNodeInput[] | undefined,
      })
      if (!result.ok) return result
      emitGraph(context, result.value, openInDesktop, args.reason ?? 'Team graph created.')
      return ok({
        graph: result.value,
        opened: openInDesktop,
        message: `Created team graph "${result.value.name}" with ${result.value.tasks.length} tasks.`,
      })
    }

    case 'create-workflow': {
      const template = args.template
      if (!template) return err(new Error('team_graph create-workflow requires template.'))
      const taskContext = requireString(args.taskContext, 'taskContext')
      if (!taskContext.ok) return taskContext
      const templateResult = createWorkflowTemplate({
        template: template as WorkflowTemplateName,
        taskContext: taskContext.value,
        name: args.name,
      })
      if (!templateResult.ok) return templateResult
      const result = store.createGraph(templateResult.value)
      if (!result.ok) return result
      const verdictTask = result.value.tasks.find((task) =>
        /verdict|synthesi|decision/i.test(task.title),
      )
      const messageResult = store.sendMessage({
        graphId: result.value.id,
        message:
          'Workflow template created. Verdict tasks must cite evidence and unresolved contradictions block automatic completion.',
        taskId: verdictTask?.id,
      })
      if (!messageResult.ok) return messageResult
      const refreshed = store.getGraph(result.value.id)
      if (!refreshed.ok) return refreshed
      emitGraph(context, refreshed.value, openInDesktop, args.reason ?? 'Workflow graph created.')
      return ok({
        graph: refreshed.value,
        opened: openInDesktop,
        message: `Created ${template} workflow graph "${refreshed.value.name}".`,
      })
    }

    case 'open':
    case 'get': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      const result = store.getGraph(graphId.value)
      if (!result.ok) return result
      if (args.action === 'open') {
        emitGraph(context, result.value, true, args.reason ?? 'Team graph opened.')
      }
      return ok({
        graph: result.value,
        opened: args.action === 'open',
        message: `${args.action === 'open' ? 'Opened' : 'Loaded'} team graph "${result.value.name}".`,
      })
    }

    case 'start':
    case 'pause':
    case 'fail':
    case 'cancel': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      const result =
        args.action === 'start'
          ? store.startGraph(graphId.value)
          : args.action === 'pause'
            ? store.pauseGraph(graphId.value, args.reason)
            : args.action === 'fail'
              ? store.failGraph(graphId.value, args.reason)
              : store.cancelGraph(graphId.value, args.reason)
      if (!result.ok) return result
      emitGraph(context, result.value, openInDesktop, `Team graph ${args.action}.`)
      return ok({
        graph: result.value,
        opened: openInDesktop,
        message: `Updated team graph "${result.value.name}" to ${result.value.status}.`,
      })
    }

    case 'cleanup': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      const result = store.cleanupGraph(graphId.value)
      if (!result.ok) return result
      return ok({
        cleaned: true,
        graphId: result.value.graphId,
        message: `Cleaned up team graph "${result.value.graphId}".`,
      })
    }

    case 'add-task': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      if (!args.task) return err(new Error('team_graph add-task requires task.'))
      const result = store.addTask(graphId.value, args.task as CreateTaskNodeInput)
      if (!result.ok) return result
      emitGraph(context, result.value.graph, openInDesktop, 'Team task added.')
      return ok({
        graph: result.value.graph,
        opened: openInDesktop,
        message: `Added task "${result.value.task.title}" to "${result.value.graph.name}".`,
      })
    }

    case 'assign-task': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      const taskId = requireString(args.taskId, 'taskId')
      if (!taskId.ok) return taskId
      const agentId = requireString(args.agentId, 'agentId')
      if (!agentId.ok) return agentId
      const result = store.assignTask({
        graphId: graphId.value,
        taskId: taskId.value,
        agentId: agentId.value,
      })
      if (!result.ok) return result
      emitGraph(context, result.value.graph, openInDesktop, 'Team task assigned.')
      return ok({
        graph: result.value.graph,
        opened: openInDesktop,
        message: `Assigned task "${result.value.task.title}" to ${agentId.value}.`,
      })
    }

    case 'send-message': {
      const graphId = requireString(args.graphId, 'graphId')
      if (!graphId.ok) return graphId
      const message = requireString(args.message, 'message')
      if (!message.ok) return message
      const result = store.sendMessage({
        graphId: graphId.value,
        message: message.value,
        agentId: args.agentId,
        taskId: args.taskId,
      })
      if (!result.ok) return result
      emitGraph(context, result.value.graph, openInDesktop, 'Team message recorded.')
      return ok({
        graph: result.value.graph,
        opened: openInDesktop,
        message: `Recorded team graph message for "${result.value.graph.name}".`,
      })
    }
  }
}
export const tier = 3
