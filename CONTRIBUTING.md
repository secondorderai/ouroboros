# Contributing To Ouroboros

Ouroboros is a Bun/TypeScript monorepo for a local autonomous agent runtime,
an Electron desktop app, runtime Agent Skills, structured memory, MCP
integrations, provider auth, and self-modification workflows.

Contributions are welcome, but this project has a larger safety surface than a
typical application. Treat local data, credentials, tools, and approval flows as
part of the product boundary.

## Public Safety Warnings

- Do not commit `.ouroboros`, `memory/`, transcripts, auth files, provider
  keys, local MCP secrets, local skill secrets, or any generated runtime state
  that may contain private workspace data.
- CLI self-modification requires explicit human approval. Do not bypass,
  weaken, or hide approval prompts for code-changing agent behavior.
- The desktop renderer must not access Node.js APIs directly. Keep context
  isolation enabled, keep Node integration disabled, and route privileged work
  through typed preload and main-process APIs.
- Third-party MCP servers, tools, and skills can be unsafe. They may access
  files, accounts, networks, credentials, or external services depending on
  their implementation and configuration.
- External contributors should not add or change high-permission tools,
  approval tiers, shell execution paths, filesystem access, auth handling, MCP
  permissions, or self-modification behavior without maintainer review.

## Development Setup

Install dependencies from the repository root:

```bash
bun install
```

Useful commands:

```bash
bun run verify
bun run lint
bun run ts-check
```

Package-specific commands:

```bash
cd packages/cli && bun test
cd packages/desktop && bun run dev
cd packages/desktop && bun run test:e2e
```

## Contribution Guidelines

- Keep changes scoped to one feature, fix, or documentation improvement.
- Use TypeScript, Zod validation, and existing package boundaries.
- Put CLI tool tests in `packages/cli/tests/tools/`.
- Update protocol contract tests when changing JSON-RPC methods,
  notifications, or shared protocol shapes.
- Add or update automated tests for every behavior change. A fix should include
  a test that would fail if the fix were reverted.
- Run `bun run verify` from the repository root before opening a pull request.

## Review Expectations

Maintainers will review safety-sensitive changes closely, especially changes
that affect approvals, autonomous actions, local file access, shell execution,
provider auth, MCP, runtime skills, memory, transcripts, Electron IPC, or
self-modification. Explain those changes clearly in the pull request and call
out any new permissions, data flows, or trust assumptions.
