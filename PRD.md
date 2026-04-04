# OUROBOROS — Product Specification & Architecture

**The first autonomous AI agent that recursively self-improves — generating new ideas, writing its own skills, and evolving without human involvement.**

> Recursive Self-Improvement · Agent Skills · CLI + Desktop

**Version:** 0.1.0
**Date:** April 04, 2026
**Status:** CONFIDENTIAL — For internal development use

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision & Principles](#2-product-vision--principles)
   - 2.1 Core Concept: Recursive Self-Improvement
   - 2.2 Design Principles
   - 2.3 Differentiation
3. [Architecture](#3-architecture)
   - 3.1 Core Agent Loop
   - 3.2 RSI Engine — 4 Feedback Loops
   - 3.3 Tool Architecture
   - 3.4 Memory Architecture (3+1 Layers)
   - 3.5 Safety & Permissions (5 Tiers)
4. [Technology Stack](#4-technology-stack)
5. [Project Structure](#5-project-structure)
6. [Agent Skills Integration](#6-agent-skills-integration)
   - 6.1 SKILL.md Specification Compliance
   - 6.2 Skill Crystallization Pipeline
7. [Development Roadmap](#7-development-roadmap)
   - 7.1 Phase 1 — Core Engine (CLI MVP)
   - 7.2 Phase 2 — RSI Loops
   - 7.3 Phase 3 — SwiftUI Desktop App
   - 7.4 Phase 4 — Ecosystem & Polish
8. [Implementation Guide for Claude Code](#8-implementation-guide-for-claude-code)
9. [Appendix: References & Prior Art](#appendix-references--prior-art)

---

## 1. Executive Summary

Ouroboros is an open-source, general-purpose AI agent that can recursively self-improve. Unlike existing coding agents (Claude Code, Codex, Cursor) that require human direction for every task, Ouroboros introduces a meta-cognitive layer that enables it to reflect on completed tasks, extract reusable patterns into Agent Skills, validate those skills through automated testing, and consolidate its memory between sessions — all autonomously.

The agent's self-generated skills conform to the open Agent Skills standard (agentskills.io), meaning they are portable across Claude Code, OpenAI Codex, GitHub Copilot, and any other compliant agent. Ouroboros doesn't just use skills — it creates them, tests them, and evolves them over time.

The MVP is a TypeScript CLI that implements the core agent loop with a minimal tool set, a 3+1 layer memory system, and the first two RSI feedback loops (Skill Crystallization and Self-Testing). A subsequent phase wraps this in a SwiftUI desktop application for non-technical users.

> **Key Insight:** The core agent loop is simple (plan → act → observe → loop). What makes Ouroboros unique is the **meta-loop** that runs after task completion: Reflect → Extract Skill → Self-Test → Commit → Update Memory. This is how the agent improves itself.

---

## 2. Product Vision & Principles

### 2.1 Core Concept: Recursive Self-Improvement

Recursive Self-Improvement (RSI) means the agent can modify and enhance its own capabilities without human intervention. In practice, this decomposes into four concrete feedback loops that run alongside or after the primary task execution loop. Each loop is independently implementable and testable.

The fundamental mechanism is **Skill Crystallization**: after solving a novel problem, the agent reflects on whether the solution pattern is generalizable. If so, it writes a new SKILL.md file, generates test cases, validates the skill passes its own tests, and commits it to the skills directory. The next time a similar problem arises, the agent discovers and activates the skill — using proven instructions rather than reasoning from scratch. Over time, the agent accumulates a growing library of battle-tested skills, each one making it more capable and more efficient.

### 2.2 Design Principles

**Simplicity First.** The core agent loop should be under 500 lines of TypeScript. Complexity is added incrementally through skills, not through the harness itself.

**Skills as the Unit of Knowledge.** Everything the agent learns is encoded as an Agent Skill (agentskills.io format). Skills are portable, version-controlled, human-readable, and testable.

**Git-Native Evolution.** Every self-modification the agent makes is tracked in git. Skills, memory, configuration changes — all are committed with meaningful messages. This provides a full audit trail and enables rollback to any prior state.

**Provider-Agnostic.** The LLM backend is abstracted from day one. The agent can run on Claude, GPT, Gemma, Qwen, or any OpenAI-compatible API including self-hosted models.

**Progressive Disclosure.** Following the Agent Skills spec, the agent loads only skill metadata at startup. Full instructions are loaded on-demand when a skill is activated. Referenced files are read only when needed. This keeps context usage minimal regardless of how many skills are installed.

**Human-in-the-Loop Safety.** The agent can propose any self-modification, but a tiered permission system ensures destructive or high-risk changes require human approval.

### 2.3 Differentiation

Ouroboros is not a coding agent — it is a general-purpose agent harness with a self-improvement engine. While Claude Code and Codex are optimized for software engineering tasks, Ouroboros can crystallize skills for any domain: data analysis, research, writing, DevOps, design system management, or anything the user teaches it through interaction. The key differentiator is that every solved problem is a potential new skill, and the agent systematically converts experience into reusable capabilities.

---

## 3. Architecture

### 3.1 Core Agent Loop

The primary execution loop follows a standard ReAct (Reasoning + Acting) pattern. The agent receives user input, formulates a plan, executes tools, observes results, and iterates until the task is complete. This is the same fundamental pattern used by Claude Code, Codex, and most production agents.

```
User Input → System Prompt (with skill catalog) → LLM Planning → Tool Selection →
Tool Execution → Observation → LLM Reasoning → [Loop or Complete] →
Task Output → RSI Meta-Loop (reflect → crystallize → test → commit)
```

The meta-loop is what distinguishes Ouroboros. After every task completion, the agent enters a reflection phase where it evaluates whether the solution contains a generalizable pattern worth crystallizing into a skill.

### 3.2 RSI Engine — 4 Feedback Loops

#### Loop 1 — Skill Crystallization (MVP)

After the agent solves a novel problem, it uses a structured reflection prompt to determine: (a) Was this problem novel or did an existing skill handle it? (b) Is the solution pattern generalizable? (c) What would the trigger description be? If the answer to (a) is yes and (b) is yes, the agent generates a SKILL.md file conforming to the agentskills.io spec, including frontmatter (name, description, license, compatibility), step-by-step instructions, input/output examples, and edge case handling. The skill is written to `skills/generated/` and tracked in git.

#### Loop 2 — Self-Testing (MVP)

Every generated skill must include test cases in its `scripts/` directory. Before a skill is promoted from `skills/staging/` to `skills/generated/`, the agent runs all tests and verifies they pass. Test cases are themselves generated by the agent as part of skill crystallization. The test runner supports Python, Bash, and TypeScript test scripts. Failed skills are logged with failure reasons and can be retried or discarded.

#### Loop 3 — Memory Consolidation / Dream Cycle (Phase 2)

Inspired by Claude Code's autoDream feature. Between sessions or on explicit trigger, the agent reviews all session transcripts since the last consolidation, merges redundant knowledge, prunes contradictions in memory topic files, updates the MEMORY.md index, and — critically — generates Skill Proposals: hypothetical skills the agent believes would have been useful based on patterns observed across sessions. Proposals are stored in a backlog and can be built during idle time or on user request.

#### Loop 4 — Architecture Reflection (Phase 2+)

The agent periodically examines its own system prompt, tool implementations, and configuration. It can propose changes such as: adjusting its planning prompt for better performance, adding retry strategies for flaky tools, or suggesting new tool integrations. All proposals require Tier 3+ approval (human review). Proposals are presented as diffs against the current configuration.

### 3.3 Tool Architecture

Tools follow a registry pattern. Each tool is a self-contained module that exports a name, description (for LLM routing), a JSON schema for parameters, and an execute function. The tool registry discovers tools at startup and injects their descriptions into the system prompt.

#### Core Tools (always available)

| Tool | Description |
|------|-------------|
| BashTool | Execute shell commands with timeout, working directory, and environment variable support |
| FileReadTool | Read file contents with optional line range, supporting text and binary detection |
| FileWriteTool | Create new files with content, creating parent directories as needed |
| FileEditTool | Edit existing files using search-and-replace with unique string matching |
| WebFetchTool | Fetch URL contents with HTML-to-markdown extraction |
| WebSearchTool | Search the web via configurable search provider |
| AskUserTool | Prompt the user for input, confirmation, or clarification |
| TodoTool | Manage a structured task list (create, update, check off items) |

#### Meta Tools (for RSI)

| Tool | Description |
|------|-------------|
| ReflectTool | Structured self-reflection after task completion — evaluates novelty and generalizability |
| SkillGenTool | Generates SKILL.md from a solution pattern, including frontmatter, instructions, and tests |
| SelfTestTool | Runs test scripts from a skill's `scripts/` directory and reports pass/fail |
| SkillManagerTool | Discover, load, activate, deactivate, and list all installed skills |
| MemoryTool | CRUD operations on MEMORY.md index and topic files |
| DreamTool | Trigger memory consolidation — merge, deduplicate, prune, and generate skill proposals |

### 3.4 Memory Architecture (3+1 Layers)

| Layer | File/Store | Loaded When | Purpose |
|-------|-----------|-------------|---------|
| Layer 1 | `MEMORY.md` | Always (startup) | Index of all knowledge topics and skills. Table of contents for the agent's brain. |
| Layer 2 | `memory/topics/*.md` | On demand | Domain-specific knowledge files. Loaded when MEMORY.md references them during a task. |
| Layer 3 | SQLite DB | On search | Full session transcripts. Searchable via embedding or keyword. Raw material for Dream cycle. |
| Layer 4 (new) | `evolution.log` + git history | On review | Git-tracked changelog of every self-modification. Audit trail + training signal for RSI. |

### 3.5 Safety & Permissions (5 Tiers)

| Tier | Scope | Approval | Examples |
|------|-------|----------|----------|
| Tier 0 | Read-only | Always allowed | File reads, web searches, skill discovery, memory reads |
| Tier 1 | Scoped writes | Auto (logged) | File edits in working dir, todo updates, memory writes |
| Tier 2 | Skill generation | Auto + self-test | New SKILL.md creation, test generation, staging → active promotion |
| Tier 3 | Self-modification | Human approval | System prompt changes, tool config edits, permission model changes |
| Tier 4 | System-level | Human approval | Network access to new domains, package installs, process management |

---

## 4. Technology Stack

| Component | Choice |
|-----------|--------|
| **Runtime** | TypeScript on Bun — fast startup, built-in test runner, native TS support. Bun's speed is critical for a CLI that needs to feel instant. |
| **LLM Abstraction** | Vercel AI SDK (`ai` package) — provider-agnostic interface supporting Anthropic, OpenAI, Google, and OpenAI-compatible endpoints. Swap models via config, not code. |
| **CLI Framework** | Commander.js or Yargs for argument parsing. Ink (React for CLI) for rich terminal UI with spinners, progress bars, and interactive prompts. |
| **Persistence** | SQLite via `better-sqlite3` or Drizzle ORM for session transcripts and evolution logs. Filesystem (git-tracked) for MEMORY.md, skills, and topic files. |
| **Skill Format** | Agent Skills standard (agentskills.io) — SKILL.md with YAML frontmatter. Ensures cross-platform compatibility with Claude Code, Codex, Copilot. |
| **Testing** | Bun's built-in test runner for the harness itself. Skills use their own test scripts (Python/Bash/TS) executed by SelfTestTool. |
| **Desktop App** | SwiftUI (macOS) — native shell wrapping the CLI process via stdin/stdout JSON-RPC protocol. Separate repo, separate release cycle. |
| **Version Control** | Git is a first-class citizen. All agent self-modifications are committed with structured messages. Evolution log is a git log with semantic metadata. |

---

## 5. Project Structure

```
ouroboros/
├── src/
│   ├── cli.ts                 # Entry point, REPL loop, argument parsing
│   ├── agent.ts               # Core agent loop (plan → act → observe)
│   ├── config.ts              # Configuration loading (.ouroboros, env vars)
│   ├── llm/
│   │   ├── provider.ts        # LLM provider abstraction (Vercel AI SDK)
│   │   ├── prompt.ts          # System prompt template builder
│   │   └── streaming.ts       # Streaming response handler
│   ├── tools/
│   │   ├── registry.ts        # Tool discovery, schema injection, dispatch
│   │   ├── bash.ts            # Shell execution with sandbox
│   │   ├── file-read.ts       # File reading with line ranges
│   │   ├── file-write.ts      # File creation
│   │   ├── file-edit.ts       # Search-and-replace editing
│   │   ├── web-fetch.ts       # URL fetching with markdown extraction
│   │   ├── web-search.ts      # Web search via provider
│   │   ├── ask-user.ts        # User input/confirmation prompts
│   │   ├── todo.ts            # Task list management
│   │   ├── skill-manager.ts   # Skill CRUD, discovery, activation
│   │   ├── reflect.ts         # Post-task reflection tool
│   │   ├── skill-gen.ts       # SKILL.md generator from solution patterns
│   │   ├── self-test.ts       # Skill test runner
│   │   └── memory.ts          # Memory CRUD operations
│   ├── memory/
│   │   ├── index.ts           # MEMORY.md parser and updater
│   │   ├── topics.ts          # Topic file management
│   │   ├── transcripts.ts     # Session storage (SQLite)
│   │   └── dream.ts           # Consolidation / Dream cycle
│   ├── rsi/
│   │   ├── crystallize.ts     # Skill extraction pipeline
│   │   ├── validate.ts        # Skill validation (frontmatter, structure)
│   │   ├── evolve.ts          # Architecture reflection engine
│   │   └── evolution-log.ts   # Git-tracked change history
│   └── safety/
│       ├── permissions.ts     # 5-tier permission model
│       └── gatekeeper.ts      # Approval workflow (auto/human)
├── skills/
│   ├── core/                  # Built-in skills (shipped with Ouroboros)
│   ├── staging/               # Skills under test (not yet active)
│   └── generated/             # Self-generated skills (git-tracked)
├── memory/
│   ├── MEMORY.md              # Knowledge index
│   └── topics/                # Domain-specific knowledge files
├── tests/
│   ├── agent.test.ts          # Core loop tests
│   ├── tools/                 # Per-tool unit tests
│   ├── rsi/                   # RSI pipeline tests
│   └── integration/           # End-to-end scenarios
├── .ouroboros                  # Agent configuration (model, permissions, etc.)
├── package.json
├── tsconfig.json
├── bunfig.toml
└── CLAUDE.md                  # Instructions for Claude Code development
```

---

## 6. Agent Skills Integration

### 6.1 SKILL.md Specification Compliance

All skills — both built-in and self-generated — must conform to the Agent Skills open standard (agentskills.io/specification). This ensures skills are portable across Claude Code, Codex, Copilot, and any other compliant agent. The SkillGenTool must produce output that passes the `skills-ref` validation library (`github.com/agentskills/agentskills/tree/main/skills-ref`).

**Required SKILL.md structure:**

```yaml
---
name: skill-name              # lowercase, hyphens, max 64 chars
description: |                 # max 1024 chars, describes WHAT and WHEN
  What this skill does and when to activate it.
  Must be specific enough for LLM-based routing.
license: Apache-2.0
compatibility: Requires Python 3.11+
metadata:
  author: ouroboros-rsi
  version: "1.0"
  generated: "true"            # marks self-generated skills
  confidence: "0.85"           # agent's confidence in this skill
---

# Skill Title

Step-by-step instructions, examples, edge cases.
References to scripts/ and references/ as needed.
```

**Required skill directory structure:**

```
skill-name/
├── SKILL.md           # Required: metadata + instructions
├── scripts/
│   ├── run.py         # Optional: executable logic
│   └── test.py        # Required for generated skills: validation tests
├── references/
│   └── REFERENCE.md   # Optional: detailed docs loaded on demand
└── assets/            # Optional: templates, schemas, data files
```

### 6.2 Skill Crystallization Pipeline

The crystallization pipeline is the core RSI mechanism. It transforms a successful task solution into a reusable, testable, portable skill. The pipeline has five stages:

**1. Reflection.** After task completion, ReflectTool analyzes: Was this novel? Is the pattern generalizable? What would the trigger description be? Output: a structured reflection JSON with novelty score, pattern description, and proposed skill name.

**2. Generation.** If novelty score exceeds threshold, SkillGenTool generates the SKILL.md file, test scripts, and any reference documents. The description is carefully crafted for LLM-based routing — this is the most critical field, as it determines when the skill will be activated in future sessions.

**3. Validation.** The generated skill is validated against the agentskills.io spec using the `skills-ref` library. Frontmatter is checked for required fields, naming conventions, and character limits.

**4. Testing.** SelfTestTool executes all test scripts in the skill's `scripts/` directory. Each test must pass. If any test fails, the skill is logged with failure reasons and remains in `staging/` for retry.

**5. Promotion.** On all tests passing, the skill is moved from `skills/staging/` to `skills/generated/`, committed to git with a structured commit message, and the MEMORY.md index is updated to reference the new skill.

---

## 7. Development Roadmap

> **Approach:** Each phase is a self-contained milestone that produces a usable artifact. Phase 1 delivers a functional CLI agent. Phase 2 adds the RSI engine. Phase 3 wraps it in a desktop app. Phase 4 polishes the ecosystem. Each phase can be developed and shipped independently.

### 7.1 Phase 1 — Core Engine (CLI MVP)

Build the foundational agent harness as a TypeScript CLI. This phase produces a working agent that can execute tasks using the core tool set, maintain session memory, and discover/use manually-installed skills.

**Task 1.1 — Project scaffolding.** Initialize Bun project, configure TypeScript, set up directory structure per Section 5. Create `.ouroboros` config schema. Write CLAUDE.md for ongoing development.

**Task 1.2 — LLM provider abstraction.** Implement `provider.ts` using Vercel AI SDK. Support Anthropic (Claude), OpenAI, and OpenAI-compatible endpoints. Implement streaming response handler. Config-driven model selection.

**Task 1.3 — System prompt builder.** Implement `prompt.ts` that assembles the system prompt from: base instructions, available tool schemas, skill catalog (name + description from all SKILL.md frontmatter), and current memory context (MEMORY.md contents). The prompt must include tool use formatting for the selected provider.

**Task 1.4 — Core tools.** Implement all 8 core tools (BashTool, FileReadTool, FileWriteTool, FileEditTool, WebFetchTool, WebSearchTool, AskUserTool, TodoTool). Each tool exports: name, description, JSON schema, and async execute function. Tool registry auto-discovers tools from the `tools/` directory.

**Task 1.5 — Agent loop.** Implement `agent.ts` — the ReAct loop. Handles: streaming LLM response parsing, tool call extraction, tool execution with timeout/error handling, observation injection back into conversation, loop termination detection, and multi-turn conversation state management.

**Task 1.6 — CLI interface.** Implement `cli.ts` — the REPL. Supports: interactive mode (persistent conversation), single-shot mode (pipe in a prompt, get output), `--model` flag for provider/model selection, `--verbose` flag for showing tool calls, and graceful interrupt handling (Ctrl+C).

**Task 1.7 — Skill discovery.** Implement `skill-manager.ts` — reads SKILL.md frontmatter from `skills/core/` and `skills/generated/`, builds skill catalog for system prompt injection. Supports skill activation on demand (loading full SKILL.md body into context when the LLM selects a skill).

**Task 1.8 — Basic memory.** Implement MEMORY.md index loading at startup. Topic file reading on demand. Session transcript storage in SQLite (conversation turns, timestamps, tool calls, outputs).

**Task 1.9 — Tests.** Unit tests for each tool, integration tests for the agent loop with mock LLM responses, and a smoke test that runs a real task end-to-end.

**Deliverable:** A working CLI agent (`ouroboros` command) that can execute multi-step tasks using tools, discover and use installed skills, and persist session history.

**Success Criteria:** Agent can: (1) answer questions using web search, (2) read/write/edit files, (3) execute bash commands, (4) use an installed skill to complete a task, (5) maintain conversation across turns.

### 7.2 Phase 2 — RSI Loops

Add the Recursive Self-Improvement engine on top of the core agent. This phase makes Ouroboros self-improving.

**Task 2.1 — ReflectTool.** Implement structured post-task reflection. After the agent outputs a task result, trigger a reflection prompt that evaluates: novelty (was this handled by an existing skill?), generalizability (could this pattern help with future tasks?), and proposed skill metadata (name, description, key steps). Output: a JSON reflection record stored in the session transcript.

**Task 2.2 — SkillGenTool.** Generate a complete SKILL.md from a reflection record. Must produce valid agentskills.io frontmatter, markdown instructions, test scripts in `scripts/test.py` or `scripts/test.sh`, and optionally reference documents. The description field is crafted for optimal LLM routing — this is the most important field to get right.

**Task 2.3 — SelfTestTool.** Execute all test scripts in a skill's `scripts/` directory. Support Python, Bash, and TypeScript test files. Report pass/fail with stdout/stderr capture. Failed skills remain in `staging/`.

**Task 2.4 — Skill promotion pipeline.** Orchestrate the full crystallization flow: Reflect → Generate → Validate → Test → Promote. Skills move through `skills/staging/` → `skills/generated/`. Each promotion is a git commit.

**Task 2.5 — DreamTool (memory consolidation).** Implement the between-session memory consolidation cycle. Analyze session transcripts, identify patterns, merge redundant topic files, prune contradictions, update MEMORY.md index, and generate skill proposals (hypothetical skills based on observed patterns).

**Task 2.6 — Evolution log.** Track all self-modifications in a structured log. Each entry includes: timestamp, modification type (skill created, memory updated, config changed), before/after diff, and the reflection that motivated the change. The log is both a JSON file and a git history.

**Task 2.7 — Autonomous improvement cycle.** Wire the RSI loops into the agent's lifecycle. After task completion, automatically trigger reflection. On session end, optionally trigger dream cycle. On explicit user request, trigger architecture reflection. Make all of this configurable via `.ouroboros`.

**Deliverable:** An agent that autonomously creates, tests, and installs new skills after solving novel problems. Skills accumulate over time and improve the agent's capabilities.

**Success Criteria:** Agent can: (1) solve a novel problem, (2) reflect on it, (3) generate a valid SKILL.md, (4) test it, (5) promote it, (6) use the new skill on a similar problem in a later session.

### 7.3 Phase 3 — SwiftUI Desktop App

Wrap the CLI in a native macOS desktop application using SwiftUI. The desktop app is a presentation layer — all intelligence remains in the CLI process, communicated via a JSON-RPC protocol over stdin/stdout.

**Task 3.1 — JSON-RPC protocol.** Define a protocol for communication between the SwiftUI app and the CLI process. Messages include: user input, agent responses (streaming), tool call notifications, permission requests, skill events (created, tested, promoted), and memory events.

**Task 3.2 — Chat interface.** Primary view: a chat interface with streaming markdown rendering, code syntax highlighting, tool call visualization (collapsible panels showing tool name, input, output), and file attachments / drag-and-drop.

**Task 3.3 — Skills browser.** Secondary view: browse installed skills (core + generated), view SKILL.md contents, enable/disable skills, and view test results. Show skill evolution timeline (when each was created, how many times used, success rate).

**Task 3.4 — Evolution dashboard.** Tertiary view: visualize the agent's improvement over time. Charts showing: skills created over time, skill usage frequency, memory growth, session metrics. The evolution log rendered as a timeline.

**Task 3.5 — Approval queue.** When the agent proposes Tier 3/4 modifications, they appear in an approval queue. Each proposal shows the diff, the reflection that motivated it, and approve/reject/defer buttons.

**Task 3.6 — Settings.** Model selection, permission tier configuration, skill directories, memory settings, and dream cycle scheduling.

### 7.4 Phase 4 — Ecosystem & Polish

Polish the product, build community infrastructure, and add advanced features.

**Task 4.1 — Skill marketplace.** A registry where users can share and discover community-created skills. Skills are validated against the agentskills.io spec before publishing. Ratings, reviews, and usage stats.

**Task 4.2 — MCP server integration.** Support Model Context Protocol servers as tool providers, enabling the agent to interact with external services (databases, APIs, SaaS tools) without custom tool code.

**Task 4.3 — Multi-agent orchestration.** Support spawning sub-agents for parallel task execution, following the fork-join pattern. Sub-agents share the parent's context via prompt caching where available.

**Task 4.4 — Architecture reflection (Loop 4).** The agent can propose changes to its own system prompt, tool implementations, and retry strategies. All proposals require human approval and are presented as diffs.

**Task 4.5 — Plugin system.** Allow third-party tool bundles to be installed as npm packages. Each plugin exports tools following the same registry interface as built-in tools.

---

## 8. Implementation Guide for Claude Code

This section provides instructions for using Claude Code to implement Ouroboros. Copy the CLAUDE.md content below into the project root to give Claude Code the full context it needs.

> **How to use this document:** Pass this markdown file to Claude Code with the prompt: "Read the Ouroboros spec and begin implementing Phase 1. Start with project scaffolding (1.1), then move through each task sequentially. Create a CLAUDE.md from Section 8 first." Claude Code will read the document, understand the full architecture, and begin building.

### Recommended CLAUDE.md content

```markdown
# OUROBOROS — Development Instructions

## Project Overview
Ouroboros is a recursive self-improving AI agent. TypeScript CLI on Bun.
It uses the Agent Skills standard (agentskills.io) for portable skill format.

## Tech Stack
- Runtime: Bun (TypeScript)
- LLM: Vercel AI SDK (ai package) — provider-agnostic
- DB: SQLite via better-sqlite3 for transcripts
- CLI: Commander.js + Ink for rich terminal UI
- Testing: Bun test runner
- Skills: agentskills.io format (SKILL.md with YAML frontmatter)

## Architecture
- Core loop: ReAct pattern (plan → act → observe → loop)
- Tools: Registry pattern, auto-discovered from src/tools/
- Memory: 3+1 layers (MEMORY.md index, topic files, SQLite transcripts, evolution log)
- RSI: 4 feedback loops (crystallize, self-test, dream, evolve)
- Safety: 5-tier permission model

## Conventions
- All tools export: name, description, schema (JSON Schema), execute (async fn)
- Skills conform to agentskills.io spec — validate with skills-ref library
- Every self-modification is git-committed with structured message
- Use Zod for runtime type validation
- Prefer composition over inheritance
- Error handling: all tools return Result<T, Error> — never throw

## Commands
- bun run dev — start in development mode
- bun test — run all tests
- bun run build — build for distribution
- bun run lint — run linter
```

### Development Workflow with Claude Code

The recommended workflow is to implement each Phase 1 task as a separate Claude Code session. Start each session by referencing this spec and the specific task number. After each task, run tests to verify the implementation before moving to the next task. The CLAUDE.md file provides Claude Code with the persistent context it needs to maintain architectural consistency across sessions.

**Suggested prompts for each major task:**

**Task 1.1:** "Initialize the Ouroboros project per the spec. Set up Bun, TypeScript config, directory structure from Section 5, .ouroboros config schema using Zod, and the CLAUDE.md file."

**Task 1.2–1.3:** "Implement the LLM provider abstraction and system prompt builder. Use Vercel AI SDK. Support Anthropic and OpenAI providers. The system prompt must include tool schemas and skill catalog."

**Task 1.4:** "Implement all 8 core tools following the registry pattern. Each tool in its own file under src/tools/. Auto-discovery via the registry. Include unit tests for each tool."

**Task 1.5–1.6:** "Implement the agent loop (ReAct pattern) and CLI interface. Support streaming responses, multi-turn conversations, interactive and single-shot modes."

**Task 1.7–1.8:** "Implement skill discovery (reading SKILL.md frontmatter, building catalog, on-demand loading) and basic memory (MEMORY.md, topic files, SQLite transcripts)."

---

## Appendix: References & Prior Art

| Source | Description |
|--------|-------------|
| **Agent Skills Spec** | agentskills.io — Open standard for portable agent skills. Maintained by Anthropic. Claude Code, OpenAI Codex, GitHub Copilot all support this format. |
| **learn-claude-code** | github.com/shareAI-lab/learn-claude-code — Nano agent harness demonstrating the core loop can be built from scratch in minimal code. 45k+ GitHub stars. |
| **Claude Code Architecture** | Insights from the April 2026 source analysis: 3-layer memory, autoDream, fork-join subagents with KV cache sharing, 5-level permissions, ULTRAPLAN/KAIROS planning modes. |
| **Latent Space Analysis** | latent.space — Detailed breakdown of Claude Code internals including tool list, memory phases, compaction types, and resilience/retry patterns. |
| **Sebastian Raschka** | Top 6 architectural patterns: repo state in context, aggressive cache reuse, custom grep/glob/LSP, file read deduplication, structured session memory, subagents. |
| **Vercel AI SDK** | sdk.vercel.ai — Provider-agnostic LLM interface for TypeScript. Supports streaming, tool calling, and multi-provider switching. |

---

*End of specification. This document is intended to be passed to Claude Code as a complete blueprint for implementing Ouroboros. Start with Phase 1, Task 1.1.*
