import { useEffect } from 'react';
import { useConversationStore } from '../stores/conversationStore';
import type {
  AgentTextParams,
  AgentToolCallStartParams,
  AgentToolCallEndParams,
  AgentTurnCompleteParams,
  AgentErrorParams,
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

    const unsubs = [
      api.onNotification('agent/text', (params) => {
        handleAgentText(params as AgentTextParams);
      }),
      api.onNotification('agent/toolCallStart', (params) => {
        handleToolCallStart(params as AgentToolCallStartParams);
      }),
      api.onNotification('agent/toolCallEnd', (params) => {
        handleToolCallEnd(params as AgentToolCallEndParams);
      }),
      api.onNotification('agent/turnComplete', (params) => {
        handleTurnComplete(params as AgentTurnCompleteParams);
      }),
      api.onNotification('agent/error', (params) => {
        handleAgentError(params as AgentErrorParams);
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, []);
}
