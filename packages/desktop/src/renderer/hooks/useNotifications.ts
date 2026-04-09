import { useEffect } from 'react';
import { useConversationStore } from '../stores/conversationStore';
import { addApproval, loadApprovals, toPendingApproval } from '../stores/approvalStore'
import type {
  ApprovalRequestNotification,
} from '../../shared/protocol';

/**
 * Subscribes to all relevant IPC notifications from the CLI via
 * `window.ouroboros.onNotification` and dispatches them to the
 * conversation store.
 *
 * Should be called once at the top level of the app.
 */
export function useNotifications(): void {
  useEffect(() => {
    const api = window.ouroboros;
    if (!api) return;

    const {
      handleAgentText,
      handleToolCallStart,
      handleToolCallEnd,
      handleTurnComplete,
      handleAgentError,
    } = useConversationStore.getState();

    loadApprovals().catch((error) => {
      console.error('approval/list failed:', error)
    })

    const unsubs = [
      api.onNotification('agent/text', (params) => {
        handleAgentText(params);
      }),
      api.onNotification('agent/toolCallStart', (params) => {
        handleToolCallStart(params);
      }),
      api.onNotification('agent/toolCallEnd', (params) => {
        handleToolCallEnd(params);
      }),
      api.onNotification('agent/turnComplete', (params) => {
        handleTurnComplete(params);
      }),
      api.onNotification('agent/error', (params) => {
        handleAgentError(params);
      }),
      api.onNotification('approval/request', (params: ApprovalRequestNotification) => {
        addApproval(toPendingApproval(params))
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, []);
}
