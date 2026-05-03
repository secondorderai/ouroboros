import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TaskGraph, TaskNode, TaskNodeStatus, TeamAgent } from '../../shared/protocol'
import './TeamGraphDrawer.css'

interface TeamGraphDrawerProps {
  isOpen: boolean
  onClose: () => void
  graphId?: string | null
  graphSnapshot?: TaskGraph | null
}

const TASK_STATUS_ORDER: TaskNodeStatus[] = [
  'pending',
  'blocked',
  'running',
  'completed',
  'failed',
  'cancelled',
]

const UNASSIGNED_AGENT: TeamAgent = {
  id: 'Unassigned',
  status: 'active',
  activeTaskIds: [],
  updatedAt: '',
}

export function TeamGraphDrawer({
  isOpen,
  onClose,
  graphId,
  graphSnapshot,
}: TeamGraphDrawerProps): React.ReactElement | null {
  const [graph, setGraph] = useState<TaskGraph | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestSnapshotRef = React.useRef<TaskGraph | null>(null)

  const selectedTask = useMemo(
    () => graph?.tasks.find((task) => task.id === selectedTaskId) ?? graph?.tasks[0] ?? null,
    [graph, selectedTaskId],
  )

  const loadGraph = useCallback(async () => {
    const targetId = graphId ?? graph?.id
    if (!targetId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.ouroboros.rpc('team/get', { graphId: targetId })
      if (latestSnapshotRef.current?.id === result.graph.id) return
      setGraph(result.graph)
      setSelectedTaskId((current) => {
        if (current && result.graph.tasks.some((task) => task.id === current)) return current
        return result.graph.tasks[0]?.id ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load team graph')
    } finally {
      setLoading(false)
    }
  }, [graph?.id, graphId])

  useEffect(() => {
    if (!graphId) return
    setGraph(null)
    setSelectedTaskId(null)
  }, [graphId])

  useEffect(() => {
    if (!graphSnapshot) return
    latestSnapshotRef.current = graphSnapshot
    setGraph(graphSnapshot)
    setSelectedTaskId((current) => {
      if (current && graphSnapshot.tasks.some((task) => task.id === current)) return current
      return graphSnapshot.tasks[0]?.id ?? null
    })
  }, [graphSnapshot])

  useEffect(() => {
    if (!isOpen || graph || loading || graphSnapshot) return
    void loadGraph()
  }, [graph, graphSnapshot, isOpen, loadGraph, loading])

  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = window.ouroboros?.onNotification?.('team/graphUpdated', (params) => {
      if (graphId && params.graph.id !== graphId) return
      latestSnapshotRef.current = params.graph
      setGraph(params.graph)
      setSelectedTaskId((current) => {
        if (current && params.graph.tasks.some((task) => task.id === current)) return current
        return params.graph.tasks[0]?.id ?? null
      })
    })
    return unsubscribe
  }, [graphId, isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return createPortal(
    <div className='team-graph-backdrop' onClick={onClose}>
      <aside
        className='team-graph-drawer'
        role='dialog'
        aria-modal='true'
        aria-label='Team graph'
        onClick={(event) => event.stopPropagation()}
      >
        <header className='team-graph-header'>
          <div>
            <div className='team-graph-title-row'>
              <h2 className='team-graph-title'>{graph?.name ?? 'Team graph'}</h2>
              {graph && (
                <span className={`team-graph-status-pill team-graph-status-pill--${graph.status}`}>
                  {graph.status}
                </span>
              )}
            </div>
            <p className='team-graph-subtitle'>
              Inspect assignments, dependencies, gates, artifacts, and recent team events.
            </p>
          </div>
          <div className='team-graph-actions'>
            <button
              className='team-graph-refresh-button'
              onClick={() => void loadGraph()}
              disabled={loading || (!graphId && !graph)}
              aria-label='Refresh team graph'
            >
              <RefreshIcon />
              {loading ? 'Loading' : 'Refresh'}
            </button>
            <button
              className='team-graph-icon-button'
              onClick={onClose}
              aria-label='Close team graph'
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className='team-graph-content'>
          <main className='team-graph-main'>
            {loading && !graph ? (
              <div className='team-graph-loading'>Loading team graph...</div>
            ) : error ? (
              <div className='team-graph-alert' role='alert'>
                <strong>Team graph unavailable</strong>
                {error}
              </div>
            ) : graph ? (
              <TeamGraphOverview
                graph={graph}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={setSelectedTaskId}
              />
            ) : (
              <div className='team-graph-empty' data-testid='team-graph-empty'>
                <strong>No team graph open</strong>
                <p>
                  The agent will create one when you ask for a team plan, workflow, or task graph.
                  Try: &quot;create a team graph for shipping the auth refactor&quot;.
                </p>
              </div>
            )}
          </main>
          <TaskInspector graph={graph} task={selectedTask} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function TeamGraphOverview({
  graph,
  selectedTaskId,
  onSelectTask,
}: {
  graph: TaskGraph
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
}): React.ReactElement {
  const taskById = useMemo(() => new Map(graph.tasks.map((task) => [task.id, task])), [graph.tasks])
  const agents = useMemo(() => {
    const lanes = [...graph.agents]
    if (graph.tasks.some((task) => !task.assignedAgentId)) lanes.push(UNASSIGNED_AGENT)
    return lanes
  }, [graph.agents, graph.tasks])

  return (
    <>
      {graph.status === 'cancelled' && (
        <div className='team-graph-alert' data-testid='team-graph-cancellation'>
          <strong>Team cancelled</strong>
          {graph.cancellationReason ?? 'Work has been cancelled.'}{' '}
          {graph.agents.some((agent) => agent.status === 'active')
            ? 'Cleanup is waiting for active agents to stop.'
            : 'Cleanup is ready; no active agents remain.'}
        </div>
      )}
      <div className='team-graph-summary' aria-label='Task graph state summary'>
        {TASK_STATUS_ORDER.map((status) => {
          const count = graph.tasks.filter((task) => task.status === status).length
          return (
            <div
              key={status}
              className='team-graph-summary-item'
              data-testid={`team-graph-summary-${status}`}
            >
              <span className='team-graph-summary-value'>{count}</span>
              <span className='team-graph-summary-label'>{status}</span>
            </div>
          )
        })}
      </div>

      <h3 className='team-graph-section-title'>Agent assignments</h3>
      <div className='team-graph-lanes' data-testid='team-graph-lanes'>
        {agents.map((agent) => {
          const laneTasks = graph.tasks.filter((task) =>
            agent.id === UNASSIGNED_AGENT.id
              ? !task.assignedAgentId
              : task.assignedAgentId === agent.id,
          )
          return (
            <section
              key={agent.id}
              className='team-graph-agent-lane'
              aria-label={`${agent.id} tasks`}
            >
              <div className='team-graph-agent-header'>
                <span className='team-graph-agent-name'>{agent.id}</span>
                <span className='team-graph-agent-meta'>
                  {agent.status} · {laneTasks.length} task{laneTasks.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className='team-graph-task-list'>
                {laneTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    taskById={taskById}
                    selected={task.id === selectedTaskId}
                    onSelect={() => onSelectTask(task.id)}
                  />
                ))}
                {laneTasks.length === 0 && (
                  <div className='team-graph-detail-row'>No tasks assigned.</div>
                )}
              </div>
            </section>
          )
        })}
      </div>
      <h3 className='team-graph-section-title'>Workflow events</h3>
      <div className='team-graph-workflow-events' data-testid='team-graph-workflow-events'>
        {graph.messages.length > 0 ? (
          graph.messages
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 8)
            .map((event) => (
              <div key={event.id} className='team-graph-detail-row team-graph-event'>
                <span className='team-graph-event-message'>{event.message}</span>
                <span className='team-graph-event-meta'>
                  {event.agentId ?? 'Team'} · {formatTime(event.createdAt)}
                </span>
              </div>
            ))
        ) : (
          <div className='team-graph-detail-row'>No workflow events recorded.</div>
        )}
      </div>
    </>
  )
}

function TaskCard({
  task,
  taskById,
  selected,
  onSelect,
}: {
  task: TaskNode
  taskById: Map<string, TaskNode>
  selected: boolean
  onSelect: () => void
}): React.ReactElement {
  const dependencyNames = task.dependencies.map((id) => taskById.get(id)?.title ?? id)

  return (
    <button
      className={`team-graph-task-card team-graph-task-card--${task.status}${
        selected ? ' team-graph-task-card--selected' : ''
      }`}
      onClick={onSelect}
      data-testid={`team-graph-task-${task.status}`}
      aria-pressed={selected}
    >
      <span className='team-graph-task-status-bar' aria-hidden='true' />
      <span className='team-graph-task-body'>
        <span className='team-graph-task-topline'>
          <span className='team-graph-task-title'>{task.title}</span>
          <span className={`team-graph-task-state team-graph-task-state--${task.status}`}>
            {task.status}
          </span>
        </span>
        {task.description && (
          <span className='team-graph-task-description'>{task.description}</span>
        )}
        <span className='team-graph-task-links'>
          <span className='team-graph-chip team-graph-chip--agent'>
            Agent: {task.assignedAgentId ?? 'Unassigned'}
          </span>
          {dependencyNames.length > 0 ? (
            dependencyNames.map((name) => (
              <span key={name} className='team-graph-chip team-graph-chip--dependency'>
                Depends on: {name}
              </span>
            ))
          ) : (
            <span className='team-graph-chip'>No dependencies</span>
          )}
        </span>
      </span>
    </button>
  )
}

function TaskInspector({
  graph,
  task,
}: {
  graph: TaskGraph | null
  task: TaskNode | null
}): React.ReactElement {
  if (!graph || !task) {
    return (
      <aside className='team-graph-inspector'>
        <div className='team-graph-detail-empty'>
          Select a task to inspect its artifacts and gates.
        </div>
      </aside>
    )
  }

  const events = graph.messages
    .filter((message) => message.taskId === task.id)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)

  return (
    <aside className='team-graph-inspector' data-testid='team-graph-inspector'>
      <h3 className='team-graph-detail-title'>{task.title}</h3>
      <div className='team-graph-detail-meta'>
        <span className={`team-graph-task-state team-graph-task-state--${task.status}`}>
          {task.status}
        </span>
        <span className='team-graph-chip team-graph-chip--agent'>
          Agent: {task.assignedAgentId ?? 'Unassigned'}
        </span>
        {task.cancellationReason && (
          <span className='team-graph-chip'>{task.cancellationReason}</span>
        )}
      </div>
      {task.description && <div className='team-graph-detail-row'>{task.description}</div>}

      <DetailSection title='Required artifacts'>
        {task.requiredArtifacts.length > 0 ? (
          task.requiredArtifacts.map((artifact) => (
            <div key={artifact} className='team-graph-detail-row'>
              {artifact}
            </div>
          ))
        ) : (
          <div className='team-graph-detail-row'>No required artifacts.</div>
        )}
      </DetailSection>

      <DetailSection title='Quality gates'>
        {task.qualityGates.length > 0 ? (
          task.qualityGates.map((gate) => (
            <div key={gate.id} className='team-graph-detail-row team-graph-gate'>
              <span>
                {gate.description}
                {gate.required ? '' : ' (optional)'}
              </span>
              <span className={`team-graph-gate-status team-graph-gate-status--${gate.status}`}>
                {gate.status}
              </span>
            </div>
          ))
        ) : (
          <div className='team-graph-detail-row'>No quality gates.</div>
        )}
      </DetailSection>

      <DetailSection title='Recent events'>
        {events.length > 0 ? (
          events.map((event) => (
            <div key={event.id} className='team-graph-detail-row team-graph-event'>
              <span className='team-graph-event-message'>{event.message}</span>
              <span className='team-graph-event-meta'>
                {event.agentId ?? 'Team'} · {formatTime(event.createdAt)}
              </span>
            </div>
          ))
        ) : (
          <div className='team-graph-detail-row'>No recent task events.</div>
        )}
      </DetailSection>
    </aside>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className='team-graph-detail-section'>
      <h4 className='team-graph-detail-heading'>{title}</h4>
      <div className='team-graph-detail-list'>{children}</div>
    </section>
  )
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function CloseIcon(): React.ReactElement {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
    >
      <line x1='18' y1='6' x2='6' y2='18' />
      <line x1='6' y1='6' x2='18' y2='18' />
    </svg>
  )
}

function RefreshIcon(): React.ReactElement {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
    >
      <polyline points='23 4 23 10 17 10' />
      <polyline points='1 20 1 14 7 14' />
      <path d='M3.51 9a9 9 0 0 1 14.85-3.36L23 10' />
      <path d='M20.49 15a9 9 0 0 1-14.85 3.36L1 14' />
    </svg>
  )
}
