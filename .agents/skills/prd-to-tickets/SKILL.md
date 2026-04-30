---
name: prd-to-tickets
description: "Use this skill whenever the user wants to generate implementation tickets from an existing PRD, break a PRD into engineering tickets, create ticket files from a product spec, or turn a requirements document into actionable work items. Triggers include: 'create tickets from PRD', 'break this into tickets', 'generate tickets', 'write tickets for this PRD', 'turn this PRD into tickets', 'make implementation tickets', 'ticket this up', or any request to take an existing PRD or product spec and produce individual implementation tickets. The PRD can be a local file (markdown). Also use when the user has just finished writing a PRD and wants to generate tickets from it. Use this skill even if the user just says 'create the tickets' or 'ticket this' when a PRD file is referenced. Do NOT use for writing PRDs from scratch."
---

# PRD to Tickets

Generate implementation-ready tickets from an existing Product Requirements Document.

## What this skill does

Takes an existing PRD — a local markdown — and produces individual implementation tickets as markdown files.

---

## Step 1: Locate and read the PRD

The PRD can come from several sources. Try them in this order:

### Option A: User provides a file path

If the user explicitly points to a file, use that. Supported formats:

- **Markdown files** (`.md`): Read directly using the Read tool.

### Option B: Auto-detect local file

Check these locations in the current working directory:

1. `PRD.md`
2. Any `prd-*.md` file in the current directory or nearby

### Option C: Ask the user

If no PRD is found locally, ask the user: "I can't find a PRD file. Do you have a file path to the PRD (markdown)?"

### After loading

Read the PRD thoroughly. Understand the phases, user stories, data model, and scope boundaries before generating any tickets.

If the PRD is unclear or has open questions that affect ticket breakdown, flag them to the user before proceeding.

---

## Step 2: Plan the ticket breakdown

Before writing tickets, outline the breakdown to the user:

- How many tickets per phase
- The dependency order
- Whether backend/frontend splits make sense for each piece

Get a quick confirmation before writing all the tickets. This avoids rework if the user has a different mental model of how the work should be split.

---

## Step 3: Generate implementation tickets

### Ticket philosophy

The tickets should be usable as project issues that an LLM or engineer can pick up and implement independently. Each ticket should be self-contained enough that someone (or an AI coding agent) can understand what to build, how to verify it, and what "done" looks like — without needing to read the entire PRD.

### Ticket structure

Use this as a guideline, not a rigid template. Adapt based on the project's norms and the ticket's complexity.

```markdown
# [Ticket Title]

**Phase:** [Which phase this belongs to]
**Type:** [Backend / Frontend / Full-stack / Infrastructure / Design]
**Priority:** [P0-P3 or High/Medium/Low]
**Depends on:** [Other ticket titles, if any]

## Context

Why this ticket exists. Brief background — enough that someone picking this up cold understands the motivation. Reference the PRD if needed.

## Requirements

What needs to be built. Be specific about behaviour, not implementation. Include:

- Functional requirements (what it does)
- Technical constraints (must use X pattern, must integrate with Y)
- Scope boundaries (what this ticket does NOT include)

## Acceptance Criteria

Concrete, testable conditions that must be true when this ticket is done.
Write these as checkable statements:

- [ ] User can [action] and sees [result]
- [ ] API returns [shape] when [condition]
- [ ] Error state [X] displays [message]

## Feature Tests

Describe the test scenarios that should be written as part of this ticket. Be specific about setup, action, and expected outcome. For example:

- **Test:** [Descriptive name]
  - **Setup:** [Preconditions]
  - **Action:** [What happens]
  - **Expected:** [What should result]

## Notes

Implementation hints, links to relevant code, design references, or anything else that helps. Optional.
```

### Splitting tickets

The default approach is to split backend and frontend work into separate tickets when the feature involves both, since this makes code review and deployment simpler. But use judgment — a tiny full-stack change that's easier to review as one unit should stay as one ticket.

Group tickets by phase. Within a phase, order them by dependency (things that need to be built first come first).

### The overarching ticket

In addition to individual implementation tickets, create one overarching "epic" ticket that:

- Summarises the entire feature
- Lists all child tickets in order, grouped by phase
- Includes a high-level dependency graph (which tickets block others)
- Links to the PRD

This is the ticket a project manager or tech lead uses to track the whole feature.

---

## Step 4: Save tickets locally

Save ticket files alongside the PRD. If the PRD is at `PRD.md`, save tickets into a `tickets/` subdirectory in the same location.

### File naming

```
tickets/00-epic-[feature-name].md  — The overarching epic ticket
tickets/01-[short-name].md         — First implementation ticket
tickets/02-[short-name].md         — Second implementation ticket
...
```

Use kebab-case for file names. Number tickets in dependency/phase order so they read naturally.

---

## Tips for writing good tickets

- **Be specific about behaviour, not implementation.** "The user sees a filterable table of agents" is better than "Render a React table component with useFilter hook." Tickets define _what_ to build with enough context on _how_ to get started.
- **Acceptance criteria should be falsifiable.** If you can't write a test for it, it's not a real acceptance criterion.
- **Feature tests are first-class citizens.** They limit ambiguity and tell the implementer exactly how to verify their work. Don't skimp on them.
- **Use the user's language.** If they call it an "agency," don't rename it to "organization" in the tickets. Consistency with the codebase and team vocabulary reduces friction.
- **Flag open questions explicitly.** It's better to say "Decision needed: should soft-delete or hard-delete?" than to silently pick one.
