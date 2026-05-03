# Agentic AI Patterns in Ouroboros

> Audience: Agentic AI engineers evaluating, extending, or borrowing from Ouroboros.
> This catalogues the patterns that are actually wired up in the codebase, with
> file pointers so you can read the real implementation rather than a sanitised
> abstraction.

Ouroboros is a recursive self-improving agent built around a familiar ReAct
core, but with several less-common patterns layered on top: a five-stage
RSI cycle, a four-tier file-based memory hierarchy, hierarchical subagent
dispatch with worktree isolation, runtime skills using the `SKILL.md` format
for progressive disclosure, and a tiered permission model that gates
self-modification behind explicit human approval.

The patterns below are grouped by concern. Each entry names the canonical
pattern, points at the implementation, and calls out the design choices that
distinguish Ouroboros's take from the textbook version.

---

## 1. Core Loop

### ReAct (Reason → Act → Observe)
- **Where:** [packages/cli/src/agent.ts](../packages/cli/src/agent.ts), ~1.9k LOC
- **What:** The agent streams an LLM response, extracts tool calls, executes
  them via the [tool registry](../packages/cli/src/tools/registry.ts), and
  feeds tool results back as observations on the next turn. The loop continues
  until the model emits no further tool calls or hits a per-run step cap.
- **Notable:** Strongly event-driven. The agent emits a typed
  `AgentEvent` discriminated union (~60 variants — `text`, `tool-call-start/end`,
  `turn-complete`, `subagent-*`, `permission-lease-check`, `mode-entered`,
  `plan-submitted`, `artifact-created`, RSI events, etc.) so the CLI, JSON-RPC
  server, and Electron desktop can all subscribe to the same loop without
  coupling.

### Tool Use with Typed Schemas
- **Where:** [packages/cli/src/tools/](../packages/cli/src/tools/) — every tool
  exports `name`, `description`, a Zod `schema`, and an async `execute`.
- **What:** Tool outputs are returned as `Result<T, Error>` rather than thrown,
  so the loop never crashes on tool failure — observations carry structured
  errors back to the model.
- **Notable:** Tools receive a [`ToolExecutionContext`](../packages/cli/src/tools/types.ts)
  containing `agentRunId`, `sessionId`, `mode`, `taskGraph`, `agentRegistry`,
  `parentRunId`, `userProfile`, etc. — making tools first-class citizens of the
  run, not anonymous functions.

### Plan Mode (Plan-and-Execute with Human Approval)
- **Where:** [packages/cli/src/modes/plan/](../packages/cli/src/modes/plan/)
- **What:** The agent can enter plan mode and submit a structured `Plan` —
  `title`, `summary`, ordered `steps` with `targetFiles`, `tools`, and
  `dependsOn`. Status flows `draft → submitted → approved | rejected`. Rejected
  plans capture user feedback and feed back into the next planning turn.
- **Notable:** Plan mode is a first-class run mode rather than a prompt
  convention, which means tool execution can be hard-blocked until approval.

---

## 2. The RSI Cycle (Observe → Reflect → Crystallize → Dream → Memory → Plan)

This is the lifecycle that puts the "self-improving" in Ouroboros.
Background: [docs/observe-reflect-crystallize-dream-memory-plan.md](observe-reflect-crystallize-dream-memory-plan.md).

### Observation Logging (Episodic Memory)
- **Where:** [packages/cli/src/memory/observations.ts](../packages/cli/src/memory/observations.ts)
- **What:** Atomic events (decisions, tool results, constraints, open loops)
  are append-only to `memory/observations/<session-id>.jsonl`. This is the raw
  episodic stream; everything downstream consumes it.

### Reflection Checkpoint (Self-Critique with Structured State)
- **Where:** [packages/cli/src/memory/checkpoints.ts](../packages/cli/src/memory/checkpoints.ts),
  [packages/cli/src/tools/reflect.ts](../packages/cli/src/tools/reflect.ts)
- **What:** Reflection consumes recent observations and rewrites
  `memory/checkpoints/<session-id>.md` with a typed schema:
  `goal`, `currentPlan`, `constraints`, `decisionsMade`, `filesInPlay`,
  `completedWork`, `openLoops`, `nextBestStep`, `durableMemoryCandidates`,
  `skillCandidates`.
- **Notable:** Unlike Reflexion-style "free-form self-critique," reflection
  here produces a **machine-readable** checkpoint. Downstream stages
  (crystallization, compaction) consume specific fields rather than re-parsing
  prose.

### Crystallization (Skill Synthesis Pipeline)
- **Where:** [packages/cli/src/rsi/crystallize.ts](../packages/cli/src/rsi/crystallize.ts),
  [packages/cli/src/tools/crystallize.ts](../packages/cli/src/tools/crystallize.ts)
- **What:** Full pipeline: novelty score → generate `SKILL.md` → Zod-validate
  frontmatter → run skill self-test → promote `skills/staging` → `skills/core`.
  Returns a `CrystallizationResult` with one of `no-crystallization | generated
  | test-failed | promoted`.
- **Notable:** Crystallization fails closed — generated skills must pass
  validation and self-test before they enter the active catalogue. A bad
  reflection cannot poison the skill set.

### Dream (Cross-Session Consolidation)
- **Where:** [packages/cli/src/memory/dream.ts](../packages/cli/src/memory/dream.ts),
  [packages/cli/src/tools/dream.ts](../packages/cli/src/tools/dream.ts)
- **What:** Periodically consolidates multi-session observations and
  checkpoints into durable `MEMORY.md` entries — the "sleep" pass that turns
  episodic data into semantic knowledge.

### Evolution Log (RSI Telemetry)
- **Where:** [packages/cli/src/rsi/evolution-log.ts](../packages/cli/src/rsi/evolution-log.ts)
- **What:** Append-only log of every reflection, crystallization, dream, and
  validation event. This is the data you tune novelty thresholds and skill
  promotion rates against.

### Orchestrator (Lifecycle Hooks)
- **Where:** [packages/cli/src/rsi/orchestrator.ts](../packages/cli/src/rsi/orchestrator.ts)
- **What:** Wires the cycle into the agent's post-turn lifecycle. RSI failures
  are caught and isolated — the user-facing task never breaks because dream
  consolidation choked.

---

## 3. Memory Hierarchy (Layered, Budgeted)

Ouroboros runs **four independent file-backed memory layers**, each with its
own token budget, rather than a single retrieval-augmented store.

| Layer | File | Purpose |
|---|---|---|
| **Durable** | `memory/MEMORY.md` | Long-term facts, preferences, constraints |
| **Checkpoint** | `memory/checkpoints/<session-id>.md` | Current session's structured state |
| **Working** | `memory/daily/YYYY-MM-DD.md` | Recent rollups |
| **Observations** | `memory/observations/<session-id>.jsonl` | Append-only atomic events |

- **Where:** [packages/cli/src/memory/](../packages/cli/src/memory/) (loaders,
  checkpoints, observations, dream, topics, paths, transcripts)
- **Notable:**
  - Each layer has an **independent** token budget, set in
    [llm/prompt.ts](../packages/cli/src/llm/prompt.ts).
  - Trimming respects markdown section boundaries, not character offsets — so
    you never inject half a header or a truncated bullet.
  - Together these enable safe **compaction**: state is checkpointed *before*
    history is trimmed, so the model can resume after losing transcript context.

---

## 4. Multi-Agent / Subagent Patterns

### Subagent Dispatch (Orchestrator-Worker)
- **Where:** [packages/cli/src/tools/spawn-agent.ts](../packages/cli/src/tools/spawn-agent.ts)
- **What:** `spawn_agent` creates a bounded child agent with its own permission
  lease, skill allowlist (`scopeSkillCatalogProvider`), tool registry variant
  (read-only / test / worker), max-step cap (≤25), and optional inherited
  skill. Returns `SpawnAgentResult` with status, output, and worker diff.
- **Notable:** Three registry variants enforce different safety profiles —
  read-only research agents cannot write files, worker agents get a scoped
  worktree, test agents capture command denials for audit.

### Worker Runtime with Worktree Isolation
- **Where:** [packages/cli/src/tools/worker-runtime.ts](../packages/cli/src/tools/worker-runtime.ts),
  [packages/cli/src/tools/worker-diff-approval.ts](../packages/cli/src/tools/worker-diff-approval.ts)
- **What:** Workers run in their own `git worktree` with scoped write paths.
  The runtime tracks active scopes to prevent overlapping writes, validates
  scopes on every write, and collects the full diff (staged + unstaged +
  untracked) on exit for parent review.
- **Notable:** Parent and worker are **separate worktrees on the same repo**,
  so two agents can edit different files in the same project concurrently
  without merge headaches. The diff is the unit of human review.

### Subagent Result Synthesis (Consensus & Conflict Detection)
- **Where:** [packages/cli/src/tools/subagent-synthesis.ts](../packages/cli/src/tools/subagent-synthesis.ts)
- **What:** When multiple subagents answer the same question, this tool emits
  an `AgentVerdict` with `consensus`, `supportingClaims`, `conflictingClaims`,
  `unsupportedClaims`, and `unresolvedRisks`. Term-matching against
  POSITIVE/NEGATIVE word lists detects agreement and disagreement.
- **Notable:** Cheap heuristic synthesis — no extra LLM call required to spot
  obvious conflicts. Useful as a fast first pass before escalating to a
  reviewer agent.

### Team Graph (Task DAG)
- **Where:** [packages/cli/src/team/task-graph.ts](../packages/cli/src/team/task-graph.ts),
  [packages/cli/src/tools/team-graph.ts](../packages/cli/src/tools/team-graph.ts)
- **What:** A directed acyclic graph of tasks with dependencies, quality
  gates, assigned agents, and a per-graph message channel. The `team_graph`
  tool lets the orchestrator create / update / inspect graphs at runtime.
- **Notable:** Graphs emit status events to the same agent event stream, so
  the desktop UI can render multi-agent progress live.

### Team Advisor (Topology Recommender)
- **Where:** [packages/cli/src/team/advisor.ts](../packages/cli/src/team/advisor.ts)
- **What:** Given a task description, recommends one of:
  `single-agent | one-explorer | read-only-research-team | review-test-pair |
  worktree-workers | full-task-graph-team`, factoring file-overlap risk, task
  independence, permissions required, token cost, and user risk tolerance.
- **Notable:** Treats topology selection itself as an agentic decision rather
  than hard-coding "always spawn N workers."

---

## 5. Skills as Progressive Disclosure

### `SKILL.md` Catalogue
- **Where:** [packages/cli/src/tools/skill-manager.ts](../packages/cli/src/tools/skill-manager.ts),
  [packages/cli/src/skills/skill-invocation.ts](../packages/cli/src/skills/skill-invocation.ts),
  `skills/{core,staging,generated}/`
- **What:** Each skill is a `SKILL.md` with YAML frontmatter (`name`,
  `description`, `references`, `requiresApproval`) and free-form
  instructions. Follows the [agentskills.io](https://agentskills.io) spec.
- **Progressive disclosure:** The system prompt only carries the **catalogue**
  (name + one-line description). Full instructions are loaded into context
  **only when the agent activates the skill** via tool call. This keeps the
  base prompt small while making thousands of skills addressable.
- **Notable:** Three directories form a promotion pipeline — `generated` (just
  crystallised) → `staging` (validated) → `core` (battle-tested). Skills can
  declare `requiresApproval: true` to gate activation behind a human
  approval handler.

### Skill Generation as a Tool
- **Where:** [packages/cli/src/tools/skill-gen.ts](../packages/cli/src/tools/skill-gen.ts)
- **What:** The agent can write skills as a tool call, not as a build step.
  Combined with the crystallisation pipeline, this closes the loop:
  *experience → reflection → skill → reuse*.

---

## 6. Safety, Permissions & Human-in-the-Loop

### 5-Tier Permission Model
- **Where:** [packages/cli/src/tier-approval.ts](../packages/cli/src/tier-approval.ts),
  [packages/cli/src/agent-invocation-permissions.ts](../packages/cli/src/agent-invocation-permissions.ts)
- **What:** Every tool call is mapped to a tier:
  - **Tier 0** — read-only
  - **Tier 1** — scoped writes (within a worktree path)
  - **Tier 2** — skill generation
  - **Tier 3** — self-modification (writes to Ouroboros's own source)
  - **Tier 4** — system-level changes
- **Notable:** Tier 3 / 4 operations are gated by a desktop approval handler
  by default — RSI cannot quietly rewrite the agent's own code. The 5-tier
  model is preserved by project policy (see [CLAUDE.md](../CLAUDE.md)).

### Permission Leases
- **Where:** [packages/cli/src/permission-lease.ts](../packages/cli/src/permission-lease.ts)
- **What:** A lease is `{ agentRunId, allowedTools, allowedPaths, allowedBash,
  expiresAt, maxToolCalls, approvals }`. Subagents inherit a *narrower* lease
  from their parent and cannot escalate. Leases expire by wall clock or by
  call count, whichever comes first.
- **Notable:** Cleaner than per-call confirmations — one approval grants a
  bounded budget for an entire subagent run.

### `ask_user` as a First-Class Tool
- **Where:** [packages/cli/src/tools/ask-user.ts](../packages/cli/src/tools/ask-user.ts)
- **What:** Human clarification is just another tool. Lets the agent
  short-circuit ambiguity rather than guessing.

---

## 7. Context Composition

### System Prompt Assembly
- **Where:** [packages/cli/src/llm/prompt.ts](../packages/cli/src/llm/prompt.ts)
- **What:** `buildSystemPrompt` composes:
  base instructions + tool schemas + skill **catalogue** (not bodies) +
  layered memory (each layer independently budgeted) + AGENTS.md +
  RSI flag + mode overlay + team guidance + activated-skill bodies.
- **Notable:** Treats prompt construction as a pipeline of optional, budgeted
  sections rather than a string template.

### Hierarchical AGENTS.md Inheritance
- **Where:** [packages/cli/src/agents-md.ts](../packages/cli/src/agents-md.ts)
- **What:** Walks from `cwd` up through ancestor directories collecting
  `AGENTS.md` files, ordered **root-first** so org-wide instructions appear
  before repo-local ones.
- **Notable:** `.ouroboros` is reserved for runtime configuration; behavioural
  prose lives in `AGENTS.md` so it composes with the wider Agents.md
  ecosystem.

---

## 8. External Integration

### MCP Tool Federation
- **Where:** [packages/cli/src/mcp/manager.ts](../packages/cli/src/mcp/manager.ts),
  [packages/cli/src/mcp/adapter.ts](../packages/cli/src/mcp/adapter.ts)
- **What:** `McpManager` owns one `Client` per configured MCP server (stdio
  transport), discovers tools at startup, and registers them in the shared
  `ToolRegistry` via `mcpToolToDefinition`. The agent sees MCP tools as
  ordinary tools.
- **Crash supervision:** Exponential backoff (1s → 30s) reconnects dropped
  servers; tools attached to a disconnected server return clear errors rather
  than hanging.
- **Notable:** HTTP/remote MCP is wired into the config schema but rejected at
  startup — phase 2.

### Web Search & Web Fetch
- **Where:** [packages/cli/src/tools/web-search.ts](../packages/cli/src/tools/web-search.ts),
  [packages/cli/src/tools/web-fetch.ts](../packages/cli/src/tools/web-fetch.ts)
- **What:** Standard browse-the-web tooling, schema-validated like everything
  else.

---

## 9. Cross-Cutting Patterns

### Result Types Everywhere
Every fallible operation returns `Result<T, Error>` — tools, RSI stages,
skill activation, permission checks. Throwing is reserved for genuinely
exceptional bugs. This makes failure observable at every boundary.

### Error Isolation in Background Subsystems
Reflection, crystallisation, and dream stages run in `try / catch` shells
around the user task. RSI is best-effort; it cannot interrupt the loop.

### Decoupled Surfaces via Typed Events
The agent does not know about the CLI, the JSON-RPC server, or the Electron
desktop. All three subscribe to the same `AgentEvent` stream and render their
own view. This is the pattern that lets a single agent power both a terminal
session and a GUI without forking the run loop.

---

## Further Reading (in this repo)

- [docs/observe-reflect-crystallize-dream-memory-plan.md](observe-reflect-crystallize-dream-memory-plan.md) — original RSI lifecycle design.
- [docs/architecture.svg](architecture.svg) and [agentharness-arch.svg](agentharness-arch.svg) — system diagrams.
- [docs/multi-agent-orchestration.drawio](multi-agent-orchestration.drawio) — team-graph topology sketch.
- [docs/electron-desktop-prd.md](electron-desktop-prd.md) — how the desktop UI consumes the agent event stream.
- [CLAUDE.md](../CLAUDE.md) — current architecture and convention summary.
