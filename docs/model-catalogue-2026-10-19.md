# Model catalogue refresh — 19 October 2026

The shared catalogue in `packages/shared/src/models.ts` records provider IDs,
context limits, reasoning support, lifecycle, restrictions, and official sources.
Current additions were verified against provider documentation on 19 October.
Legacy entries retain compatibility metadata and are not marked freshly verified.

## OpenAI subscription verification

A read-only authenticated request to the Codex account catalogue returned:

- `gpt-6.1-sol`: 500,000-token context.
- `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-blue-latest`: 272,000-token context.

Hidden `gpt-reserve` and `codex-auto-review` entries are excluded. The account
catalogue also advertises Codex Ultra, an orchestration mode that is deliberately
excluded from the model reasoning effort parameter.

The existing Codex OAuth client succeeded against
`https://chatgpt.com/backend-api/codex/models?client_version=0.163.0`.
The version query is required by the catalogue protocol. The public SIWC model
endpoint returned HTTP 403 with these existing Codex credentials; public SIWC
onboarding is a separate flow, not introduced by this update. Runtime discovery
uses Ouroboros's own OAuth store, never the Codex app's credentials.

Account membership was verified; it does not establish universal access or model quality.
API-key access and subscription context limits differ. GPT-5.5 retired from
ChatGPT sign-in on 14 October while remaining available through API keys.
See [OpenAI model availability](https://learn.chatgpt.com/docs/models) and
[API specifications](https://developers.openai.com/api/docs/guides/latest-model).

## Families added

| Provider | Current models | Official source |
| --- | --- | --- |
| OpenAI | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol/Luna, GPT-5.6 Sol/Terra/Luna; account-gated Daybreak Blue | [Models](https://developers.openai.com/api/docs/models) |
| Anthropic | Fable 5.1, Opus/Sonnet/Haiku 5.5 | [Models](https://platform.claude.com/docs/en/models/overview) |
| Google | Gemini 4 Argon, 3.8 Flash, 3.5 Flash-Lite | [Models](https://ai.google.dev/gemini-api/docs/models) |
| xAI | Grok 4.7 | [Models](https://docs.x.ai/developers/models) |
| Z.ai | GLM-5.3, GLM-5.3-Flash/FlashX | [Models](https://docs.z.ai/guides/vlm/glm-5.3-flash) |
| Moonshot | Kimi K3, K2.7 Code/Highspeed, K2.6 | [Models](https://platform.kimi.ai/docs/models) |
| MiniMax | M3; M3.1 Flash Preview restricted to M Plan/MiniMax Code | [Models](https://platform.minimax.io/docs/guides/models-intro) |
| Alibaba | Qwen3.8 Max/Flash, Qwen3.7 Plus | [Models](https://www.alibabacloud.com/help/en/model-studio/text-generation-model) |
| DeepSeek | DeepSeek Flash, V4 Pro | [Models](https://api-docs.deepseek.com/quick_start/pricing/) |
| Mistral | Large 4, Medium 3.5; Devstral 2 deprecated | [Models](https://docs.mistral.ai/models) |
| NVIDIA | `nvidia/nemotron-3-ultra-550b-a55b`; `nvidia/nemotron-3.5-super-vl-120b-a12b` early access, hosted limit 262,144 tokens | [Ultra](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b), [Super VL](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b) |

## Integration decisions

- Stay on AI SDK 6 with compatible current provider patches.
- Use Responses for native OpenAI agent requests and the compatible provider
  adapter for third-party Chat Completions. This preserves reasoning and Gemini
  tool signatures in subsequent requests. A replay adapter translates the pinned
  compatible SDK's signature metadata namespace into its expected request
  namespace without changing the stored signature.
- Preserve complete provider continuation state in private transcript metadata,
  replayed only to the same provider/model. Legacy transcripts remain readable.
- Refresh subscription models per account, cache for ten minutes, and label
  stale or bundled choices as unverified. Credentials are never cached alongside
  model metadata.
- Repair only confirmed retired saved subscription selections after verifying
  account availability. Explicit overrides fail with available replacements;
  API-key and custom endpoint selections are not automatically migrated.

## Manual subscription smoke test

On 19 October, GPT-6.1 Sol with medium reasoning passed synthetic text, echo-tool,
tool-result continuation, and subsequent-user-turn checks through the installed
SDK and Ouroboros's subscription request/stream adapters. Signed continuation
state was retained between requests. The harness used the existing subscription
login in memory and left the user's Ouroboros login/configuration unchanged.
This was a manual check, separate from automated verification.
