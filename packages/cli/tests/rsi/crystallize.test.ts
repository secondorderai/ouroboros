import { describe, test, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import {
  ReflectionRecordSchema,
  reflect,
  shouldCrystallize,
  proposeCrystallizationsFromObservations,
  reflectFromObservationPatterns,
  generateSkill,
  writeSkillToStaging,
  parseSkillResponse,
  validateSkillName,
  checkNameUniqueness,
  validateRoundTrip,
  crystallize,
  type ReflectionRecord,
  type ObservationCrystallizationSession,
} from '@src/rsi/crystallize'
import type { ObservationRecord, ReflectionCheckpoint } from '@src/rsi/types'
import type { SkillCatalogEntry } from '@src/tools/skill-manager'
import { createExecute, type SkillGenInput } from '@src/tools/skill-gen'
import { makeTempDir, cleanupTempDir } from '../helpers/test-utils'

// ── Mock LLM helpers ─────────────────────────────────────────────────

/**
 * Create a mock LanguageModelV3 that returns a predefined text response.
 * Uses the V3 specification format that the AI SDK expects.
 */
function createMockLLM(responseText: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: responseText }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: { inputTokens: 10, outputTokens: 20 },
      warnings: [],
    }),

    doStream: async () => {
      throw new Error('Streaming not implemented in mock')
    },
  } as unknown as LanguageModel
}

/**
 * Create a mock LLM that throws an error.
 */
function createErrorLLM(errorMessage: string): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    doGenerate: async () => {
      throw new Error(errorMessage)
    },

    doStream: async () => {
      throw new Error(errorMessage)
    },
  } as unknown as LanguageModel
}

/**
 * Create a mock model compatible with generateText/generateResponse.
 */
function mockModelReturning(text: string): LanguageModel {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-generate-model',
    supportedUrls: {},

    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 10,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),

    doStream: async () => {
      throw new Error('doStream not used by generateText')
    },
  }

  return model as LanguageModel
}

function createCapturingLLM(options?: {
  provider?: string
  modelId?: string
  responseText?: string
}): {
  llm: LanguageModel
  doGenerateCalls: LanguageModelV3CallOptions[]
} {
  const doGenerateCalls: LanguageModelV3CallOptions[] = []
  const responseText = options?.responseText ?? VALID_LLM_OUTPUT

  const llm: LanguageModel = {
    specificationVersion: 'v3',
    provider: options?.provider ?? 'mock',
    modelId: options?.modelId ?? 'mock-model',
    supportedUrls: {},

    doGenerate: async (callOptions: LanguageModelV3CallOptions) => {
      doGenerateCalls.push(callOptions)
      return {
        content: [{ type: 'text' as const, text: responseText }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }
    },

    doStream: async () => {
      throw new Error('doStream not used by generateText')
    },
  } as unknown as LanguageModel

  return { llm, doGenerateCalls }
}

// ── Skill generation fixtures ────────────────────────────────────────

function makeReflection(overrides?: Partial<ReflectionRecord>): ReflectionRecord {
  return {
    taskSummary: 'Implemented cursor-based pagination for a REST API',
    novelty: 0.9,
    generalizability: 0.85,
    keySteps: [
      'Define a cursor schema using Zod',
      'Implement the paginate() helper that wraps DB queries',
      'Return next_cursor in the response body',
    ],
    shouldCrystallize: true,
    proposedSkillName: 'test-skill',
    proposedSkillDescription: 'Generates cursor-based pagination for REST APIs',
    reasoning: 'Cursor-based pagination is a common pattern applicable across many REST APIs.',
    ...overrides,
  }
}

function makeObservation(
  sessionId: string,
  id: string,
  observedAt: string,
  kind: ObservationRecord['kind'],
  summary: string,
  overrides?: Partial<ObservationRecord>,
): ObservationRecord {
  return {
    id,
    sessionId,
    observedAt,
    kind,
    summary,
    evidence: [],
    priority: 'high',
    tags: [],
    ...overrides,
  }
}

function makeCheckpoint(
  sessionId: string,
  updatedAt: string,
  overrides?: Partial<ReflectionCheckpoint>,
): ReflectionCheckpoint {
  return {
    sessionId,
    updatedAt,
    goal: '',
    currentPlan: [],
    constraints: [],
    decisionsMade: [],
    filesInPlay: [],
    completedWork: [],
    openLoops: [],
    nextBestStep: '',
    durableMemoryCandidates: [],
    skillCandidates: [],
    ...overrides,
  }
}

/** Well-formed LLM output with all three required blocks */
const VALID_LLM_OUTPUT = `Here is the generated skill:

\`\`\`description
Generates cursor-based pagination logic for REST APIs. Activate when the user needs to implement paginated endpoints over database query results, handling cursor encoding, page size limits, and next-page token generation.
\`\`\`

\`\`\`markdown
# Cursor-Based Pagination for REST APIs

## When to Use

Apply this skill when building REST API endpoints that return paginated collections.

## Steps

1. **Define a cursor schema** — Use Zod to validate the cursor parameter from the request.
2. **Implement paginate() helper** — Wrap your database query to accept cursor and limit params.
3. **Return next_cursor** — Include a \`next_cursor\` field in the response for the client.

## Example

\\\`\\\`\\\`typescript
const result = await paginate(db, { cursor, limit: 20 });
return { data: result.items, next_cursor: result.nextCursor };
\\\`\\\`\\\`

## Edge Cases

- If cursor is invalid or expired, return a 400 error with a clear message.
- If limit is 0 or negative, default to 20.
\`\`\`

\`\`\`typescript
import { describe, it, expect } from 'bun:test'

describe('cursor-based pagination', () => {
  it('should encode and decode cursor correctly', () => {
    const id = 42
    const cursor = Buffer.from(String(id)).toString('base64')
    const decoded = Number(Buffer.from(cursor, 'base64').toString())
    expect(decoded).toBe(id)
  })

  it('should handle empty cursor (first page)', () => {
    const cursor = undefined
    const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString()) : 0
    expect(offset).toBe(0)
  })
})
\`\`\`
`

// ═══════════════════════════════════════════════════════════════════════
// ── Part 1: Reflection tests (Ticket 01) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

describe('ReflectionRecordSchema', () => {
  test('validates a complete well-formed record', () => {
    const record = {
      taskSummary: 'Built a CLI tool',
      novelty: 0.8,
      generalizability: 0.9,
      proposedSkillName: 'cli-builder',
      proposedSkillDescription: 'Generates CLI tools from spec',
      keySteps: ['Parse spec', 'Generate commands', 'Wire up args'],
      reasoning: 'Novel approach to CLI generation',
      shouldCrystallize: true,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(true)
  })

  test('validates a minimal record (without optional fields)', () => {
    const record = {
      taskSummary: 'Fixed a bug',
      novelty: 0.2,
      generalizability: 0.3,
      reasoning: 'Standard debugging approach',
      shouldCrystallize: false,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(true)
  })

  test('rejects record with out-of-range novelty', () => {
    const record = {
      taskSummary: 'Did a thing',
      novelty: 1.5,
      generalizability: 0.5,
      reasoning: 'Some reasoning',
      shouldCrystallize: false,
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
  })

  test('rejects record with missing required fields', () => {
    const record = {
      taskSummary: 'Did a thing',
      // missing novelty, generalizability, reasoning, shouldCrystallize
    }

    const result = ReflectionRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
  })
})

describe('reflect()', () => {
  // -----------------------------------------------------------------------
  // Feature test: Reflection produces valid record
  // -----------------------------------------------------------------------
  test('produces a valid ReflectionRecord from well-formed LLM response', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Implemented a caching layer for API responses',
      novelty: 0.75,
      generalizability: 0.8,
      proposedSkillName: 'api-cache',
      proposedSkillDescription: 'Implements caching for external API calls with TTL support',
      keySteps: ['Identify cacheable endpoints', 'Add cache middleware', 'Set TTL policies'],
      reasoning: 'This caching pattern is broadly applicable and not covered by existing skills.',
      shouldCrystallize: true,
    })

    const llm = createMockLLM(mockResponse)
    const result = await reflect('Implemented a caching layer for API responses', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Validate against schema
    const schemaResult = ReflectionRecordSchema.safeParse(result.value)
    expect(schemaResult.success).toBe(true)

    expect(result.value.novelty).toBe(0.75)
    expect(result.value.generalizability).toBe(0.8)
    expect(result.value.proposedSkillName).toBe('api-cache')
    expect(result.value.shouldCrystallize).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Feature test: Existing skills reduce novelty (prompt contains skills)
  // -----------------------------------------------------------------------
  test('includes existing skill names and descriptions in the reflection prompt', async () => {
    let capturedPrompt = ''

    const existingSkills: SkillCatalogEntry[] = [
      {
        name: 'file-summarizer',
        description: 'Reads files and produces summaries',
        status: 'core',
      },
      {
        name: 'code-reviewer',
        description: 'Reviews code for common issues',
        status: 'generated',
      },
    ]

    const mockResponse = JSON.stringify({
      taskSummary: 'Summarized a file',
      novelty: 0.1,
      generalizability: 0.6,
      reasoning: 'The file-summarizer skill already handles this.',
      shouldCrystallize: false,
    })

    // Create a mock that captures the prompt
    const llm = {
      specificationVersion: 'v3',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},

      doGenerate: async (options: { prompt: unknown }) => {
        // Capture the prompt for inspection
        capturedPrompt = JSON.stringify(options.prompt)
        return {
          content: [{ type: 'text' as const, text: mockResponse }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: 10, outputTokens: 20 },
          warnings: [],
        }
      },

      doStream: async () => {
        throw new Error('Not implemented')
      },
    } as unknown as LanguageModel

    await reflect('Summarized a file', existingSkills, llm)

    // The prompt should contain both skill names and descriptions
    expect(capturedPrompt).toContain('file-summarizer')
    expect(capturedPrompt).toContain('Reads files and produces summaries')
    expect(capturedPrompt).toContain('code-reviewer')
    expect(capturedPrompt).toContain('Reviews code for common issues')
  })

  // -----------------------------------------------------------------------
  // Feature test: Malformed LLM response handled gracefully
  // -----------------------------------------------------------------------
  test('returns Result.err for invalid JSON response', async () => {
    const llm = createMockLLM('This is not JSON at all')
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Failed to parse reflection response as JSON')
  })

  test('returns Result.err for JSON missing required fields', async () => {
    const llm = createMockLLM(JSON.stringify({ taskSummary: 'only this field' }))
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('failed schema validation')
  })

  test('returns Result.err when LLM call fails', async () => {
    const llm = createErrorLLM('API key expired')
    const result = await reflect('Did something', [], llm)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('Reflection LLM call failed')
  })

  test('handles JSON wrapped in markdown fences', async () => {
    const jsonBody = JSON.stringify({
      taskSummary: 'Built a parser',
      novelty: 0.6,
      generalizability: 0.5,
      reasoning: 'Decent but not groundbreaking',
      shouldCrystallize: false,
    })

    const llm = createMockLLM('```json\n' + jsonBody + '\n```')
    const result = await reflect('Built a parser', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.novelty).toBe(0.6)
  })

  test('works with empty skill catalog', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Created a new feature',
      novelty: 0.9,
      generalizability: 0.85,
      proposedSkillName: 'feature-creator',
      proposedSkillDescription: 'Generates new features from specs',
      keySteps: ['Analyze spec', 'Generate code', 'Write tests'],
      reasoning: 'Completely new approach with no existing skills to compare.',
      shouldCrystallize: true,
    })

    const llm = createMockLLM(mockResponse)
    const result = await reflect('Created a new feature', [], llm)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.novelty).toBe(0.9)
    expect(result.value.shouldCrystallize).toBe(true)
  })

  test('omits temperature for OpenAI reasoning models', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Created a new feature',
      novelty: 0.9,
      generalizability: 0.85,
      reasoning: 'Completely new approach with no existing skills to compare.',
      shouldCrystallize: false,
    })

    const { llm, doGenerateCalls } = createCapturingLLM({
      provider: 'openai.responses',
      modelId: 'gpt-5.4',
      responseText: mockResponse,
    })

    const result = await reflect('Created a new feature', [], llm)

    expect(result.ok).toBe(true)
    expect(doGenerateCalls).toHaveLength(1)
    expect(doGenerateCalls[0]?.temperature).toBeUndefined()
  })

  test('keeps temperature for non-reasoning models', async () => {
    const mockResponse = JSON.stringify({
      taskSummary: 'Created a new feature',
      novelty: 0.9,
      generalizability: 0.85,
      reasoning: 'Completely new approach with no existing skills to compare.',
      shouldCrystallize: false,
    })

    const { llm, doGenerateCalls } = createCapturingLLM({
      provider: 'openai.responses',
      modelId: 'gpt-4.1',
      responseText: mockResponse,
    })

    const result = await reflect('Created a new feature', [], llm)

    expect(result.ok).toBe(true)
    expect(doGenerateCalls).toHaveLength(1)
    expect(doGenerateCalls[0]?.temperature).toBe(0.2)
  })
})

describe('shouldCrystallize()', () => {
  const baseRecord: ReflectionRecord = {
    taskSummary: 'Test task',
    novelty: 0,
    generalizability: 0,
    reasoning: 'Test reasoning',
    shouldCrystallize: false,
  }

  // -----------------------------------------------------------------------
  // Feature test: High novelty triggers crystallization
  // -----------------------------------------------------------------------
  test('returns true when both scores exceed threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.9,
      generalizability: 0.85,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Feature test: Low novelty does not trigger crystallization
  // -----------------------------------------------------------------------
  test('returns false when novelty is below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.3,
      generalizability: 0.9,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when generalizability is below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.9,
      generalizability: 0.3,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when both scores are below threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.5,
      generalizability: 0.5,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns false when scores exactly equal threshold (strict >)', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.7,
      generalizability: 0.7,
    }

    expect(shouldCrystallize(record, 0.7)).toBe(false)
  })

  test('returns true with custom lower threshold', () => {
    const record: ReflectionRecord = {
      ...baseRecord,
      novelty: 0.5,
      generalizability: 0.5,
    }

    expect(shouldCrystallize(record, 0.4)).toBe(true)
  })
})

describe('observation-based crystallization proposals', () => {
  function makeRepeatedWorkflowSessions(): ObservationCrystallizationSession[] {
    return [
      {
        sessionId: 'session-a',
        observations: [
          makeObservation(
            'session-a',
            'obs-a1',
            '2026-04-15T01:00:00.000Z',
            'progress',
            'Inspect failing payment webhook logs',
            {
              evidence: ['Open the deploy logs', 'Trace the failing webhook event'],
              priority: 'high',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
          makeObservation(
            'session-a',
            'obs-a2',
            '2026-04-15T01:05:00.000Z',
            'decision',
            'Replay webhook payloads against local fixtures',
            {
              evidence: ['Replay the payload', 'Confirm the parser output'],
              priority: 'high',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
          makeObservation(
            'session-a',
            'obs-a3',
            '2026-04-15T01:10:00.000Z',
            'progress',
            'Patch signature verification and rerun regression tests',
            {
              evidence: ['Update the signature verifier', 'Run the webhook regression suite'],
              priority: 'critical',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
        ],
        checkpoint: makeCheckpoint('session-a', '2026-04-15T01:15:00.000Z', {
          goal: 'Restore the payment webhook pipeline',
          skillCandidates: [
            {
              name: 'payment-webhook-debugging',
              summary:
                'Stabilize failing payment webhooks by replaying payloads and verifying signatures.',
              trigger: 'payment webhook deliveries begin failing in production or staging',
              workflow: [
                'Inspect failing payment webhook logs',
                'Replay webhook payloads against local fixtures',
                'Patch signature verification and rerun regression tests',
              ],
              confidence: 0.92,
              sourceObservationIds: ['obs-a1', 'obs-a2', 'obs-a3'],
              sourceSessionIds: ['session-a'],
            },
          ],
        }),
        transcriptExcerpt:
          'Webhook replay showed the signature verifier rejected valid payloads after a key rotation.',
      },
      {
        sessionId: 'session-b',
        observations: [
          makeObservation(
            'session-b',
            'obs-b1',
            '2026-04-16T03:00:00.000Z',
            'progress',
            'Inspect failing payment webhook logs',
            {
              evidence: ['Open the deploy logs', 'Trace the failing webhook event'],
              priority: 'high',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
          makeObservation(
            'session-b',
            'obs-b2',
            '2026-04-16T03:04:00.000Z',
            'decision',
            'Replay webhook payloads against local fixtures',
            {
              evidence: ['Replay the payload', 'Confirm the parser output'],
              priority: 'high',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
          makeObservation(
            'session-b',
            'obs-b3',
            '2026-04-16T03:09:00.000Z',
            'progress',
            'Patch signature verification and rerun regression tests',
            {
              evidence: ['Update the signature verifier', 'Run the webhook regression suite'],
              priority: 'critical',
              tags: ['workflow:payment-webhook-debugging'],
            },
          ),
        ],
        checkpoint: makeCheckpoint('session-b', '2026-04-16T03:12:00.000Z', {
          goal: 'Restore the payment webhook pipeline',
          skillCandidates: [
            {
              name: 'payment-webhook-debugging',
              summary:
                'Stabilize failing payment webhooks by replaying payloads and verifying signatures.',
              trigger: 'payment webhook deliveries begin failing in production or staging',
              workflow: [
                'Inspect failing payment webhook logs',
                'Replay webhook payloads against local fixtures',
                'Patch signature verification and rerun regression tests',
              ],
              confidence: 0.9,
              sourceObservationIds: ['obs-b1', 'obs-b2', 'obs-b3'],
              sourceSessionIds: ['session-b'],
            },
          ],
        }),
        transcriptExcerpt:
          'The repeated fix path was to replay payloads first, then patch the rotated-key verification flow.',
      },
    ]
  }

  test('repeated workflow becomes a crystallization proposal with source references', () => {
    const result = proposeCrystallizationsFromObservations(makeRepeatedWorkflowSessions())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const proposal = result.value[0]
    expect(proposal).toBeDefined()
    expect(proposal?.proposedSkillName).toBe('payment-webhook-debugging')
    expect(proposal?.repeatedAcrossSessions).toBe(true)
    expect(proposal?.repeatCount).toBe(2)
    expect(proposal?.sourceReferences.map((reference) => reference.sessionId).sort()).toEqual([
      'session-a',
      'session-b',
    ])
    expect(
      proposal?.sourceReferences.every((reference) => reference.observationIds.length > 0),
    ).toBe(true)
  })

  test('one-off noise does not outrank a repeated workflow', () => {
    const sessions = makeRepeatedWorkflowSessions()
    sessions.push({
      sessionId: 'session-noisy',
      observations: [
        makeObservation(
          'session-noisy',
          'obs-noise-1',
          '2026-04-17T09:00:00.000Z',
          'warning',
          'Exotic one-off driver crash after toggling a staging-only kernel flag',
          {
            priority: 'critical',
            tags: ['workflow:kernel-driver-firefight'],
          },
        ),
        makeObservation(
          'session-noisy',
          'obs-noise-2',
          '2026-04-17T09:02:00.000Z',
          'decision',
          'Patch the staging kernel module and restart the driver',
          {
            priority: 'critical',
            tags: ['workflow:kernel-driver-firefight'],
          },
        ),
      ],
      checkpoint: makeCheckpoint('session-noisy', '2026-04-17T09:05:00.000Z'),
      transcriptExcerpt: 'This was a weird one-off lab issue and did not recur elsewhere.',
    })

    const result = proposeCrystallizationsFromObservations(sessions)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value[0]?.proposedSkillName).toBe('payment-webhook-debugging')
    expect(result.value[0]?.repeatCount).toBe(2)
    expect(
      result.value.some((proposal) => proposal.proposedSkillName === 'kernel-driver-firefight'),
    ).toBe(false)
  })

  test('reflects the strongest proposal into a traceable reflection record', () => {
    const result = reflectFromObservationPatterns(
      'Observed repeated payment webhook debugging sequences',
      makeRepeatedWorkflowSessions(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.shouldCrystallize).toBe(true)
    expect(result.value.patternType).toBe('workflow')
    expect(result.value.repeatCount).toBe(2)
    expect(result.value.sourceReferences?.length).toBe(2)
    expect(result.value.transcriptExcerpts?.length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ── Part 2: Skill generation tests (Ticket 02) ──────────────────────
// ═══════════════════════════════════════════════════════════════════════

describe('RSI Crystallize Module — Skill Generation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir('rsi-crystallize')
    // Create skills directory structure
    mkdirSync(join(tmpDir, 'skills', 'core'), { recursive: true })
    mkdirSync(join(tmpDir, 'skills', 'generated'), { recursive: true })
    mkdirSync(join(tmpDir, 'skills', 'staging'), { recursive: true })
  })

  afterEach(() => {
    cleanupTempDir(tmpDir)
  })

  // ── Test 1: Generates valid skill directory ─────────────────────
  describe('generates valid skill directory', () => {
    it('should produce SKILL.md and scripts/test.ts in staging', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const skillDir = writeResult.value
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir, 'scripts', 'test.ts'))).toBe(true)

      // Verify SKILL.md has valid YAML frontmatter
      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
      expect(content.trimStart().startsWith('---')).toBe(true)

      const endIndex = content.trimStart().indexOf('---', 3)
      expect(endIndex).toBeGreaterThan(0)

      const yamlBlock = content.trimStart().slice(3, endIndex).trim()
      const parsed = parseYaml(yamlBlock)
      expect(parsed.name).toBe('test-skill')
    })

    it('omits temperature when generating skills with OpenAI reasoning models', async () => {
      const record = makeReflection()
      const { llm, doGenerateCalls } = createCapturingLLM({
        provider: 'openai.responses',
        modelId: 'gpt-5.4',
      })

      const genResult = await generateSkill(record, undefined, llm, tmpDir)

      expect(genResult.ok).toBe(true)
      expect(doGenerateCalls).toHaveLength(1)
      expect(doGenerateCalls[0]?.temperature).toBeUndefined()
    })

    it('can crystallize directly from repeated observations without reflection transcripts', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const observationSessions: ObservationCrystallizationSession[] = [
        {
          sessionId: 'session-a',
          observations: [
            makeObservation(
              'session-a',
              'obs-a1',
              '2026-04-15T01:00:00.000Z',
              'progress',
              'Inspect failing payment webhook logs',
              {
                priority: 'high',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
            makeObservation(
              'session-a',
              'obs-a2',
              '2026-04-15T01:05:00.000Z',
              'decision',
              'Replay webhook payloads against local fixtures',
              {
                priority: 'high',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
            makeObservation(
              'session-a',
              'obs-a3',
              '2026-04-15T01:10:00.000Z',
              'progress',
              'Patch signature verification and rerun regression tests',
              {
                priority: 'critical',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
          ],
          checkpoint: makeCheckpoint('session-a', '2026-04-15T01:15:00.000Z', {
            goal: 'Restore the payment webhook pipeline',
            skillCandidates: [
              {
                name: 'payment-webhook-debugging',
                summary:
                  'Stabilize failing payment webhooks by replaying payloads and verifying signatures.',
                trigger: 'payment webhook deliveries begin failing in production or staging',
                workflow: [
                  'Inspect failing payment webhook logs',
                  'Replay webhook payloads against local fixtures',
                  'Patch signature verification and rerun regression tests',
                ],
                confidence: 0.92,
                sourceObservationIds: ['obs-a1', 'obs-a2', 'obs-a3'],
                sourceSessionIds: ['session-a'],
              },
            ],
          }),
        },
        {
          sessionId: 'session-b',
          observations: [
            makeObservation(
              'session-b',
              'obs-b1',
              '2026-04-16T03:00:00.000Z',
              'progress',
              'Inspect failing payment webhook logs',
              {
                priority: 'high',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
            makeObservation(
              'session-b',
              'obs-b2',
              '2026-04-16T03:04:00.000Z',
              'decision',
              'Replay webhook payloads against local fixtures',
              {
                priority: 'high',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
            makeObservation(
              'session-b',
              'obs-b3',
              '2026-04-16T03:09:00.000Z',
              'progress',
              'Patch signature verification and rerun regression tests',
              {
                priority: 'critical',
                tags: ['workflow:payment-webhook-debugging'],
              },
            ),
          ],
          checkpoint: makeCheckpoint('session-b', '2026-04-16T03:12:00.000Z', {
            goal: 'Restore the payment webhook pipeline',
            skillCandidates: [
              {
                name: 'payment-webhook-debugging',
                summary:
                  'Stabilize failing payment webhooks by replaying payloads and verifying signatures.',
                trigger: 'payment webhook deliveries begin failing in production or staging',
                workflow: [
                  'Inspect failing payment webhook logs',
                  'Replay webhook payloads against local fixtures',
                  'Patch signature verification and rerun regression tests',
                ],
                confidence: 0.9,
                sourceObservationIds: ['obs-b1', 'obs-b2', 'obs-b3'],
                sourceSessionIds: ['session-b'],
              },
            ],
          }),
        },
      ]

      const result = await crystallize('Repeated payment webhook incidents', {
        llm,
        observationSessions,
        autoCommit: false,
        noveltyThreshold: 0.7,
        existingSkills: [],
        skillDirs: {
          staging: join(tmpDir, 'skills', 'staging'),
          generated: join(tmpDir, 'skills', 'generated'),
          core: join(tmpDir, 'skills', 'core'),
        },
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.outcome).toBe('promoted')
      expect(result.value.skillName).toBe('payment-webhook-debugging')
      expect(
        result.value.reflection?.sourceReferences?.map((reference) => reference.sessionId).sort(),
      ).toEqual(['session-a', 'session-b'])
    })
  })

  // ── Test 2: Frontmatter conforms to spec ────────────────────────
  describe('frontmatter conforms to spec', () => {
    it('should include all required agentskills.io fields', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const content = readFileSync(join(writeResult.value, 'SKILL.md'), 'utf-8')
      const endIndex = content.trimStart().indexOf('---', 3)
      const yamlBlock = content.trimStart().slice(3, endIndex).trim()
      const fm = parseYaml(yamlBlock)

      // Required fields
      expect(fm.name).toBe('test-skill')
      expect(typeof fm.description).toBe('string')
      expect(fm.description.length).toBeGreaterThan(0)
      expect(fm.description.length).toBeLessThanOrEqual(1024)
      expect(fm.license).toBe('Apache-2.0')

      // Metadata
      expect(fm.metadata).toBeDefined()
      expect(fm.metadata.generated).toBe('true')
      expect(fm.metadata.author).toBe('ouroboros-rsi')
      expect(fm.metadata.version).toBe('1.0')
      expect(fm.metadata.confidence).toBe(0.85)
      expect(fm.metadata.source_task).toBe('Implemented cursor-based pagination for a REST API')
    })
  })

  // ── Test 3: Rejects non-crystallizable reflection ───────────────
  describe('rejects non-crystallizable reflection', () => {
    it('should return error for shouldCrystallize: false', async () => {
      const record = makeReflection({ shouldCrystallize: false })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('shouldCrystallize: false')
    })

    it('should reject via the tool execute function', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: {
          ...makeReflection({ shouldCrystallize: false }),
        },
      }

      const result = await execute(input)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('shouldCrystallize: false')
    })
  })

  // ── Test 4: Rejects duplicate skill name ────────────────────────
  describe('rejects duplicate skill name', () => {
    it('should error when skill name already exists in skills/core/', async () => {
      const existingDir = join(tmpDir, 'skills', 'core', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
      expect(writeResult.error.message).toContain('existing-skill')
    })

    it('should error when skill name already exists in skills/staging/', async () => {
      const existingDir = join(tmpDir, 'skills', 'staging', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
    })

    it('should error when skill name already exists in skills/generated/', async () => {
      const existingDir = join(tmpDir, 'skills', 'generated', 'existing-skill')
      mkdirSync(existingDir, { recursive: true })

      const record = makeReflection({ proposedSkillName: 'existing-skill' })
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(false)
      if (writeResult.ok) return
      expect(writeResult.error.message).toContain('already exists')
    })
  })

  // ── Test 5: Generated test script is valid TypeScript ───────────
  describe('generated test script is valid TypeScript', () => {
    it('should produce syntactically valid TS in scripts/test.ts', async () => {
      const record = makeReflection()
      const llm = mockModelReturning(VALID_LLM_OUTPUT)

      const genResult = await generateSkill(record, undefined, llm, tmpDir)
      expect(genResult.ok).toBe(true)
      if (!genResult.ok) return

      const writeResult = await writeSkillToStaging(genResult.value, tmpDir)
      expect(writeResult.ok).toBe(true)
      if (!writeResult.ok) return

      const testScript = readFileSync(join(writeResult.value, 'scripts', 'test.ts'), 'utf-8')

      // Basic validity checks: contains expected imports and structure
      expect(testScript).toContain('import')
      expect(testScript).toContain('bun:test')
      expect(testScript).toContain('describe')
      expect(testScript).toContain('expect')

      // Verify it's parseable by checking for balanced braces
      const opens = (testScript.match(/\{/g) || []).length
      const closes = (testScript.match(/\}/g) || []).length
      expect(opens).toBe(closes)
    })
  })

  // ── Test 6: Malformed LLM output handled gracefully ─────────────
  describe('malformed LLM output handled gracefully', () => {
    it('should error when LLM returns no code blocks', async () => {
      const record = makeReflection()
      const llm = mockModelReturning('I cannot generate a skill right now.')

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('description')
    })

    it('should error when LLM output is missing the markdown block', async () => {
      const incompleteOutput = `
\`\`\`description
A test skill description.
\`\`\`
`
      const record = makeReflection()
      const llm = mockModelReturning(incompleteOutput)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('markdown')
    })

    it('should error when LLM output is missing the typescript block', async () => {
      const incompleteOutput = `
\`\`\`description
A test skill description.
\`\`\`

\`\`\`markdown
# Instructions
Do the thing.
\`\`\`
`
      const record = makeReflection()
      const llm = mockModelReturning(incompleteOutput)

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('typescript')
    })

    it('should error when LLM returns empty text', async () => {
      const record = makeReflection()
      const llm = mockModelReturning('')

      const result = await generateSkill(record, undefined, llm, tmpDir)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.message).toContain('empty')
    })
  })

  // ── Unit tests for validators ───────────────────────────────────
  describe('validateSkillName', () => {
    it('should accept valid kebab-case names', () => {
      expect(validateSkillName('my-skill').ok).toBe(true)
      expect(validateSkillName('a').ok).toBe(true)
      expect(validateSkillName('cursor-pagination-v2').ok).toBe(true)
    })

    it('should reject empty names', () => {
      const r = validateSkillName('')
      expect(r.ok).toBe(false)
    })

    it('should reject names over 64 characters', () => {
      const r = validateSkillName('a'.repeat(65))
      expect(r.ok).toBe(false)
    })

    it('should reject non-kebab-case names', () => {
      expect(validateSkillName('MySkill').ok).toBe(false)
      expect(validateSkillName('my_skill').ok).toBe(false)
      expect(validateSkillName('my skill').ok).toBe(false)
      expect(validateSkillName('-leading-dash').ok).toBe(false)
    })
  })

  describe('checkNameUniqueness', () => {
    it('should return ok when name is unique', () => {
      const r = checkNameUniqueness('brand-new-skill', tmpDir)
      expect(r.ok).toBe(true)
    })

    it('should return error when name exists', () => {
      mkdirSync(join(tmpDir, 'skills', 'core', 'taken-name'), { recursive: true })
      const r = checkNameUniqueness('taken-name', tmpDir)
      expect(r.ok).toBe(false)
    })
  })

  describe('parseSkillResponse', () => {
    it('should extract all three blocks from valid output', () => {
      const record = makeReflection()
      const result = parseSkillResponse(VALID_LLM_OUTPUT, record)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.name).toBe('test-skill')
      expect(result.value.frontmatter.name).toBe('test-skill')
      expect(result.value.frontmatter.license).toBe('Apache-2.0')
      expect(result.value.frontmatter.metadata.author).toBe('ouroboros-rsi')
      expect(result.value.body).toContain('Cursor-Based Pagination')
      expect(result.value.testScript).toContain('bun:test')
    })
  })

  describe('validateRoundTrip', () => {
    it('should accept valid SKILL.md content', () => {
      const content = `---
name: test
description: A test skill
---

# Body here
`
      expect(validateRoundTrip(content).ok).toBe(true)
    })

    it('should reject content without frontmatter', () => {
      expect(validateRoundTrip('# No frontmatter').ok).toBe(false)
    })

    it('should reject content with unclosed frontmatter', () => {
      expect(validateRoundTrip('---\nname: test\n').ok).toBe(false)
    })
  })

  // ── Integration: tool execute function ──────────────────────────
  describe('SkillGenTool createExecute', () => {
    it('should produce a complete skill via the tool interface', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: makeReflection(),
      }

      const result = await execute(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.skillName).toBe('test-skill')
      expect(result.value.path).toContain('skills/staging/test-skill')
      expect(existsSync(join(result.value.path, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(result.value.path, 'scripts', 'test.ts'))).toBe(true)
    })

    it('should pass optional transcript to generation', async () => {
      const llm = mockModelReturning(VALID_LLM_OUTPUT)
      const execute = createExecute({ llm, basePath: tmpDir })

      const input: SkillGenInput = {
        reflectionRecord: makeReflection(),
        taskTranscript: 'User asked for cursor-based pagination implementation...',
      }

      const result = await execute(input)
      expect(result.ok).toBe(true)
    })
  })
})
