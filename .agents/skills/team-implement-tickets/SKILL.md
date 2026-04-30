---
name: team-implement-tickets
description: "Orchestrate a parallel agent team (Sam, Tim, Jack) to implement tickets from the tickets/ folder. Reads all ticket files, resolves dependencies via topological sort into execution waves, presents the full execution plan for user approval, then spawns three Opus 4.6 1M max effort teammates in parallel to implement. Each teammate works in an isolated git worktree, requires plan approval before coding, and reports progress in a structured format. Use this skill whenever the user wants to: execute tickets with an agent team, implement tickets in parallel, run tickets from a tickets folder, dispatch agents to work on tickets, or says things like 'implement the tickets', 'execute the tickets', 'run the ticket team', 'start the team on tickets', or 'work through the tickets'. Also triggers when the user references a tickets/ folder and wants parallel implementation."
---

# Team Implement Tickets

Orchestrate three named teammates — **Sam**, **Tim**, and **Jack** — to implement tickets from the `tickets/` folder in parallel, respecting dependencies and requiring plan approval before each teammate writes code.

## Overview

The workflow is: **discover → parse → plan → approve → execute → report**.

Tickets are grouped into dependency waves. Within each wave, tickets are distributed across teammates and executed in parallel using isolated git worktrees. After each wave completes, worktree branches are merged before the next wave begins.

---

## Step 1: Discover and Parse Tickets

Glob for all `tickets/*.md` files. For each file:

1. **Read the full content**
2. **Extract metadata** from the header:
   - **Title**: The `# H1` heading
   - **Phase**: From `**Phase:**` field
   - **Type**: From `**Type:**` field
   - **Priority**: From `**Priority:**` field
   - **Dependencies**: From `**Depends on:**` field — parse as a list of ticket references (titles, numbers, or filenames)
3. **Extract acceptance criteria**: All `- [ ]` and `- [x]` lines under the `## Acceptance Criteria` section
4. **Store the full ticket content** for later use in teammate prompts

**Skip epic tickets** — files matching `*epic*` pattern (e.g., `00-epic-feature.md`). These are tracking summaries, not implementation work.

If the `tickets/` folder doesn't exist or is empty, tell the user and stop.

---

## Step 2: Build Dependency Graph and Execution Waves

Resolve dependencies into a directed acyclic graph, then compute execution waves via topological sort:

- **Wave 0**: Tickets with no dependencies (or whose dependencies are all already satisfied)
- **Wave 1**: Tickets that depend only on Wave 0 tickets
- **Wave N**: Tickets that depend only on tickets in Waves 0 through N-1

If a circular dependency is detected, stop and show the cycle to the user for resolution.

If a dependency references a ticket that doesn't exist, flag it to the user and ask how to proceed.

---

## Step 3: Assign Tickets to Teammates

Distribute tickets within each wave across Sam, Tim, and Jack using round-robin assignment:

- If a wave has ≤3 tickets: one per teammate
- If a wave has >3 tickets: teammates receive multiple tickets and implement them sequentially within their single agent session

Store the assignment mapping for the execution plan.

---

## Step 4: Present the Execution Plan

Display the full plan to the user before any work begins:

```
## Execution Plan

### Wave 0 — No dependencies
- **Sam** → [Ticket title] (`tickets/01-xxx.md`)
- **Tim** → [Ticket title] (`tickets/02-xxx.md`)
- **Jack** → [Ticket title] (`tickets/03-xxx.md`)

### Wave 1 — Depends on Wave 0
- **Sam** → [Ticket title] (`tickets/04-xxx.md`)
- **Tim** → [Ticket title] (`tickets/05-xxx.md`)

### Summary
- Total tickets: X
- Total waves: Y
- Teammates: Sam, Tim, Jack (Opus 4.6 1M max effort)
- Isolation: git worktrees (one per teammate per wave)
```

**Wait for explicit user approval before proceeding.** Ask: _"Does this execution plan look good? I'll begin once you confirm."_

The user may want to adjust assignments, reorder tickets, or exclude certain tickets. Accommodate any changes and re-present the plan.

---

## Step 5: Execute Wave by Wave

Process each wave sequentially. Within each wave, spawn all teammates in parallel.

### 5a. Set Up Progress Tracking

Use TodoWrite to create a task for every ticket, all initially `pending`. As each wave starts, mark its tickets `in_progress`. As teammates complete, mark tickets `completed`.

### 5b. Spawn Teammates

For each teammate assignment in the current wave, use the **Agent tool** with these parameters:

| Parameter     | Value                                                    |
| ------------- | -------------------------------------------------------- |
| `name`        | `"Sam"`, `"Tim"`, or `"Jack"`                            |
| `model`       | `"opus"`                                                 |
| `mode`        | `"plan"`                                                 |
| `isolation`   | `"worktree"`                                             |
| `description` | Short summary, e.g. `"Sam: implement user auth backend"` |

- **Model**: Must use `"opus"` — this selects **Opus 4.6 with 1M context window**, the most capable model available. Do not downgrade to a smaller model.
- **Max effort**: Each teammate prompt should be comprehensive and detailed. Include the full ticket content, project context, and explicit instructions. Do not abbreviate or summarize — give teammates everything they need to deliver high-quality work autonomously.

**Spawn ALL teammates for the wave in a single message** so they run in parallel.

### 5c. Teammate Prompt Template

Each teammate receives this prompt (fill in the placeholders):

---

You are **{teammate_name}**, one of three teammates (Sam, Tim, Jack) implementing tickets in parallel.

### Your Ticket

```
{paste the full ticket content here}
```

**Ticket file path:** `{ticket_file_path}`

### Project Context

Read `AGENTS.md` at the project root for tech stack, conventions, and architecture guidance. Follow all project conventions.

### Instructions

1. **Understand the ticket** — Read the requirements, acceptance criteria, and feature tests thoroughly.
2. **Plan your approach** — Your plan will need approval before you proceed to implementation. Be specific about which files you'll create or modify.
3. **Implement** — Write clean, production-quality code that satisfies all requirements and acceptance criteria.
4. **Test** — Run relevant tests. If the ticket includes feature test specifications, implement those tests.
5. **Update the ticket** — Edit `{ticket_file_path}` and change each `- [ ]` to `- [x]` for every acceptance criterion you have fulfilled. Only mark criteria you are confident are met.

### Output Format

When you are done, report your results in exactly this format:

## {Ticket Title}

- **Status**: completed
- **Details**: [Brief summary of what you implemented]
- **Files Changed**: [List every file you created or modified]

---

### 5d. Process Teammate Results

As each teammate completes:

1. **Display their progress report** to the user immediately
2. **Mark the ticket as completed** in the todo list
3. **Note the worktree branch** returned by the Agent tool (needed for merging)

### 5e. Merge Worktree Branches

After ALL teammates in a wave have completed:

1. For each completed worktree that has changes, merge its branch into the current branch:
   ```
   git merge <worktree-branch> --no-edit
   ```
2. If a merge conflict occurs, stop and present it to the user for resolution before continuing
3. Verify the merge succeeded before proceeding to the next wave

### 5f. Wave Summary

After merging, display a brief wave summary:

```
### Wave N Complete
- Sam: ✓ [Ticket title]
- Tim: ✓ [Ticket title]
- Jack: ✓ [Ticket title]
Proceeding to Wave N+1...
```

Then continue to the next wave.

---

## Step 6: Final Summary

After all waves are complete, present:

```
## Implementation Complete

### Results
- **Tickets completed**: X/Y
- **Waves executed**: Z

### Progress Reports

{Paste all teammate progress reports here, in execution order}

### All Files Changed
{Deduplicated, sorted list of every file created or modified across all tickets}
```

---

## Error Handling

- **Teammate fails or gets stuck**: Report the failure to the user. Offer options: retry the ticket, skip it, or reassign to another teammate.
- **Merge conflict**: Stop and show the conflict. Let the user resolve it before continuing.
- **Partial completion**: If a teammate couldn't fulfill all acceptance criteria, only mark the ones that were actually met. Report which criteria remain open.
- **User cancels mid-execution**: Summarize what's done, what's in progress, and what remains. Merge any completed worktrees.
