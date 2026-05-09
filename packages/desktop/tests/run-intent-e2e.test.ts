import { describe, expect, test } from 'bun:test'

import {
  buildAgentPrompt,
  buildCodexCommand,
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
      '--agent-browser-bin',
      '/bin/agent-browser',
      '--codex-bin',
      '/bin/codex',
      '--model',
      'gpt-5.4',
      '--dry-run',
      '--headed',
    ])

    expect(options.planPath).toBe('test-plan/desktop-onboarding-chat.md')
    expect(options.debugPort).toBe(9333)
    expect(options.timeoutMs).toBe(1000)
    expect(options.scenarioPath).toBe('scenario.json')
    expect(options.agentBrowserBin).toBe('/bin/agent-browser')
    expect(options.codexBin).toBe('/bin/codex')
    expect(options.model).toBe('gpt-5.4')
    expect(options.dryRun).toBe(true)
    expect(options.headed).toBe(true)
  })

  test('builds a Codex prompt with skill, Agent Browser, and evidence instructions', () => {
    const prompt = buildAgentPrompt({
      planMarkdown: '# Plan\n\nDo the thing.',
      planPath: '/repo/test-plan/desktop-onboarding-chat.md',
      outputDir: '/tmp/out',
      debugPort: 9229,
      agentBrowserBin: '/bin/agent-browser',
      runtimePaths,
    })

    expect(prompt).toContain('Use the ouroboros-intent-e2e skill')
    expect(prompt).toContain('Drive the already-launched Electron app using Agent Browser')
    expect(prompt).toContain('/bin/agent-browser connect 9229')
    expect(prompt).toContain('do not use agent-browser chat')
    expect(prompt).toContain('Do not inspect source code')
    expect(prompt).toContain('Do not modify repo source files')
    expect(prompt).toContain('/tmp/out/report.md')
    expect(prompt).toContain('/tmp/out/result.json')
    expect(prompt).toContain('/tmp/out/mock-cli.log')
    expect(prompt).toContain('# Plan')
  })

  test('builds a non-interactive Codex command with model when provided', () => {
    const command = buildCodexCommand({
      codexBin: '/bin/codex',
      repoRoot: '/repo',
      outputDir: '/tmp/out',
      model: 'gpt-5.4',
    })

    expect(command).toEqual([
      '/bin/codex',
      '--ask-for-approval',
      'never',
      'exec',
      '--cd',
      '/repo',
      '--sandbox',
      'danger-full-access',
      '--output-last-message',
      '/tmp/out/codex-final.md',
      '--model',
      'gpt-5.4',
      '-',
    ])
  })

  test('omits Codex model argument when no model is provided', () => {
    const command = buildCodexCommand({
      codexBin: 'codex',
      repoRoot: '/repo',
      outputDir: '/tmp/out',
    })

    expect(command).not.toContain('--model')
    expect(command.at(-1)).toBe('-')
  })
})
