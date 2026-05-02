interface VerifyStep {
  name: string
  command: string[]
}

export const VERIFY_STEPS: VerifyStep[] = [
  { name: 'audit', command: ['bun', 'audit', '--prod'] },
  { name: 'lint', command: ['bun', 'run', 'lint'] },
  { name: 'ts-check', command: ['bun', 'run', 'ts-check'] },
  { name: 'test:all', command: ['bun', 'run', 'test:all'] },
]

export function buildVerifyPlan(args: string[]): {
  steps: VerifyStep[]
  ignoredArgs: string[]
} {
  return {
    steps: VERIFY_STEPS,
    ignoredArgs: args.filter((arg) => arg.length > 0),
  }
}

async function runStep(step: VerifyStep): Promise<void> {
  const proc = Bun.spawn(step.command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${step.name} failed with exit code ${exitCode}`)
  }
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const plan = buildVerifyPlan(args)

  if (plan.ignoredArgs.length > 0) {
    console.warn(`Ignoring verify arguments: ${plan.ignoredArgs.join(' ')}`)
  }

  for (const step of plan.steps) {
    await runStep(step)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
