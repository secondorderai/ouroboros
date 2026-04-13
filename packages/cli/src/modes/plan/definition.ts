/**
 * Plan Mode Definition
 *
 * Configures how the agent behaves when plan mode is active:
 * - System prompt section with planning instructions
 * - Tool allow/block lists (read-only exploration only)
 * - Bash command interceptor (blocks write operations)
 * - Auto-detection hint (tells LLM when to auto-enter)
 */

import type { ModeDefinition } from '../types'

/** Bash commands/patterns that are blocked in plan mode. */
const BLOCKED_BASH_PATTERNS = [
  // File mutation
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bcp\b.*(?:>|>>)/,
  // Output redirection (file writes)
  /(?:^|[^2])>/,
  />>/, // append
  // Git mutations
  /\bgit\s+(?:commit|push|merge|rebase|reset|checkout\s+-b|branch\s+-[dD]|stash\s+drop|tag)\b/,
  // Package manager installs
  /\b(?:npm|yarn|pnpm|bun)\s+(?:install|add|remove|uninstall)\b/,
  /\bpip\s+install\b/,
  // Dangerous
  /\bsudo\b/,
]

function bashInterceptor(command: string): string | null {
  for (const pattern of BLOCKED_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return (
        `[Plan Mode] Command blocked: this command would modify the filesystem or repository. ` +
        `In plan mode, you may only run read-only commands (e.g. cat, ls, find, grep, git log, git diff). ` +
        `Include this operation as a step in your plan instead.`
      )
    }
  }
  return null
}

const SYSTEM_PROMPT_SECTION = `## Active Mode: Plan

You are currently in **PLAN MODE**. Your task is to analyze the user's request, explore the codebase to understand context, and produce a structured plan BEFORE making any changes.

### Rules
- Do NOT modify any files. You may only read files and run read-only commands.
- Explore the codebase thoroughly to understand the full scope of the change.
- When you have a complete understanding, call the \`submit-plan\` tool with your structured plan.
- After submitting, present the plan as text and end your turn. Do NOT call ask-user.
- The user will respond in their next message with approve, reject (with feedback), or cancel.
- If rejected, revise the plan based on feedback and resubmit.

### Planning Process
1. **Understand** — Read the user's request carefully. Identify what needs to change.
2. **Explore** — Use file-read and bash (read-only) to examine relevant code, tests, and documentation.
3. **Design** — Determine the approach: which files to modify, what changes to make, in what order.
4. **Submit** — Call submit-plan with a structured plan including title, summary, ordered steps, target files, and dependencies.

### Plan Quality
A good plan:
- Has a clear, specific title and summary
- Breaks work into ordered, atomic steps
- Lists the specific files each step will modify
- Notes dependencies between steps
- Considers edge cases and test coverage`

const AUTO_DETECTION_HINT = `### Plan Mode
For complex, multi-step tasks that benefit from upfront planning, you can enter Plan Mode by calling the \`enter-mode\` tool with mode="plan". Consider entering plan mode when:
- The task involves modifying 3 or more files
- The task has unclear scope that needs codebase exploration first
- The task is architecturally significant (new systems, refactors, migrations)
- The user explicitly asks you to plan first

Do NOT enter plan mode for:
- Simple questions or explanations
- Single-file edits with clear scope
- Running commands or reading files
- Tasks the user wants done immediately`

export const PLAN_MODE: ModeDefinition = {
  id: 'plan',
  displayName: 'Plan',
  systemPromptSection: SYSTEM_PROMPT_SECTION,
  allowedTools: [
    'file-read',
    'bash',
    'web-search',
    'web-fetch',
    'memory',
    'ask-user',
    'todo',
    'submit-plan',
    'exit-mode',
  ],
  blockedTools: [
    'file-write',
    'file-edit',
    'skill-gen',
    'crystallize',
    'dream',
    'evolution',
    'reflect',
    'self-test',
  ],
  autoDetectable: true,
  autoDetectionHint: AUTO_DETECTION_HINT,
  bashInterceptor,
}
