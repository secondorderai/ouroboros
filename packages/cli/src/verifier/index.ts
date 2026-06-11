/**
 * Verifier Model — public API.
 *
 * The completion gate: a fresh-context LLM pass that judges the agent's
 * candidate answer against the task and tool-call evidence before the ReAct
 * loop returns.
 */
export {
  failureSignature,
  verifierFailureSchema,
  verifierVerdictSchema,
  type VerifierEvidenceItem,
  type VerifierFailure,
  type VerifierReport,
  type VerifierVerdict,
} from './types'
export { buildVerifierPrompt, verify, type VerifyInput } from './verify'
export {
  buildDoneContractPrompt,
  doneContractSchema,
  extractDoneContract,
  type DoneContract,
  type ExtractDoneContractInput,
} from './contract'
