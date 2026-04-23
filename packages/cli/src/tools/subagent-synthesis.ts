import type { SubAgentResult } from './subagent-result'

type SubAgentClaim = SubAgentResult['claims'][number]
type SubAgentEvidence = SubAgentClaim['evidence'][number]

export interface AgentClaimReference {
  agentId?: string
  resultIndex: number
  claimIndex: number
  claim: string
  evidence: SubAgentEvidence[]
  confidence: number
}

export interface ConflictingAgentClaims {
  topic: string
  reason: string
  claims: AgentClaimReference[]
}

export interface AgentVerdict {
  question: string
  consensus: string
  supportingClaims: AgentClaimReference[]
  conflictingClaims: ConflictingAgentClaims[]
  unsupportedClaims: AgentClaimReference[]
  reviewFindings: NonNullable<SubAgentResult['reviewFindings']>
  unresolvedRisks: string[]
  recommendedAction: string
}

export interface AgentSynthesisRun {
  agentId?: string
  status?: 'completed' | 'failed'
  result?: SubAgentResult
  error?: { message: string } | string
  resultValidation?: {
    valid: boolean
    warnings: string[]
  }
  stopReason?: string
}

export type AgentSynthesisInput = SubAgentResult | AgentSynthesisRun

const NEGATIVE_TERMS = new Set([
  'absent',
  'blocked',
  'cannot',
  'disabled',
  'doesnt',
  'fail',
  'failed',
  'fails',
  'false',
  'missing',
  'never',
  'no',
  'none',
  'not',
  'prevented',
  'unsupported',
  'without',
])

const POSITIVE_TERMS = new Set([
  'allowed',
  'can',
  'enabled',
  'exists',
  'found',
  'has',
  'pass',
  'passed',
  'passes',
  'present',
  'supported',
  'succeeds',
  'true',
  'uses',
  'with',
])

const TOPIC_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'are',
  'as',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
])

function isSubAgentResult(input: AgentSynthesisInput): input is SubAgentResult {
  return 'summary' in input && 'claims' in input
}

function normalizeRun(input: AgentSynthesisInput): AgentSynthesisRun {
  if (isSubAgentResult(input)) {
    return { status: 'completed', result: input }
  }
  return input
}

function errorMessage(error: AgentSynthesisRun['error']): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  return error.message
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n't\b/g, ' not')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function evidenceText(claim: AgentClaimReference): string {
  return claim.evidence
    .map((evidence) => {
      if ('excerpt' in evidence && evidence.excerpt) return evidence.excerpt
      if ('command' in evidence && evidence.command) return evidence.command
      if ('path' in evidence && evidence.path) return evidence.path
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function polarity(text: string): 'positive' | 'negative' | 'unknown' {
  const tokens = tokenize(text)
  let positive = 0
  let negative = 0

  for (const token of tokens) {
    if (POSITIVE_TERMS.has(token)) positive += 1
    if (NEGATIVE_TERMS.has(token)) negative += 1
  }

  if (positive > negative) return 'positive'
  if (negative > positive) return 'negative'
  return 'unknown'
}

function topicTokens(text: string): Set<string> {
  return new Set(
    tokenize(text).filter(
      (token) =>
        token.length > 2 &&
        !TOPIC_STOP_WORDS.has(token) &&
        !POSITIVE_TERMS.has(token) &&
        !NEGATIVE_TERMS.has(token),
    ),
  )
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const token of left) {
    if (right.has(token)) count += 1
  }
  return count
}

function haveOpposingPolarity(left: AgentClaimReference, right: AgentClaimReference): boolean {
  const leftPolarity = polarity(`${left.claim} ${evidenceText(left)}`)
  const rightPolarity = polarity(`${right.claim} ${evidenceText(right)}`)

  return (
    (leftPolarity === 'positive' && rightPolarity === 'negative') ||
    (leftPolarity === 'negative' && rightPolarity === 'positive')
  )
}

function areAboutSameTopic(left: AgentClaimReference, right: AgentClaimReference): boolean {
  const leftTopic = topicTokens(left.claim)
  const rightTopic = topicTokens(right.claim)
  const shared = overlap(leftTopic, rightTopic)
  const smallestTopicSize = Math.min(leftTopic.size, rightTopic.size)

  return shared >= 2 || (smallestTopicSize > 0 && shared >= smallestTopicSize)
}

function contradictionTopic(left: AgentClaimReference, right: AgentClaimReference): string {
  const leftTopic = topicTokens(left.claim)
  const rightTopic = topicTokens(right.claim)
  const shared = Array.from(leftTopic).filter((token) => rightTopic.has(token))
  return shared.length > 0 ? shared.join(' ') : 'opposing claims'
}

function dedupeRisks(risks: string[]): string[] {
  return Array.from(new Set(risks.map((risk) => risk.trim()).filter(Boolean)))
}

function formatAgentLabel(run: AgentSynthesisRun, resultIndex: number): string {
  return run.agentId ? `Subagent ${run.agentId}` : `Subagent result ${resultIndex + 1}`
}

function claimHasEvidence(claim: Pick<SubAgentClaim, 'evidence'>): boolean {
  return Array.isArray(claim.evidence) && claim.evidence.length > 0
}

function buildConsensus(
  supportingClaims: AgentClaimReference[],
  conflicts: ConflictingAgentClaims[],
): string {
  if (supportingClaims.length === 0 && conflicts.length === 0) {
    return 'No evidence-backed consensus was found.'
  }

  if (conflicts.length > 0) {
    return 'Evidence-backed claims conflict; do not treat the result as settled until the conflicting claims are resolved.'
  }

  const claims = supportingClaims.map((claim) => claim.claim)
  const uniqueClaims = Array.from(new Set(claims))
  if (uniqueClaims.length === 1) {
    return uniqueClaims[0]
  }

  return `Compatible evidence-backed claims support: ${uniqueClaims.join('; ')}.`
}

function buildRecommendedAction(verdict: Omit<AgentVerdict, 'recommendedAction'>): string {
  if (verdict.conflictingClaims.length > 0) {
    return 'Mention the contradictions before relying on the result, then gather targeted evidence to resolve them.'
  }

  if (verdict.unsupportedClaims.length > 0) {
    return 'Use the supporting claims only; verify or discard unsupported claims before relying on them.'
  }

  if (verdict.unresolvedRisks.length > 0) {
    return 'Proceed with the consensus while calling out unresolved risks from failed or uncertain subagents.'
  }

  return 'Proceed with the consensus and cite the supporting claims.'
}

export function synthesizeAgentVerdict(
  question: string,
  inputs: AgentSynthesisInput[],
): AgentVerdict {
  const unresolvedRisks: string[] = []
  const unsupportedClaims: AgentClaimReference[] = []
  const candidateClaims: AgentClaimReference[] = []
  const reviewFindings: NonNullable<SubAgentResult['reviewFindings']> = []

  inputs.forEach((input, resultIndex) => {
    const run = normalizeRun(input)
    const label = formatAgentLabel(run, resultIndex)

    if (run.status === 'failed') {
      const message = errorMessage(run.error) ?? run.stopReason ?? 'subagent failed'
      unresolvedRisks.push(`${label} failed: ${message}.`)
    }

    if (run.resultValidation && !run.resultValidation.valid) {
      for (const warning of run.resultValidation.warnings) {
        unresolvedRisks.push(`${label} returned invalid structured output: ${warning}.`)
      }
    }

    if (!run.result) {
      unresolvedRisks.push(`${label} did not provide a structured result.`)
      return
    }

    for (const uncertainty of run.result.uncertainty) {
      unresolvedRisks.push(`${label} reported uncertainty: ${uncertainty}.`)
    }

    if (run.result.reviewFindings) {
      reviewFindings.push(...run.result.reviewFindings)
    }

    run.result.claims.forEach((claim, claimIndex) => {
      const reference: AgentClaimReference = {
        ...(run.agentId ? { agentId: run.agentId } : {}),
        resultIndex,
        claimIndex,
        claim: claim.claim,
        evidence: claim.evidence ?? [],
        confidence: claim.confidence,
      }

      if (!claimHasEvidence(claim)) {
        unsupportedClaims.push(reference)
      } else {
        candidateClaims.push(reference)
      }
    })
  })

  const conflictIndexes = new Set<number>()
  const conflictingClaims: ConflictingAgentClaims[] = []

  for (let i = 0; i < candidateClaims.length; i += 1) {
    for (let j = i + 1; j < candidateClaims.length; j += 1) {
      const left = candidateClaims[i]
      const right = candidateClaims[j]
      if (!areAboutSameTopic(left, right) || !haveOpposingPolarity(left, right)) {
        continue
      }

      conflictIndexes.add(i)
      conflictIndexes.add(j)
      conflictingClaims.push({
        topic: contradictionTopic(left, right),
        reason: 'Claims address the same topic with opposing positive/negative assertions.',
        claims: [left, right],
      })
    }
  }

  if (conflictingClaims.length > 0) {
    unresolvedRisks.push(
      'Conflicting evidence-backed claims were detected and must be addressed before relying on the verdict.',
    )
  }

  const supportingClaims = candidateClaims.filter((_, index) => !conflictIndexes.has(index))
  const partialVerdict: Omit<AgentVerdict, 'recommendedAction'> = {
    question,
    consensus: buildConsensus(supportingClaims, conflictingClaims),
    supportingClaims,
    conflictingClaims,
    unsupportedClaims,
    reviewFindings,
    unresolvedRisks: dedupeRisks(unresolvedRisks),
  }

  return {
    ...partialVerdict,
    recommendedAction: buildRecommendedAction(partialVerdict),
  }
}
