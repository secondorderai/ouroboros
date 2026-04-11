/**
 * System Prompt Builder
 *
 * Assembles the system prompt from base instructions, tool schemas,
 * skill catalog, and memory context. Rebuilt at the start of each
 * conversation turn to reflect the latest state.
 *
 * The output is a plain string with no provider-specific formatting —
 * the Vercel AI SDK handles provider adaptation.
 */

import type { ToolMetadata } from '@src/tools/types'

/**
 * A skill entry for the system prompt catalog.
 * Contains only frontmatter-level data (name + description).
 * Full skill instructions are loaded on activation (ticket 07).
 */
export interface SkillEntry {
  /** Skill name (e.g. "web-search") */
  name: string
  /** One-line description of what the skill does */
  description: string
  /** Optional hint for when/how to activate this skill */
  activationHint?: string
}

/**
 * Options for building the system prompt.
 * All fields are optional — omitted or empty sections are excluded cleanly.
 */
export interface BuildSystemPromptOptions {
  /** Tool metadata from the tool registry (name, description, parameter schema) */
  tools?: ToolMetadata[]
  /** Skill catalog entries from discovered SKILL.md frontmatter */
  skills?: SkillEntry[]
  /** Raw MEMORY.md content to inject as memory context */
  memory?: string
  /** Whether RSI (self-improvement) is enabled */
  rsiEnabled?: boolean
  /** Optional response-style guidance for a specific client surface */
  responseStyle?: 'default' | 'desktop-readable'
}

// ---------------------------------------------------------------------------
// Base instructions template
// ---------------------------------------------------------------------------

const BASE_INSTRUCTIONS = `You are Ouroboros, a recursive self-improving AI agent. You operate as a TypeScript CLI tool that can read files, write code, run commands, and evolve your own capabilities over time.

## How You Work — The ReAct Pattern

For every task, follow the ReAct loop:

1. **Plan** — Think step-by-step about what needs to be done. Break complex tasks into smaller subtasks.
2. **Act** — Use the tools available to you to accomplish the current step. Pick the most appropriate tool for the job.
3. **Observe** — Examine the result of your action. Did it succeed? Did you learn something new?
4. **Iterate** — If the task is not complete, return to step 1 with updated understanding. If complete, summarize the result.

Always plan before acting. Never guess when you can verify.

## Output Format

- When you can answer directly from your knowledge or the conversation, respond with plain text.
- When you need to interact with the filesystem, run commands, or gather information, use tools.
- After using a tool, always interpret the result before proceeding.
- Keep responses focused and concise.

## Safety Tiers

You operate under a 5-tier permission model:

- **Tier 0 (Read-only):** Reading files, listing directories, searching — always allowed.
- **Tier 1 (Scoped writes):** Writing to project files, running safe commands — allowed by default.
- **Tier 2 (Skill generation):** Creating new skills and running self-tests — allowed by default.
- **Tier 3 (Self-modification):** Modifying your own code or configuration — requires human approval.
- **Tier 4 (System-level):** Installing packages, modifying system files — requires human approval.

Never attempt a higher-tier action without confirming you have permission.`

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

function formatToolsSection(tools: ToolMetadata[]): string {
  const entries = tools.map((tool) => {
    const schemaStr = JSON.stringify(tool.parameters, null, 2)
    return `### ${tool.name}\n\n${tool.description}\n\n**Parameters:**\n\`\`\`json\n${schemaStr}\n\`\`\``
  })

  return `## Available Tools\n\n${entries.join('\n\n')}`
}

function formatSkillsSection(skills: SkillEntry[]): string {
  const entries = skills.map((skill) => {
    let line = `- **${skill.name}** — ${skill.description}`
    if (skill.activationHint) {
      line += ` _(${skill.activationHint})_`
    }
    return line
  })

  return `## Skills\n\n${entries.join('\n')}`
}

function formatMemorySection(memory: string): string {
  return `## Memory Context\n\n${memory}`
}

function formatRSISection(): string {
  return `## Self-Improvement

You have autonomous self-improvement capabilities (RSI). After completing tasks, you automatically:
- **Reflect** on the approach used, assessing novelty and generalizability
- **Crystallize** novel patterns into reusable skills when they meet the quality threshold
- **Consolidate** memory at session end, merging and pruning topic files

All self-improvement activity is logged to the evolution log for auditability. These processes run automatically in the background and do not require user intervention.`
}

function formatResponseStyleSection(responseStyle: 'default' | 'desktop-readable'): string {
  if (responseStyle !== 'desktop-readable') {
    return ''
  }

  return `## Response Style

The current client is a desktop chat interface optimized for reading longer answers. Favor prose that scans cleanly:

- Apply this style on every desktop turn, including answers produced without any tool calls.
- The desktop client will render markdown, but it will not rewrite a dense answer for you after generation.
- Start with a short framing paragraph before lists when the task allows it.
- Lead with a direct answer or recommendation before supporting detail.
- Use bullets only for real enumeration, not for every sentence.
- Keep lists short by default, with no more than 4 bullets unless the task clearly needs more.
- Avoid nested bullets unless the user asked for structured steps or the task is procedural.
- Separate sections with blank lines.
- Use short, descriptive headings when they improve scanability.
- For comparisons or recommendations, prefer a compact pattern like "Option: why it fits".
- Avoid long uninterrupted blocks of text, raw dumps, and list items that contain multiple unrelated ideas.
- Prefer short paragraphs and clear headings over bulleting every sentence.`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the system prompt by assembling base instructions with optional
 * tool schemas, skill catalog, and memory context.
 *
 * Sections with no content (empty arrays, empty/undefined strings) are
 * omitted entirely — no blank headers or artifacts remain.
 *
 * @param options - Optional tools, skills, and memory to include
 * @returns A plain string system prompt ready for any LLM provider
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const { tools, skills, memory, rsiEnabled, responseStyle } = options

  const sections: string[] = [BASE_INSTRUCTIONS]

  if (responseStyle === 'desktop-readable') {
    sections.push(formatResponseStyleSection(responseStyle))
  }

  if (tools && tools.length > 0) {
    sections.push(formatToolsSection(tools))
  }

  if (skills && skills.length > 0) {
    sections.push(formatSkillsSection(skills))
  }

  if (memory && memory.trim().length > 0) {
    sections.push(formatMemorySection(memory))
  }

  if (rsiEnabled) {
    sections.push(formatRSISection())
  }

  return sections.join('\n\n')
}
