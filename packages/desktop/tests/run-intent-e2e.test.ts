import { describe, expect, test } from 'bun:test'

import {
  buildAgentPrompt,
  buildRunId,
  parseArgs,
  slugifyPlanName,
} from '../scripts/run-intent-e2e'

const runtimePaths = {
  runtimeDir: '/tmp/run',
  scenarioPath: '/tmp/run/scenario.json',
  dialogResponsesPath: '/tmp/run/dialog-responses.json',
  policyResponsesPath: '/tmp/run/policy-responses.json',
  statePath: '/tmp/run/mock-state.json',
  mockLogPath: '/tmp/out/mock-cli.log',
  installUpdateLogPath: '/tmp/out/install-update.log',
  externalUrlLogPath: '/tmp/out/external-url.log',
  openArtifactLogPath: '/tmp/out/open-artifact.log',
  saveArtifactLogPath: '/tmp/out/save-artifact.log',
  bootLogPath: '/tmp/out/boot.log',
  updateDownloadedPath: '/tmp/run/update-downloaded.txt',
  userDataDir: '/tmp/run/user-data',
}

describe('intent E2E runner helpers', () => {
  test('slugifies plan names for stable sessions and run IDs', () => {
    expect(slugifyPlanName('test-plan/Desktop Onboarding & Chat.md')).toBe(
      'desktop-onboarding-chat',
    )
    expect(buildRunId('/plans/a.md', new Date('2026-05-08T01:02:03.004Z'))).toBe(
      '2026-05-08T01-02-03-004Z-a',
    )
  })

  test('parses runner options', () => {
    const options = parseArgs([
      'test-plan/desktop-onboarding-chat.md',
      '--debug-port',
      '9333',
      '--timeout-ms',
      '1000',
      '--scenario',
      'scenario.json',
      '--dry-run',
      '--headed',
    ])

    expect(options.planPath).toBe('test-plan/desktop-onboarding-chat.md')
    expect(options.debugPort).toBe(9333)
    expect(options.timeoutMs).toBe(1000)
    expect(options.scenarioPath).toBe('scenario.json')
    expect(options.dryRun).toBe(true)
    expect(options.headed).toBe(true)
  })

  test('builds a prompt with CDP, evidence, and no-source-inspection instructions', () => {
    const prompt = buildAgentPrompt({
      planMarkdown: '# Plan\n\nDo the thing.',
      planPath: '/repo/test-plan/desktop-onboarding-chat.md',
      outputDir: '/tmp/out',
      debugPort: 9229,
      runtimePaths,
    })

    expect(prompt).toContain('agent-browser connect 9229')
    expect(prompt).toContain('Do not inspect source code')
    expect(prompt).toContain('/tmp/out/report.md')
    expect(prompt).toContain('/tmp/out/result.json')
    expect(prompt).toContain('/tmp/out/mock-cli.log')
    expect(prompt).toContain('# Plan')
  })
})
