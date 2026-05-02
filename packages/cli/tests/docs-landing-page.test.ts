import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const landingPagePath = join(repoRoot, 'docs', 'index.html')
const noJekyllPath = join(repoRoot, 'docs', '.nojekyll')

describe('GitHub Pages landing page', () => {
  test('is a static single-file page with GitHub Pages Jekyll bypass', () => {
    expect(existsSync(landingPagePath)).toBe(true)
    expect(existsSync(noJekyllPath)).toBe(true)

    const html = readFileSync(landingPagePath, 'utf8')

    expect(html).toContain('<!doctype html>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain(' src=')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })

  test('contains the launch positioning, CTAs, and design-system tokens', () => {
    const html = readFileSync(landingPagePath, 'utf8')

    expect(html).toContain('<h1 id="hero-title">Ouroboros</h1>')
    expect(html).toContain('self-improving, human-controlled local workspace AI agent')
    expect(html).toContain('Download macOS beta')
    expect(html).toContain('https://github.com/secondorderai/ouroboros/releases/latest')
    expect(html).toContain('View on GitHub')
    expect(html).toContain('Self-improvement is the main event.')
    expect(html).toContain('Reflection browser')
    expect(html).toContain('Durable memory')
    expect(html).toContain('Meta Thinking is built in, but optional.')
    expect(html).toContain('not enabled by default')
    expect(html).toContain('SecondOrder skill')
    expect(html).toContain('Choose when extra thinking is worth it')
    expect(html).toContain('Make goals and constraints explicit')
    expect(html).toContain('Catch brittle assumptions earlier')
    expect(html).toContain('confidence, limitations, and context')
    expect(html).toContain('Transparent autonomy, not silent automation.')
    expect(html).toContain('Works inside real repositories.')
    expect(html).toContain('Workspace and Simple mode')
    expect(html).toContain('HTML5 app artifacts')
    expect(html).toContain('Agent Skills')
    expect(html).toContain('Subagents')
    expect(html).toContain('Team workflows')
    expect(html).toContain('One agent core. CLI and desktop surfaces.')
    expect(html).toContain('What Ouroboros can and cannot do.')
    expect(html).toContain('Beta safety notes')
    expect(html).toContain('--accent-primary: #3e5f8a')
    expect(html).toContain('--bg-primary: #f5f6f7')
  })
})
