import type { Plan } from '../../shared/protocol'

function formatFiles(files: readonly string[]): string {
  return files.length > 0 ? files.map((file) => `\`${file}\``).join(', ') : 'None'
}

export function formatPlanMarkdown(plan: Plan): string {
  const steps = plan.steps
    .map((step, index) => {
      const deps = step.dependsOn?.length
        ? ` (after step ${step.dependsOn.map((dep) => dep + 1).join(', ')})`
        : ''
      const files = step.targetFiles.length > 0 ? `\n   Files: ${formatFiles(step.targetFiles)}` : ''
      return `${index + 1}. ${step.description}${deps}${files}`
    })
    .join('\n')

  return [
    `## ${plan.title}`,
    plan.summary,
    `### Steps\n${steps}`,
    `### Files Explored\n${formatFiles(plan.exploredFiles)}`,
    'Please approve the plan, reject it with feedback, or submit a custom response.',
  ].join('\n\n')
}

export function shouldReplaceWithSubmittedPlan(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase()
  return (
    normalized.length === 0 ||
    normalized === 'plan submitted.' ||
    normalized === 'plan submitted' ||
    normalized.startsWith('plan submitted. please review') ||
    normalized.startsWith('plan submitted for approval')
  )
}
