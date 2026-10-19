import { modelMessageSchema } from 'ai'
import type { AssistantResponseState } from './types'

/** Validate persisted state without rewriting or stripping signed provider fields. */
export function readAssistantState(value: unknown): AssistantResponseState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as AssistantResponseState
  if (
    typeof state.provider !== 'string' ||
    typeof state.modelId !== 'string' ||
    state.message?.role !== 'assistant' ||
    !modelMessageSchema.safeParse(state.message).success
  )
    return undefined
  return state
}
