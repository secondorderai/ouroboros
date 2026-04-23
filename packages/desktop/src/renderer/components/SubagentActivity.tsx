import React, { useMemo, useState } from 'react'
import type { SubagentRun, SubagentRunUiStatus } from '../../shared/protocol'
import './SubagentActivity.css'

interface SubagentActivityListProps {
  runs: SubagentRun[]
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const started = Date.parse(startedAt)
  const ended = completedAt ? Date.parse(completedAt) : Date.now()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return ''

  const ms = ended - started
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

function statusLabel(status: SubagentRunUiStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
  }
}

const SubagentStatusIcon: React.FC<{ status: SubagentRunUiStatus }> = ({ status }) => {
  if (status === 'running') return <span className='subagent-activity__spinner' />
  if (status === 'completed') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <polyline points='4 12 9 17 20 6' />
      </svg>
    )
  }
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true'>
      <line x1='18' y1='6' x2='6' y2='18' />
      <line x1='6' y1='6' x2='18' y2='18' />
    </svg>
  )
}

const SubagentActivityRow: React.FC<{ run: SubagentRun }> = ({ run }) => {
  const [expanded, setExpanded] = useState(run.status !== 'running')
  const duration = useMemo(
    () => formatDuration(run.startedAt, run.completedAt),
    [run.startedAt, run.completedAt],
  )
  const hasDetails =
    Boolean(run.summary) ||
    Boolean(run.failureMessage) ||
    run.evidence.length > 0 ||
    Boolean(run.permissionLeases?.length) ||
    Boolean(run.workerDiff) ||
    run.uncertaintyCount > 0 ||
    Boolean(run.message)

  return (
    <div
      className={`subagent-activity subagent-activity--${run.status}`}
      data-testid='subagent-activity-row'
    >
      <button
        className='subagent-activity__header'
        type='button'
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${run.agentId} subagent ${statusLabel(run.status).toLowerCase()}`}
      >
        <span className='subagent-activity__status' aria-hidden='true'>
          <SubagentStatusIcon status={run.status} />
        </span>
        <span className='subagent-activity__main'>
          <span className='subagent-activity__title'>
            <span className='subagent-activity__role'>{run.agentId}</span>
            <span className='subagent-activity__task'>{run.task}</span>
          </span>
          <span className='subagent-activity__meta'>
            <span>{statusLabel(run.status)}</span>
            {duration && <span>{duration}</span>}
            <span>{run.evidenceCount} evidence</span>
            <span>{run.uncertaintyCount} uncertainty</span>
            {run.workerDiff && <span>{workerDiffStatusLabel(run.workerDiff.reviewStatus)}</span>}
          </span>
        </span>
        <svg className='subagent-activity__chevron' viewBox='0 0 24 24' aria-hidden='true'>
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>

      {expanded && hasDetails && (
        <div className='subagent-activity__body'>
          {run.message && <div className='subagent-activity__message'>{run.message}</div>}
          {run.summary && <div className='subagent-activity__summary'>{run.summary}</div>}
          {run.failureMessage && (
            <div className='subagent-activity__failure'>{run.failureMessage}</div>
          )}
          {run.evidence.length > 0 && (
            <div className='subagent-activity__evidence' aria-label='Subagent evidence'>
              {run.evidence.map((evidence, index) => (
                <span
                  key={`${evidence.type}-${evidence.label}-${index}`}
                  className='subagent-activity__evidence-chip'
                  title={evidence.label}
                >
                  {evidence.label}
                </span>
              ))}
            </div>
          )}
          {run.workerDiff && <WorkerDiffDetails workerDiff={run.workerDiff} />}
          {run.permissionLeases && run.permissionLeases.length > 0 && (
            <div className='subagent-activity__leases' aria-label='Permission leases'>
              {run.permissionLeases.map((lease) => (
                <div
                  key={lease.leaseId}
                  className={`subagent-activity__lease subagent-activity__lease--${lease.status}`}
                >
                  <div className='subagent-activity__lease-header'>
                    <span>
                      {lease.status === 'active'
                        ? 'Active lease'
                        : lease.status === 'pending'
                          ? 'Pending lease'
                          : 'Denied lease'}
                    </span>
                    <span>{lease.risk} risk</span>
                  </div>
                  <div className='subagent-activity__lease-summary'>{lease.riskSummary}</div>
                  <LeaseLine label='Tools' values={lease.requestedTools} />
                  <LeaseLine label='Paths' values={lease.requestedPaths} />
                  <LeaseLine label='Commands' values={lease.requestedBashCommands} />
                  {lease.expiresAt && (
                    <div className='subagent-activity__lease-line'>
                      Expires: {new Date(lease.expiresAt).toLocaleString()}
                    </div>
                  )}
                  {lease.denialReason && (
                    <div className='subagent-activity__lease-denial'>
                      Denied: {lease.denialReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function workerDiffStatusLabel(
  status: NonNullable<SubagentRun['workerDiff']>['reviewStatus'],
): string {
  switch (status) {
    case 'awaiting-review':
      return 'Awaiting review'
    case 'reviewed':
      return 'Reviewed'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'applied':
      return 'Applied'
    case 'blocked':
      return 'Blocked'
  }
}

function WorkerDiffDetails({
  workerDiff,
}: {
  workerDiff: NonNullable<SubagentRun['workerDiff']>
}): React.ReactElement {
  const testStatus = workerDiff.testResult
    ? `${workerDiff.testResult.status}: ${workerDiff.testResult.command}`
    : 'No test result'
  const diffLines =
    workerDiff.diffLineCount ?? (workerDiff.diff.trim() ? workerDiff.diff.split('\n').length : 0)

  return (
    <div className='subagent-activity__worker-diff' aria-label='Worker diff summary'>
      <div className='subagent-activity__worker-diff-header'>
        <span>Worker diff: {workerDiffStatusLabel(workerDiff.reviewStatus)}</span>
        <span>{workerDiff.changedFiles.length} files</span>
      </div>
      <div className='subagent-activity__worker-diff-line'>Task: {workerDiff.taskId}</div>
      <div className='subagent-activity__worker-diff-line'>Diff: {diffLines} lines</div>
      <div className='subagent-activity__worker-diff-line'>Tests: {testStatus}</div>
      {workerDiff.changedFiles.length > 0 && (
        <div className='subagent-activity__evidence' aria-label='Worker changed files'>
          {workerDiff.changedFiles.map((path) => (
            <span key={path} className='subagent-activity__evidence-chip' title={path}>
              {path}
            </span>
          ))}
        </div>
      )}
      {workerDiff.unresolvedRisks.length > 0 && (
        <div className='subagent-activity__worker-risks'>
          {workerDiff.unresolvedRisks.map((risk) => (
            <div key={risk}>{risk}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function LeaseLine({ label, values }: { label: string; values: string[] }): React.ReactElement {
  return (
    <div className='subagent-activity__lease-line'>
      {label}: {values.length > 0 ? values.join(', ') : 'None'}
    </div>
  )
}

export const SubagentActivityList: React.FC<SubagentActivityListProps> = ({ runs }) => {
  if (runs.length === 0) return null

  return (
    <div className='subagent-activity-list' data-testid='subagent-activity-list'>
      {runs.map((run) => (
        <SubagentActivityRow key={run.runId} run={run} />
      ))}
    </div>
  )
}
