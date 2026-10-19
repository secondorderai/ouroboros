import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateResponse, streamResponse, toModelMsgs } from '@src/llm/streaming'
import { getReasoningEfforts, getModelDescriptor, setSubscriptionModels } from '@ouroboros/shared'
import { buildReasoningProviderOptions } from '@src/llm/reasoning'
import { TranscriptStore } from '@src/memory/transcripts'
import { toConversationHistory } from '@src/json-rpc/handlers'
import type { AssistantResponseState, LLMMessage } from '@src/llm/types'

afterEach(() => setSubscriptionModels([]))
const tools = {
  lookup: { description: 'Look up a value', parameters: { type: 'object', properties: {} } },
}
const fetcher = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  fn as typeof fetch

describe('current model wire contracts', () => {
  test('incompatible custom endpoint modes reject tools before sending an HTTP request', async () => {
    let calls = 0
    const options = {
      name: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'https://example.invalid/v1',
      fetch: fetcher(async () => {
        calls++
        throw new Error('Unexpected HTTP request')
      }),
    }
    const models = [
      createOpenAICompatible(options).chatModel('gpt-6.1-sol'),
      createOpenAI(options).completion('custom-completion-model'),
    ]
    for (const model of models) {
      const streamed = streamResponse(model, [{ role: 'user', content: 'Use a tool' }], { tools })
      const generated = await generateResponse(model, [{ role: 'user', content: 'Use a tool' }], {
        tools,
      })
      expect(streamed.ok).toBe(false)
      expect(generated.ok).toBe(false)
      if (!generated.ok) expect(generated.error.message).toContain('model.apiMode=')
    }
    expect(calls).toBe(0)
  })
  test('GPT-6.1 sends real max reasoning and omits sampling through the installed SDK', async () => {
    let body: Record<string, any> = {}
    const model = createOpenAI({
      apiKey: 'test',
      fetch: fetcher(async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          id: 'resp_1',
          created_at: 0,
          model: 'gpt-6.1-sol',
          status: 'completed',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'OK', annotations: [] }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        })
      }),
    }).responses('gpt-6.1-sol')
    const result = await generateResponse(model, [{ role: 'user', content: 'Hello' }], {
      reasoningEffort: 'max',
      temperature: 0.2,
      tools,
    })
    expect(result.ok).toBe(true)
    expect(body.model).toBe('gpt-6.1-sol')
    expect(body.reasoning).toEqual({ effort: 'max' })
    expect(body.temperature).toBeUndefined()
    expect(body.tools[0].name).toBe('lookup')
  })

  test('Claude 5.5 sends adaptive thinking and valid effort without sampling', async () => {
    let body: Record<string, any> = {}
    const model = createAnthropic({
      apiKey: 'test',
      fetch: fetcher(async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 2 },
        })
      }),
    })('claude-opus-5-5')
    const result = await generateResponse(model, [{ role: 'user', content: 'Hello' }], {
      reasoningEffort: 'xhigh',
      temperature: 0.2,
    })
    expect(result.ok).toBe(true)
    expect(body.thinking).toMatchObject({ type: 'adaptive' })
    expect(body.output_config.effort).toBe('xhigh')
    expect(body.temperature).toBeUndefined()
  })

  test('Claude signed and redacted thinking blocks remain unmodified after a restored tool conversation', async () => {
    const requests: Record<string, any>[] = []
    const thinking = [
      { type: 'thinking', thinking: 'opaque continuation', signature: 'signed-claude-block' },
      { type: 'redacted_thinking', data: 'opaque-redacted-block' },
    ]
    const model = createAnthropic({
      apiKey: 'test',
      fetch: fetcher(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content:
            requests.length === 1
              ? [...thinking, { type: 'tool_use', id: 'call-claude', name: 'lookup', input: {} }]
              : [{ type: 'text', text: 'Done' }],
          stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 2 },
        })
      }),
    })('claude-opus-5-5')
    const first = await generateResponse(model, [{ role: 'user', content: 'Find it' }], {
      tools,
      reasoningEffort: 'medium',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const history: LLMMessage[] = [
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: first.value.text,
        toolCalls: first.value.toolCalls,
        providerState: first.value.assistantState,
      },
      {
        role: 'tool',
        content: [{ toolCallId: 'call-claude', toolName: 'lookup', result: 'Found' }],
      },
    ]
    const dir = mkdtempSync(join(tmpdir(), 'ou-claude-transcript-'))
    const store = new TranscriptStore(join(dir, 'transcripts.db'))
    try {
      const session = store.createSession()
      if (!session.ok) throw session.error
      expect(store.addConversationMessages(session.value, history).ok).toBe(true)
      const saved = store.getSession(session.value)
      if (!saved.ok) throw saved.error
      const restored = toConversationHistory(saved.value, {
        provider: 'anthropic',
        name: 'claude-opus-5-5',
      })
      const next = await generateResponse(model, restored, { tools, reasoningEffort: 'medium' })
      expect(next.ok).toBe(true)
      expect(requests[1].messages[1].content.slice(0, 2)).toEqual(thinking)
      expect(requests[1].messages[1].content[2]).toMatchObject({
        type: 'tool_use',
        id: 'call-claude',
      })
      expect(requests[1].messages[2].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'call-claude',
      })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([true, false])(
    'compatible tool conversations survive persistence and restoration (reasoning=%s)',
    async (reasoning) => {
      const requests: Record<string, any>[] = []
      const model = createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: 'https://example.invalid/v1',
        apiKey: 'test',
        fetch: fetcher(async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)))
          return Response.json({
            id: 'chat-1',
            created: 1,
            model: 'kimi-k3',
            choices: [
              {
                index: 0,
                message:
                  requests.length === 1
                    ? {
                        role: 'assistant',
                        content: null,
                        ...(reasoning ? { reasoning_content: 'provider continuation' } : {}),
                        tool_calls: [
                          {
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'lookup', arguments: '{}' },
                          },
                        ],
                      }
                    : { role: 'assistant', content: 'Done' },
                finish_reason: requests.length === 1 ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          })
        }),
      }).chatModel('kimi-k3')
      const first = await generateResponse(model, [{ role: 'user', content: 'Find it' }], {
        tools,
        reasoningEffort: 'high',
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      expect(first.value.assistantState?.message.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            reasoning
              ? { type: 'reasoning', text: 'provider continuation' }
              : { type: 'tool-call', toolCallId: 'call-1' },
          ),
        ]),
      )
      const history: LLMMessage[] = [
        { role: 'user', content: 'Find it' },
        {
          role: 'assistant',
          content: first.value.text,
          toolCalls: first.value.toolCalls,
          providerState: first.value.assistantState,
        },
        {
          role: 'tool',
          content: [{ toolCallId: 'call-1', toolName: 'lookup', result: 'Found it' }],
        },
      ]
      const dir = mkdtempSync(join(tmpdir(), 'ou-model-transcript-'))
      const store = new TranscriptStore(join(dir, 'transcripts.db'))
      try {
        const session = store.createSession()
        expect(session.ok).toBe(true)
        if (!session.ok) return
        expect(store.addConversationMessages(session.value, history).ok).toBe(true)
        const saved = store.getSession(session.value)
        expect(saved.ok).toBe(true)
        if (!saved.ok) return
        const restored = toConversationHistory(saved.value, {
          provider: 'openai-compatible',
          name: 'kimi-k3',
        })
        expect(restored).toHaveLength(3)
        const next = await generateResponse(model, restored, { tools })
        expect(next.ok).toBe(true)
        expect(requests[1].messages[1].reasoning_content).toBe(
          reasoning ? 'provider continuation' : undefined,
        )
        expect(requests[1].messages[2].tool_call_id).toBe('call-1')
        const switched = toConversationHistory(saved.value, {
          provider: 'openai',
          name: 'gpt-6.1-sol',
        })
        expect(switched.some((m) => m.role === 'tool')).toBe(false)
        expect(switched.some((m) => m.role === 'assistant' && m.providerState)).toBe(false)
        const changedProtocol = toConversationHistory(saved.value, {
          provider: 'openai-compatible',
          name: 'kimi-k3',
          apiMode: 'responses',
        })
        expect(changedProtocol.some((m) => m.role === 'tool')).toBe(false)
        expect(changedProtocol.some((m) => m.role === 'assistant' && m.providerState)).toBe(false)
      } finally {
        store.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('streaming preserves signed tool metadata without emitting reasoning as visible text', async () => {
    let replayBody: Record<string, any> = {}
    const chunks = [
      {
        choices: [
          { index: 0, delta: { role: 'assistant', reasoning_content: 'hidden continuation' } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                  extra_content: { google: { thought_signature: 'signed' } },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const model = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: 'https://example.invalid/v1',
      fetch: fetcher(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (!body.stream) {
          replayBody = body
          return Response.json({
            id: 'chat-2',
            created: 1,
            model: 'gemini-4-argon',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' },
            ],
          })
        }
        return new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }),
    }).chatModel('gemini-4-argon')
    const result = streamResponse(model, [{ role: 'user', content: 'Use a tool' }], { tools })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    let state: AssistantResponseState | undefined
    let visible = ''
    for await (const chunk of result.value.stream) {
      if (chunk.type === 'assistant-state') state = chunk.state
      if (chunk.type === 'text-delta') visible += chunk.textDelta
      if (chunk.type === 'error') throw chunk.error
    }
    expect(visible).toBe('')
    expect(JSON.stringify(state)).toContain('signed')
    const replay = toModelMsgs([{ role: 'assistant', content: '', providerState: state }], model)
    expect(JSON.stringify(replay)).toContain('signed')
    const next = await generateResponse(
      model,
      [
        { role: 'user', content: 'Use a tool' },
        { role: 'assistant', content: '', providerState: state },
        { role: 'tool', content: [{ toolCallId: 'call-1', toolName: 'lookup', result: 'Found' }] },
      ],
      { tools },
    )
    expect(next.ok).toBe(true)
    expect(replayBody.messages[1].reasoning_content).toBe('hidden continuation')
    expect(replayBody.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(
      'signed',
    )
  })

  test('account-specific reasoning excludes none and ultra while API Luna supports none', () => {
    expect(getReasoningEfforts('gpt-6-luna', 'openai')).toContain('none')
    expect(getReasoningEfforts('gpt-6-luna', 'openai-chatgpt')).not.toContain('none')
    const cap = getModelDescriptor('gpt-6.1-sol')!
    expect(
      buildReasoningProviderOptions(createOpenAI({ apiKey: 'test' }).responses(cap.id), 'minimal')
        .providerOptions?.openai?.reasoningEffort,
    ).toBe('low')
  })
})
