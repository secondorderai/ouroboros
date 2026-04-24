import { err, ok, type Result } from '@src/types'

export type TaskGraphStatus = 'draft' | 'running' | 'paused' | 'failed' | 'cancelled' | 'completed'
export type TaskNodeStatus =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type TeamAgentStatus = 'active' | 'cancelled' | 'completed'

export interface QualityGate {
  id: string
  description: string
  required: boolean
  status: 'pending' | 'passed' | 'failed'
}

export interface TaskNode {
  id: string
  title: string
  description?: string
  status: TaskNodeStatus
  dependencies: string[]
  assignedAgentId?: string
  requiredArtifacts: string[]
  qualityGates: QualityGate[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancellationReason?: string
}

export interface TeamAgent {
  id: string
  status: TeamAgentStatus
  activeTaskIds: string[]
  updatedAt: string
}

export interface TeamMessage {
  id: string
  message: string
  agentId?: string
  taskId?: string
  createdAt: string
}

export interface TaskGraph {
  id: string
  name: string
  status: TaskGraphStatus
  tasks: TaskNode[]
  agents: TeamAgent[]
  messages: TeamMessage[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  cancelledAt?: string
  cancellationReason?: string
}

export interface CreateTaskGraphInput {
  name?: string
  tasks?: CreateTaskNodeInput[]
}

export interface CreateTaskNodeInput {
  id?: string
  title: string
  description?: string
  dependencies?: string[]
  assignedAgentId?: string
  requiredArtifacts?: string[]
  qualityGates?: Array<Partial<QualityGate> & { description: string }>
}

export interface AssignTaskInput {
  graphId: string
  taskId: string
  agentId: string
}

export interface TaskGraphPersistence {
  saveTaskGraph(graph: TaskGraph): Result<void>
  loadTaskGraph(graphId: string): Result<TaskGraph | null>
  deleteTaskGraph(graphId: string): Result<void>
}

export class TaskGraphStore {
  private graphs = new Map<string, TaskGraph>()
  private lockedGraphs = new Set<string>()

  constructor(private persistence?: TaskGraphPersistence) {}

  createGraph(input: CreateTaskGraphInput = {}): Result<TaskGraph> {
    const now = new Date().toISOString()
    const graph: TaskGraph = {
      id: crypto.randomUUID(),
      name: input.name?.trim() || 'Team Task Graph',
      status: 'draft',
      tasks: [],
      agents: [],
      messages: [],
      createdAt: now,
      updatedAt: now,
    }

    for (const taskInput of input.tasks ?? []) {
      const taskResult = this.buildTask(graph, taskInput, now)
      if (!taskResult.ok) return taskResult
      graph.tasks.push(taskResult.value)
    }
    this.refreshBlockedTasks(graph, now)
    this.graphs.set(graph.id, graph)
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  getGraph(graphId: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    if (!graph) return err(new Error(`Task graph "${graphId}" not found`))
    return ok(cloneGraph(graph))
  }

  findGraphContainingTask(taskId: string): Result<TaskGraph | null> {
    for (const graph of this.graphs.values()) {
      if (graph.tasks.some((task) => task.id === taskId)) {
        return ok(cloneGraph(graph))
      }
    }
    return ok(null)
  }

  startGraph(graphId: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const now = new Date().toISOString()
    graph.status = 'running'
    graph.startedAt ??= now
    graph.updatedAt = now
    this.refreshBlockedTasks(graph, now)
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  addTask(
    graphId: string,
    input: CreateTaskNodeInput,
  ): Result<{ graph: TaskGraph; task: TaskNode }> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    if (graph.status === 'cancelled') return err(new Error('Cannot add tasks to a cancelled team'))

    const now = new Date().toISOString()
    const taskResult = this.buildTask(graph, input, now)
    if (!taskResult.ok) return taskResult
    graph.tasks.push(taskResult.value)
    graph.updatedAt = now
    this.refreshBlockedTasks(graph, now)
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok({ graph: cloneGraph(graph), task: cloneTask(taskResult.value) })
  }

  assignTask(input: AssignTaskInput): Result<{ graph: TaskGraph; task: TaskNode }> {
    return this.withGraphLock(input.graphId, () => this.assignTaskLocked(input))
  }

  startTask(input: AssignTaskInput): Result<{ graph: TaskGraph; task: TaskNode }> {
    return this.withGraphLock(input.graphId, () => this.startTaskLocked(input))
  }

  private assignTaskLocked(input: AssignTaskInput): Result<{ graph: TaskGraph; task: TaskNode }> {
    const graphResult = this.getMutableGraph(input.graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    if (graph.status === 'cancelled')
      return err(new Error('Cannot assign tasks in a cancelled team'))

    const now = new Date().toISOString()
    this.refreshBlockedTasks(graph, now)
    const task = graph.tasks.find((candidate) => candidate.id === input.taskId)
    if (!task) return err(new Error(`Task "${input.taskId}" not found`))
    if (task.status === 'blocked') {
      return err(new Error(`Task "${input.taskId}" is blocked by incomplete dependencies`))
    }
    if (task.status !== 'pending') {
      return err(new Error(`Task "${input.taskId}" is not claimable because it is ${task.status}`))
    }
    if (task.assignedAgentId) {
      return err(new Error(`Task "${input.taskId}" is already assigned`))
    }

    task.status = 'running'
    task.assignedAgentId = input.agentId
    task.updatedAt = now
    const agent = this.getOrCreateAgent(graph, input.agentId, now)
    agent.status = 'active'
    agent.updatedAt = now
    if (!agent.activeTaskIds.includes(task.id)) agent.activeTaskIds.push(task.id)
    graph.status = graph.status === 'draft' ? 'running' : graph.status
    graph.startedAt ??= now
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok({ graph: cloneGraph(graph), task: cloneTask(task) })
  }

  private startTaskLocked(input: AssignTaskInput): Result<{ graph: TaskGraph; task: TaskNode }> {
    const graphResult = this.getMutableGraph(input.graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    if (graph.status === 'cancelled')
      return err(new Error('Cannot start tasks in a cancelled team'))

    const now = new Date().toISOString()
    this.refreshBlockedTasks(graph, now)
    const task = graph.tasks.find((candidate) => candidate.id === input.taskId)
    if (!task) return err(new Error(`Task "${input.taskId}" not found`))
    if (task.status === 'blocked') {
      return err(new Error(`Task "${input.taskId}" is blocked by incomplete dependencies`))
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return err(new Error(`Task "${input.taskId}" is not startable because it is ${task.status}`))
    }

    task.status = 'running'
    task.assignedAgentId ??= input.agentId
    task.updatedAt = now
    const agent = this.getOrCreateAgent(graph, task.assignedAgentId, now)
    agent.status = 'active'
    agent.updatedAt = now
    if (!agent.activeTaskIds.includes(task.id)) agent.activeTaskIds.push(task.id)
    graph.status = graph.status === 'draft' ? 'running' : graph.status
    graph.startedAt ??= now
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok({ graph: cloneGraph(graph), task: cloneTask(task) })
  }

  private withGraphLock<T>(graphId: string, fn: () => Result<T>): Result<T> {
    if (this.lockedGraphs.has(graphId)) {
      return err(new Error(`Task graph "${graphId}" is locked by another claim attempt`))
    }
    this.lockedGraphs.add(graphId)
    try {
      return fn()
    } finally {
      this.lockedGraphs.delete(graphId)
    }
  }

  completeTask(graphId: string, taskId: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const task = graph.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return err(new Error(`Task "${taskId}" not found`))

    const now = new Date().toISOString()
    task.status = 'completed'
    task.completedAt = now
    task.updatedAt = now
    if (task.assignedAgentId) {
      const agent = graph.agents.find((candidate) => candidate.id === task.assignedAgentId)
      if (agent) {
        agent.activeTaskIds = agent.activeTaskIds.filter((id) => id !== task.id)
        agent.status = agent.activeTaskIds.length === 0 ? 'completed' : 'active'
        agent.updatedAt = now
      }
    }
    this.refreshBlockedTasks(graph, now)
    if (
      graph.tasks.length > 0 &&
      graph.tasks.every((candidate) => candidate.status === 'completed')
    ) {
      graph.status = 'completed'
    }
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  failTask(graphId: string, taskId: string, reason?: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const task = graph.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return err(new Error(`Task "${taskId}" not found`))

    const now = new Date().toISOString()
    task.status = 'failed'
    task.cancellationReason = reason
    task.updatedAt = now
    if (task.assignedAgentId) {
      const agent = graph.agents.find((candidate) => candidate.id === task.assignedAgentId)
      if (agent) {
        agent.activeTaskIds = agent.activeTaskIds.filter((id) => id !== task.id)
        agent.status = agent.activeTaskIds.length === 0 ? 'completed' : 'active'
        agent.updatedAt = now
      }
    }
    graph.status = 'failed'
    graph.cancellationReason = reason
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  cancelGraph(graphId: string, reason?: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const now = new Date().toISOString()
    graph.status = 'cancelled'
    graph.cancelledAt = now
    graph.cancellationReason = reason
    graph.updatedAt = now
    for (const task of graph.tasks) {
      if (task.status === 'pending' || task.status === 'blocked' || task.status === 'running') {
        task.status = 'cancelled'
        task.cancellationReason = reason
        task.updatedAt = now
      }
    }
    for (const agent of graph.agents) {
      if (agent.status === 'active') {
        agent.status = 'cancelled'
        agent.activeTaskIds = []
        agent.updatedAt = now
      }
    }
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  cleanupGraph(graphId: string): Result<{ cleaned: true; graphId: string }> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const activeAgents = graph.agents.filter((agent) => agent.status === 'active')
    if (activeAgents.length > 0) {
      return err(
        new Error(
          `Cannot cleanup team while agents are active: ${activeAgents
            .map((agent) => agent.id)
            .join(', ')}`,
        ),
      )
    }
    this.graphs.delete(graphId)
    const deleteResult = this.persistence?.deleteTaskGraph(graphId)
    if (deleteResult && !deleteResult.ok) return deleteResult
    return ok({ cleaned: true, graphId })
  }

  sendMessage(input: {
    graphId: string
    message: string
    agentId?: string
    taskId?: string
  }): Result<{ graph: TaskGraph; message: TeamMessage }> {
    const graphResult = this.getMutableGraph(input.graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    if (input.taskId && !graph.tasks.some((task) => task.id === input.taskId)) {
      return err(new Error(`Task "${input.taskId}" not found`))
    }

    const now = new Date().toISOString()
    const message: TeamMessage = {
      id: crypto.randomUUID(),
      message: input.message,
      agentId: input.agentId,
      taskId: input.taskId,
      createdAt: now,
    }
    graph.messages.push(message)
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok({ graph: cloneGraph(graph), message: { ...message } })
  }

  failGraph(graphId: string, reason?: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const now = new Date().toISOString()
    graph.status = 'failed'
    graph.cancellationReason = reason
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  pauseGraph(graphId: string, reason?: string): Result<TaskGraph> {
    const graphResult = this.getMutableGraph(graphId)
    if (!graphResult.ok) return graphResult
    const graph = graphResult.value
    const now = new Date().toISOString()
    graph.status = 'paused'
    graph.cancellationReason = reason
    graph.updatedAt = now
    const saveResult = this.persistGraph(graph)
    if (!saveResult.ok) return saveResult
    return ok(cloneGraph(graph))
  }

  private buildTask(graph: TaskGraph, input: CreateTaskNodeInput, now: string): Result<TaskNode> {
    const title = input.title?.trim()
    if (!title) return err(new Error('Task title is required'))
    const id = input.id?.trim() || crypto.randomUUID()
    if (graph.tasks.some((task) => task.id === id)) {
      return err(new Error(`Task "${id}" already exists`))
    }
    const dependencies = [...new Set(input.dependencies ?? [])]
    const missingDependency = dependencies.find(
      (dependencyId) => !graph.tasks.some((task) => task.id === dependencyId),
    )
    if (missingDependency) {
      return err(new Error(`Dependency "${missingDependency}" does not exist`))
    }

    const task: TaskNode = {
      id,
      title,
      description: input.description,
      status: dependencies.length > 0 ? 'blocked' : 'pending',
      dependencies,
      assignedAgentId: input.assignedAgentId,
      requiredArtifacts: input.requiredArtifacts ?? [],
      qualityGates: (input.qualityGates ?? []).map((gate) => ({
        id: gate.id?.trim() || crypto.randomUUID(),
        description: gate.description,
        required: gate.required ?? true,
        status: gate.status ?? 'pending',
      })),
      createdAt: now,
      updatedAt: now,
    }
    return ok(task)
  }

  private refreshBlockedTasks(graph: TaskGraph, now: string): void {
    for (const task of graph.tasks) {
      if (task.status !== 'blocked') continue
      const dependenciesComplete = task.dependencies.every((dependencyId) => {
        const dependency = graph.tasks.find((candidate) => candidate.id === dependencyId)
        return dependency?.status === 'completed'
      })
      if (dependenciesComplete) {
        task.status = 'pending'
        task.updatedAt = now
      }
    }
  }

  private getOrCreateAgent(graph: TaskGraph, agentId: string, now: string): TeamAgent {
    let agent = graph.agents.find((candidate) => candidate.id === agentId)
    if (!agent) {
      agent = { id: agentId, status: 'active', activeTaskIds: [], updatedAt: now }
      graph.agents.push(agent)
    }
    return agent
  }

  private persistGraph(graph: TaskGraph): Result<void> {
    return this.persistence?.saveTaskGraph(cloneGraph(graph)) ?? ok(undefined)
  }

  private getMutableGraph(graphId: string): Result<TaskGraph> {
    let graph = this.graphs.get(graphId)
    if (!graph && this.persistence) {
      const loadResult = this.persistence.loadTaskGraph(graphId)
      if (!loadResult.ok) return loadResult
      if (loadResult.value) {
        graph = loadResult.value
        this.graphs.set(graph.id, graph)
      }
    }
    if (!graph) return err(new Error(`Task graph "${graphId}" not found`))
    return ok(graph)
  }
}

function cloneGraph(graph: TaskGraph): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map(cloneTask),
    agents: graph.agents.map((agent) => ({
      ...agent,
      activeTaskIds: [...agent.activeTaskIds],
    })),
    messages: graph.messages.map((message) => ({ ...message })),
  }
}

function cloneTask(task: TaskNode): TaskNode {
  return {
    ...task,
    dependencies: [...task.dependencies],
    requiredArtifacts: [...task.requiredArtifacts],
    qualityGates: task.qualityGates.map((gate) => ({ ...gate })),
  }
}
