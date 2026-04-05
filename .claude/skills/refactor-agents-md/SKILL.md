---
name: refactor-agents-md
description: >
  Refactor an AGENTS.md or CLAUDE.md file using the Progressive Disclosure Principle
  so that only essential, universal instructions stay at root level while domain-specific
  guidance moves to subsidiary files loaded just-in-time. Use this skill whenever the user
  wants to restructure, slim down, optimize, or declutter their AGENTS.md or CLAUDE.md file,
  mentions "progressive disclosure" for agent instructions, says their instruction file is
  "too long" or "bloated," asks how to reduce token overhead in their agent config, or wants
  Claude to "only load what it needs." Also trigger when the user says things like "refactor
  my CLAUDE.md," "split up my AGENTS.md," "organize my agent instructions," or "my AGENTS.md
  has gotten out of hand."
---

# Refactor AGENTS.md with Progressive Disclosure

Frontier LLMs can follow roughly 150-200 instructions with reasonable consistency. Every
token in AGENTS.md loads on every single request — whether or not it's relevant to the
current task. A bloated instruction file wastes context window on guidance the agent doesn't
need right now, leaving less room for the actual work.

Progressive disclosure fixes this: keep the root file minimal (universal essentials only)
and move domain-specific guidance into subsidiary files that the agent reads only when
relevant. No content is lost — it's redistributed so the agent finds what it needs exactly
when it needs it.

## Workflow

### Step 1: Read and Measure

Read the current AGENTS.md (or CLAUDE.md — treat them identically). Note:
- Total line count
- Each `##` section heading and its approximate size
- Whether the project is a monorepo (multiple packages with their own instruction needs)

If the file is under 40 lines and cleanly organized, tell the user it's already lean and
progressive disclosure may not add much value. Offer to review it for other improvements
instead.

### Step 2: Classify Every Section

Go through each section and classify it as either **root-essential** or **domain-specific**.

**Root-essential** (stays in the root file):
- One-sentence project description (what this project is)
- Runtime / package manager (if non-standard)
- Build and test commands (the commands an agent needs for any task)
- Universal workflow rules (e.g., "always run lint before committing")
- Any rule that applies to literally every task regardless of domain

**Domain-specific** (moves to a subsidiary file):
- Language or framework conventions (TypeScript style, React patterns)
- Architecture details (system design, module boundaries, data flow)
- Testing patterns and strategies (test organization, fixture conventions)
- Tool or API-specific guidance (tool registry patterns, SDK usage)
- Deployment and CI/CD instructions
- Safety or permission models (unless they're brief enough for root)

When in doubt, ask: "Would an agent doing a completely unrelated task in this repo still
need this information?" If no, it's domain-specific.

### Step 3: Present the Refactoring Plan

Before touching any files, show the user a clear summary:

```
Sections staying at root:
  - Project Overview (3 lines)
  - Commands (8 lines)
  - Workflow (6 lines)

Sections moving to subsidiary files:
  - Architecture → doc/ARCHITECTURE.md
  - Conventions → doc/CONVENTIONS.md
  - Testing Patterns → doc/TESTING.md
```

Explain the rationale briefly. Ask the user to confirm or adjust — they may want to keep
certain sections at root, merge some subsidiary files, or use a different directory than
`doc/`.

### Step 4: Execute the Refactoring

Once approved:

1. **Create subsidiary files** in the agreed directory (default: `doc/`). Each file should:
   - Have a clear `# Title` matching its domain
   - Contain the full content extracted from the root file, unmodified
   - Be self-contained — someone reading just that file should understand the domain

2. **Rewrite the root AGENTS.md** with:
   - The root-essential sections, unchanged
   - Conversational breadcrumbs pointing to each subsidiary file

   Breadcrumbs should feel natural, not like a table of contents. Place them where the
   content used to be, so the flow still reads logically. For example:

   ```markdown
   ## Architecture

   For architecture details including the core loop pattern, tool registry,
   and memory system, see doc/ARCHITECTURE.md.
   ```

   Not a bulleted link dump — a sentence that tells the agent when and why to look there.

3. **Check for cross-references.** If the original file had internal references between
   sections (e.g., "as described in Architecture above"), update them to point to the
   correct subsidiary file.

For detailed guidance on what makes good breadcrumbs, monorepo layering, and common
anti-patterns, see `references/progressive-disclosure-guide.md`.

### Step 5: Verify

After refactoring, confirm:

- [ ] Root file is lean (ideally under 50 lines for most projects)
- [ ] Every breadcrumb path actually resolves to an existing file
- [ ] No content was lost — diff the total content before and after
- [ ] Subsidiary files are self-contained and clearly titled
- [ ] The root file still reads naturally top-to-bottom

If any check fails, fix it before reporting completion.

## Monorepo Handling

For monorepos, apply a two-level strategy:

- **Root AGENTS.md**: Monorepo purpose, shared tooling (package manager, workspace commands),
  cross-package conventions
- **Package-level AGENTS.md**: Package-specific tech stack, conventions, and commands

Don't duplicate — if the root file covers a topic, the package file should reference it
rather than repeat it. Package-level files merge with the root at runtime, so they can
assume root context is available.

## When to Stop Splitting

Progressive disclosure has diminishing returns. Don't create a subsidiary file for a section
that's only 3-5 lines — the breadcrumb itself would be nearly as long. A good rule of thumb:
if a section is under 10 lines and isn't part of a clear domain grouping, leave it at root.

The goal is a root file that an agent can absorb in seconds, with clear paths to deeper
knowledge. Not a fractal of tiny files.
