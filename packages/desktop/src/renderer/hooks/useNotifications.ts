import { useEffect } from 'react'
import { useConversationStore } from '../stores/conversationStore'
import { addApproval, loadApprovals, toPendingApproval } from '../stores/approvalStore'
import { addAskUserRequest, clearAskUserRequests } from '../stores/askUserStore'
import { useArtifactsStore } from '../stores/artifactsStore'
import type { ApprovalRequestNotification } from '../../shared/protocol'

/**
 * Subscribes to all relevant IPC notifications from the CLI via
 * `window.ouroboros.onNotification` and dispatches them to the
 * conversation store.
 *
 * Should be called once at the top level of the app.
 */
export function useNotifications(): void {
  useEffect(() => {
    const api = window.ouroboros
    if (!api) return

    const {
      handleContextUsage,
      handleAgentText,
      handleToolCallStart,
      handleToolCallEnd,
      handleTurnComplete,
      handleAgentError,
      handleSteerInjected,
      handleSteerOrphaned,
      handleTurnAborted,
      handleSubagentStarted,
      handleSubagentUpdated,
      handleSubagentCompleted,
      handleSubagentFailed,
      handlePermissionLeaseUpdated,
      handleSkillActivated,
      handlePlanSubmitted,
    } = useConversationStore.getState()

    loadApprovals().catch((error) => {
      console.error('approval/list failed:', error)
    })

    const unsubs = [
      api.onNotification('agent/contextUsage', (params) => {
        handleContextUsage(params)
      }),
      api.onNotification('agent/text', (params) => {
        handleAgentText(params)
      }),
      api.onNotification('agent/toolCallStart', (params) => {
        handleToolCallStart(params)
      }),
      api.onNotification('agent/toolCallEnd', (params) => {
        handleToolCallEnd(params)
      }),
      api.onNotification('agent/turnComplete', (params) => {
        handleTurnComplete(params)
      }),
      api.onNotification('agent/error', (params) => {
        handleAgentError(params)
      }),
      api.onNotification('agent/steerInjected', (params) => {
        handleSteerInjected(params)
      }),
      api.onNotification('agent/steerOrphaned', (params) => {
        handleSteerOrphaned(params)
      }),
      api.onNotification('agent/turnAborted', (params) => {
        handleTurnAborted(params)
      }),
      api.onNotification('agent/subagentStarted', (params) => {
        handleSubagentStarted(params)
      }),
      api.onNotification('agent/subagentUpdated', (params) => {
        handleSubagentUpdated(params)
      }),
      api.onNotification('agent/subagentCompleted', (params) => {
        handleSubagentCompleted(params)
      }),
      api.onNotification('agent/subagentFailed', (params) => {
        handleSubagentFailed(params)
      }),
      api.onNotification('agent/permissionLeaseUpdated', (params) => {
        handlePermissionLeaseUpdated(params)
      }),
      api.onNotification('skill/activated', (params) => {
        handleSkillActivated(params)
      }),
      api.onNotification('approval/request', (params: ApprovalRequestNotification) => {
        addApproval(toPendingApproval(params))
        if (params.lease) {
          handlePermissionLeaseUpdated({
            ...params.lease,
            status: params.lease.status ?? 'pending',
          })
        }
      }),
      api.onNotification('askUser/request', (params) => {
        addAskUserRequest(params)
      }),
      api.onNotification('mode/planSubmitted', (params) => {
        handlePlanSubmitted(params)
      }),
      api.onNotification('agent/artifactCreated', (params) => {
        useArtifactsStore.getState().handleArtifactCreated(params)
      }),
      api.onCLIStatus((status) => {
        if (status === 'error' || status === 'restarting') {
          clearAskUserRequests()
        }
      }),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [])
}
