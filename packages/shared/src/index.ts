/**
 * @ouroboros/shared — Types shared between CLI and Desktop packages
 *
 * This package contains type definitions and schemas that both the CLI
 * and the Electron desktop app need. It avoids duplication and ensures
 * the JSON-RPC protocol types are always in sync.
 */

export { type Result, ok, err } from './result'
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from './json-rpc-types'
export { JSON_RPC_ERROR_CODES } from './json-rpc-types'
export type {
  AgentTextNotification,
  AgentToolCallStartNotification,
  AgentToolCallEndNotification,
  AgentTurnCompleteNotification,
  AgentErrorNotification,
  RSIReflectionNotification,
  RSICrystallizationNotification,
  RSIDreamNotification,
  RSIErrorNotification,
  ApprovalRequestNotification,
  ProtocolNotification,
} from './protocol'
export type {
  SessionSummary,
  SkillEntry,
  EvolutionEntryType,
  ApprovalRequest,
} from './domain-types'
