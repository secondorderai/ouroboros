/**
 * SelfTestTool — Skill Test Runner
 *
 * Executes test scripts found in a skill's `scripts/` directory and reports
 * structured pass/fail results. This is the quality gate for skill promotion
 * from staging to active use.
 */
import { z } from 'zod'
import { type Result } from '@src/types'
import type { TypedToolExecute } from './types'
import { type SkillTestResult, runSkillTests } from '@src/rsi/validate'

export const name = 'self-test'

export const description =
  'Run test scripts in a skill directory and return structured pass/fail results. ' +
  'Discovers test files (*.test.ts, *.test.py, *.test.sh, test.ts, test.py, test.sh) ' +
  "in the skill's scripts/ directory and executes each with the appropriate runner."

export const schema = z.object({
  skillPath: z.string().describe('Path to the skill directory (e.g., skills/staging/my-skill)'),
})

export const execute: TypedToolExecute<typeof schema, SkillTestResult> = async (
  args,
): Promise<Result<SkillTestResult>> => {
  return runSkillTests(args.skillPath)
}
