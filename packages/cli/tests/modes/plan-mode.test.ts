import { describe, test, expect } from 'bun:test'
import { PLAN_MODE } from '@src/modes/plan/definition'

describe('Plan Mode Definition', () => {
  test('has correct id and display name', () => {
    expect(PLAN_MODE.id).toBe('plan')
    expect(PLAN_MODE.displayName).toBe('Plan')
  })

  test('is auto-detectable', () => {
    expect(PLAN_MODE.autoDetectable).toBe(true)
    expect(PLAN_MODE.autoDetectionHint).toBeTruthy()
  })

  test('allows read-only tools', () => {
    expect(PLAN_MODE.allowedTools).toContain('file-read')
    expect(PLAN_MODE.allowedTools).toContain('bash')
    expect(PLAN_MODE.allowedTools).toContain('web-search')
    expect(PLAN_MODE.allowedTools).toContain('ask-user')
    expect(PLAN_MODE.allowedTools).toContain('submit-plan')
    expect(PLAN_MODE.allowedTools).toContain('exit-mode')
  })

  test('blocks write tools', () => {
    expect(PLAN_MODE.blockedTools).toContain('file-write')
    expect(PLAN_MODE.blockedTools).toContain('file-edit')
    expect(PLAN_MODE.blockedTools).toContain('skill-gen')
  })

  test('has system prompt section', () => {
    expect(PLAN_MODE.systemPromptSection).toContain('PLAN MODE')
    expect(PLAN_MODE.systemPromptSection).toContain('submit-plan')
  })

  describe('bashInterceptor', () => {
    const intercept = PLAN_MODE.bashInterceptor!

    test('allows read-only commands', () => {
      expect(intercept('ls -la')).toBeNull()
      expect(intercept('cat file.ts')).toBeNull()
      expect(intercept('grep -r "pattern" src/')).toBeNull()
      expect(intercept('git log --oneline')).toBeNull()
      expect(intercept('git diff HEAD')).toBeNull()
      expect(intercept('find . -name "*.ts"')).toBeNull()
      expect(intercept('wc -l file.ts')).toBeNull()
    })

    test('blocks file deletion', () => {
      expect(intercept('rm file.ts')).not.toBeNull()
      expect(intercept('rm -rf dir/')).not.toBeNull()
    })

    test('blocks file moves', () => {
      expect(intercept('mv old.ts new.ts')).not.toBeNull()
    })

    test('blocks directory creation', () => {
      expect(intercept('mkdir new-dir')).not.toBeNull()
    })

    test('blocks output redirection', () => {
      expect(intercept('echo "test" > file.ts')).not.toBeNull()
      expect(intercept('cat a >> b')).not.toBeNull()
    })

    test('blocks git mutations', () => {
      expect(intercept('git commit -m "test"')).not.toBeNull()
      expect(intercept('git push origin main')).not.toBeNull()
      expect(intercept('git merge feature')).not.toBeNull()
      expect(intercept('git reset HEAD')).not.toBeNull()
    })

    test('blocks package installs', () => {
      expect(intercept('npm install express')).not.toBeNull()
      expect(intercept('bun add zod')).not.toBeNull()
      expect(intercept('pip install requests')).not.toBeNull()
    })

    test('blocks sudo', () => {
      expect(intercept('sudo ls')).not.toBeNull()
    })
  })
})
