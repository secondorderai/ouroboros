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
  /** Legacy raw MEMORY.md content to inject as durable memory */
  memory?: string
  /** Structured memory sections loaded independently and budgeted upstream */
  memorySections?: {
    durableMemory?: string
    checkpointMemory?: string
    workingMemory?: string
  }
  /** Raw AGENTS.md instructions resolved from cwd ancestors */
  agentsInstructions?: string
  /** Whether RSI (self-improvement) is enabled */
  rsiEnabled?: boolean
  /** Optional response-style guidance for a specific client surface */
  responseStyle?: 'default' | 'desktop-readable'
  /** Mode overlay — active mode section or auto-detection hints */
  modeOverlay?: { section?: string; autoDetectionHints: string[] }
  /** Optional team reputation/advisor guidance from prior orchestration outcomes. */
  teamGuidance?: string
  /** Include full JSON schemas in the prompt. Native tool calls carry schemas separately. */
  includeToolSchemasInPrompt?: boolean
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
- When relying on subagent results, mention any contradictions or unresolved risks before treating the result as reliable.
- Keep responses focused and concise.

## Safety Tiers

You operate under a 5-tier permission model:

- **Tier 0 (Read-only):** Reading files, listing directories, searching — always allowed.
- **Tier 1 (Scoped writes):** Writing to project files, running safe commands — allowed by default.
- **Tier 2 (Skill generation):** Creating new skills and running self-tests — allowed by default.
- **Tier 3 (Self-modification):** Modifying your own code or configuration — requires human approval.
- **Tier 4 (System-level):** Installing packages, modifying system files — requires human approval.

Never attempt a higher-tier action without confirming you have permission.

## Diagrams — When to Use Visual Diagrams

The desktop client can render embedded diagrams natively via Mermaid. When explaining a structure, process, or relationship that benefits from a visual representation, include a fenced code block with \`mermaid\` as the language alongside your prose.

Use Mermaid (fenced with \`\`\`mermaid) for all diagrams. It renders client-side with no network required. Supported Mermaid diagram types:
- **Architecture / component relationships** → \`graph TD\` or \`graph LR\`
- **Process flows / decision trees** → \`graph TD\` with labeled edges
- **Sequence of interactions** → \`sequenceDiagram\`
- **State transitions** → \`stateDiagram-v2\`
- **Data relationships** → \`erDiagram\`
- **Timelines / project plans** → \`gantt\`
- **Mind maps / idea trees** → \`mindmap\`

Guidelines:
- Keep diagrams focused — break complex ones into two smaller diagrams rather than one sprawling graph.
- Use short, readable node labels.
- Use semantic grouping primitives so the desktop client can make diagrams easier to scan:
  - Flowcharts and architecture diagrams: use \`subgraph\` blocks for related concepts.
  - Sequence diagrams: name each participant clearly and keep messages short.
  - State diagrams: use composite states for grouped lifecycle phases.
  - ER diagrams: keep entity names concise and relationships explicit.
  - Gantt/timeline diagrams: use meaningful sections or periods.
  - Mind maps: use stable top-level branches for major themes.
- Use explicit \`classDef\` or \`style\` only when a semantic category needs a specific visual treatment; otherwise rely on the desktop renderer's automatic theme-aware coloring.
- Place the diagram near the related explanation, not buried at the end of a response.
- If a diagram would not add clarity beyond a short paragraph, skip it — diagrams complement prose, they don't replace it.`

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

function formatToolsSection(tools: ToolMetadata[], includeSchemas = false): string {
  const entries = tools.map((tool) => {
    if (!includeSchemas) {
      return `- **${tool.name}** — ${tool.description}`
    }

    const schemaStr = JSON.stringify(tool.parameters, null, 2)
    return `### ${tool.name}\n\n${tool.description}\n\n**Parameters:**\n\`\`\`json\n${schemaStr}\n\`\`\``
  })

  return `## Available Tools\n\nTool parameter schemas are provided through native tool definitions. Use this catalog to choose the right tool.\n\n${entries.join(includeSchemas ? '\n\n' : '\n')}`
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

function formatMemorySection(
  memorySections: NonNullable<BuildSystemPromptOptions['memorySections']>,
): string {
  const sections: string[] = []

  if (memorySections.durableMemory?.trim()) {
    sections.push(`### Durable Memory\n\n${memorySections.durableMemory.trim()}`)
  }

  if (memorySections.checkpointMemory?.trim()) {
    sections.push(`### Checkpoint Memory\n\n${memorySections.checkpointMemory.trim()}`)
  }

  if (memorySections.workingMemory?.trim()) {
    sections.push(`### Working Memory\n\n${memorySections.workingMemory.trim()}`)
  }

  if (sections.length === 0) {
    return ''
  }

  return `## Memory Context\n\n${sections.join('\n\n')}`
}

function formatAgentsSection(agentsInstructions: string): string {
  return `## AGENTS.md Instructions\n\n${agentsInstructions}`
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

function formatModeSection(section: string): string {
  // The section already includes its own heading (e.g. "## Active Mode: Plan")
  return section
}

function formatAutoDetectionSection(hints: string[]): string {
  return `## Mode Awareness\n\nYou have access to specialized modes that change your behavior for specific tasks.\n\n${hints.join('\n\n')}`
}

function formatTeamGuidanceSection(guidance: string): string {
  return `## Team Orchestration Guidance\n\n${guidance.trim()}`
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
  const {
    tools,
    skills,
    memory,
    memorySections,
    agentsInstructions,
    rsiEnabled,
    responseStyle,
    modeOverlay,
    teamGuidance,
    includeToolSchemasInPrompt,
  } = options

  const sections: string[] = [BASE_INSTRUCTIONS]
  const resolvedMemorySections =
    memorySections ??
    (memory && memory.trim().length > 0 ? { durableMemory: memory.trim() } : undefined)

  if (responseStyle === 'desktop-readable') {
    sections.push(formatResponseStyleSection(responseStyle))
  }

  // Inject mode overlay: either the active mode's prompt or auto-detection hints
  if (modeOverlay?.section) {
    sections.push(formatModeSection(modeOverlay.section))
  } else if (modeOverlay?.autoDetectionHints && modeOverlay.autoDetectionHints.length > 0) {
    sections.push(formatAutoDetectionSection(modeOverlay.autoDetectionHints))
  }

  if (tools && tools.length > 0) {
    sections.push(formatToolsSection(tools, includeToolSchemasInPrompt))
  }

  if (skills && skills.length > 0) {
    sections.push(formatSkillsSection(skills))
  }

  if (teamGuidance?.trim()) {
    sections.push(formatTeamGuidanceSection(teamGuidance))
  }

  if (resolvedMemorySections) {
    const memorySection = formatMemorySection(resolvedMemorySections)
    if (memorySection) {
      sections.push(memorySection)
    }
  }

  if (agentsInstructions && agentsInstructions.trim().length > 0) {
    sections.push(formatAgentsSection(agentsInstructions))
  }

  if (rsiEnabled) {
    sections.push(formatRSISection())
  }

  return sections.join('\n\n')
}
