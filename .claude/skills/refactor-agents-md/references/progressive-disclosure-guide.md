# Progressive Disclosure Guide for AGENTS.md

This reference provides deeper guidance on applying the Progressive Disclosure Principle
to agent instruction files. Read this when you need specifics on breadcrumb patterns,
monorepo strategies, or avoiding common anti-patterns.

## Table of Contents

1. [Why Progressive Disclosure Matters](#why-progressive-disclosure-matters)
2. [The Root File: What Stays](#the-root-file-what-stays)
3. [Subsidiary Files: Organization Patterns](#subsidiary-files-organization-patterns)
4. [Breadcrumb Patterns](#breadcrumb-patterns)
5. [Monorepo Layering](#monorepo-layering)
6. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
7. [Before and After Example](#before-and-after-example)

---

## Why Progressive Disclosure Matters

Frontier LLMs can follow roughly 150-200 instructions with reasonable consistency. Beyond
that, adherence degrades — the agent starts missing rules, conflating similar instructions,
or simply ignoring sections buried deep in a long file.

Every token in AGENTS.md loads on every request. A 300-line file about TypeScript conventions,
testing patterns, deployment procedures, and architecture details consumes context window
even when the agent is just fixing a typo in a README. That's context the agent could have
used for reasoning about the actual task.

Progressive disclosure solves this by giving the agent a small, focused root file with
breadcrumbs to deeper documentation. The agent reads the subsidiary files only when the
task requires that domain knowledge. The result: less noise, better instruction adherence,
and more context window available for real work.

## The Root File: What Stays

The root AGENTS.md should contain only information that every task needs — regardless of
whether the agent is writing code, fixing tests, updating docs, or refactoring.

**Always include:**
- One-sentence project description (what is this, in plain language)
- Package manager and runtime if non-standard (e.g., "Uses Bun, not Node")
- Build, test, and lint commands (the commands the agent will run most often)
- Universal workflow rules (e.g., "run the verification suite before reporting completion")

**Include only if brief (under 10 lines):**
- High-level architecture summary (just enough to orient, not to explain)
- Key conventions that affect every file (e.g., "use Zod for all runtime validation")

**Move to subsidiary files:**
- Detailed architecture explanations
- Language or framework-specific conventions
- Testing strategies and patterns
- Tool development guides
- Deployment procedures
- Security and permissions models (unless very brief)
- API design guidelines

## Subsidiary Files: Organization Patterns

Group related instructions into domain files. Use clear, predictable names:

```
doc/
  ARCHITECTURE.md    — System design, module boundaries, data flow
  CONVENTIONS.md     — Code style, naming, patterns to follow/avoid
  TESTING.md         — Test organization, fixture patterns, assertion style
  TOOLS.md           — Tool development, registry patterns, schema conventions
  DEPLOYMENT.md      — CI/CD, release process, environment config
```

Each subsidiary file should be self-contained — readable on its own without requiring
context from the root file. Start with a brief intro explaining the domain, then dive
into specifics.

For large subsidiary files (over 200 lines), consider a second level of splitting. But
be judicious — three well-organized 150-line files beat twelve 40-line fragments.

### Variant-Based Organization

When a project supports multiple frameworks or platforms, organize by variant:

```
doc/
  FRONTEND.md        — React-specific patterns
  BACKEND.md         — Express/Node conventions
  MOBILE.md          — React Native specifics
```

The agent reads only the variant relevant to the current task.

## Breadcrumb Patterns

Breadcrumbs are the navigation mechanism — they tell the agent where to find deeper
knowledge and, importantly, when to look for it.

### Good Breadcrumbs

Conversational, context-setting, placed where the content used to be:

```markdown
## Architecture

The system uses a ReAct loop with auto-discovered tools. For detailed architecture
including the core loop, tool registry, and memory system, see doc/ARCHITECTURE.md.
```

```markdown
## Testing

Run `bun test` for unit tests, `bun run test:all` for the full suite including live
LLM tests. For testing patterns, fixture conventions, and integration test setup,
see doc/TESTING.md.
```

Notice how each breadcrumb:
- Gives a one-line summary so the agent knows what the domain covers
- Names the file path explicitly
- Describes what's in the file so the agent knows when it's relevant

### Bad Breadcrumbs

**Link dumps** (no context for when to look):
```markdown
## References
- [Architecture](doc/ARCHITECTURE.md)
- [Testing](doc/TESTING.md)
- [Conventions](doc/CONVENTIONS.md)
```

**Too vague** (doesn't help the agent decide if it needs this):
```markdown
See doc/ARCHITECTURE.md for more info.
```

**Hidden** (agent may not notice):
```markdown
<!-- For architecture details, see doc/ARCHITECTURE.md -->
```

## Monorepo Layering

For monorepos, use a two-level hierarchy:

**Root AGENTS.md** covers:
- What the monorepo contains and its overall purpose
- Shared tooling (workspace manager, shared build commands)
- Cross-package conventions (naming, shared types, API contracts)
- Which package does what (brief directory guide)

**Package-level AGENTS.md** covers:
- Package-specific tech stack and dependencies
- Package-specific conventions and patterns
- Package-specific build/test commands (if different from root)
- Package-specific architecture notes

Package-level files merge with the root at runtime, so they should assume root context
is available. Don't duplicate — if the root file says "use Prettier for formatting," the
package file doesn't need to repeat it.

**Example root breadcrumb for packages:**

```markdown
## Packages

- `packages/api/` — Express REST API (see its AGENTS.md for API-specific patterns)
- `packages/web/` — Next.js frontend (see its AGENTS.md for component conventions)
- `packages/shared/` — Shared types and utilities
```

## Anti-Patterns to Avoid

### Stale Breadcrumbs
Pointing to files that don't exist or have been renamed. After refactoring, always verify
every breadcrumb path resolves.

### Over-Splitting
Creating a subsidiary file for a 5-line section. The breadcrumb itself would be nearly as
long. Rule of thumb: don't split sections under 10 lines unless they're part of a larger
domain grouping.

### Orphaned Files
Creating subsidiary files that nothing references. Every doc file should have at least one
breadcrumb pointing to it from the root (or from another subsidiary file in a chain).

### Content Duplication
Repeating the same instructions in both the root file and a subsidiary file "for emphasis."
This wastes tokens and creates maintenance burden — when the rule changes, you have to
update it in two places.

### Auto-Generated Bloat
Letting tools append to AGENTS.md without curation. Over time this creates a grab-bag of
conflicting rules. Periodically review and prune.

### Instruction Inflation
Adding MUST, ALWAYS, NEVER, IMPORTANT to every rule. When everything is critical, nothing
is. Reserve strong language for genuinely safety-critical instructions. For everything else,
explain why the rule exists — a smart agent will follow well-reasoned guidance more
consistently than it will follow shouted commands.

## Before and After Example

### Before (flat, 80+ lines)

```markdown
# MyProject — Development Instructions

## Project Overview
MyProject is a TypeScript REST API using Express and Prisma ORM.

## Tech Stack
- Runtime: Node.js 20
- Framework: Express 4
- ORM: Prisma with PostgreSQL
- Testing: Jest with supertest
- Linting: ESLint + Prettier

## Architecture
The project follows a layered architecture:
- Routes → Controllers → Services → Repositories
- Each layer has a single responsibility
- Controllers handle HTTP concerns (request parsing, response formatting)
- Services contain business logic
- Repositories handle database access via Prisma
- Middleware handles auth, validation, error handling
[... 20 more lines about architecture ...]

## Conventions
- Use camelCase for variables and functions
- Use PascalCase for types and interfaces
- All API responses use the ApiResponse<T> wrapper
- Error codes follow the ERROR_DOMAIN_SPECIFIC pattern
[... 15 more lines about conventions ...]

## Testing
- Unit tests go in __tests__/ next to source files
- Integration tests go in tests/integration/
- Use factories for test data, not raw objects
[... 15 more lines about testing ...]

## Commands
- npm run dev — start in development mode
- npm test — run all tests
- npm run build — build for production
- npm run lint — run linter
```

### After (progressive disclosure)

**Root AGENTS.md (25 lines):**

```markdown
# MyProject — Development Instructions

MyProject is a TypeScript REST API using Express and Prisma ORM on Node.js 20.

## Commands

- npm run dev — start in development mode
- npm test — run all tests
- npm run build — build for production
- npm run lint — run linter

## Workflow

After implementing a feature or fixing a bug, always run the full verification
suite before reporting completion:
1. `npm run lint`
2. `npm test`
Do not claim work is complete until both pass.

## Architecture

The project follows a layered architecture (Routes → Controllers → Services →
Repositories). For detailed architecture patterns and layer responsibilities,
see doc/ARCHITECTURE.md.

## Conventions

For naming conventions, API response patterns, and error code standards,
see doc/CONVENTIONS.md.

## Testing

For test organization, factory patterns, and integration test setup,
see doc/TESTING.md.
```

The root file went from 80+ lines to 25. The agent absorbs the essentials instantly and
knows exactly where to look when it needs deeper guidance.
