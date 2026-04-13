import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const AGENTS_MD_FILE_NAME = 'AGENTS.md'

export interface AgentsMdEntry {
  path: string
  content: string
}

/**
 * Resolve applicable AGENTS.md files from cwd upward.
 *
 * Returns entries ordered from root-most ancestor to nearest directory,
 * so broader instructions appear before more specific workspace/package ones.
 */
export function resolveAgentsMdFiles(cwd?: string): AgentsMdEntry[] {
  const startDir = resolve(cwd ?? process.cwd())
  const visited: string[] = []
  let currentDir = startDir

  while (true) {
    visited.push(currentDir)
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  const entries: AgentsMdEntry[] = []

  for (const dir of visited.reverse()) {
    const path = resolve(dir, AGENTS_MD_FILE_NAME)
    if (!existsSync(path)) continue

    const content = readFileSync(path, 'utf-8').trim()
    if (!content) continue

    entries.push({ path, content })
  }

  return entries
}

/**
 * Format discovered AGENTS.md files for prompt injection.
 */
export function getAgentsMdInstructions(cwd?: string): string {
  const entries = resolveAgentsMdFiles(cwd)
  if (entries.length === 0) return ''

  return entries
    .map((entry, index) => {
      const label = index === entries.length - 1 ? 'nearest' : 'ancestor'
      return `### ${label}: ${entry.path}\n\n${entry.content}`
    })
    .join('\n\n')
}
