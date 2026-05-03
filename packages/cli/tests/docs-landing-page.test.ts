import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const landingPagePath = join(repoRoot, 'docs', 'index.html')
const noJekyllPath = join(repoRoot, 'docs', '.nojekyll')
const configPath = join(repoRoot, 'packages', 'cli', 'src', 'config.ts')
const crystallizePath = join(repoRoot, 'packages', 'cli', 'src', 'rsi', 'crystallize.ts')
const promptPath = join(repoRoot, 'packages', 'cli', 'src', 'llm', 'prompt.ts')

describe('GitHub Pages landing page', () => {
  test('is a static single-file page with GitHub Pages Jekyll bypass', () => {
    expect(existsSync(landingPagePath)).toBe(true)
    expect(existsSync(noJekyllPath)).toBe(true)

    const html = readFileSync(landingPagePath, 'utf8')

    expect(html).toContain('<!doctype html>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
    // No external resources: src= attributes may only point to local files.
    expect(html).not.toMatch(/\bsrc=["']https?:\/\//)
    expect(html).not.toMatch(/\bsrc=["']\/\//)
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
    expect(html).toContain('Permissioned growth')
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

  test('grounds self-improvement safety copy in runtime behavior', () => {
    const html = readFileSync(landingPagePath, 'utf8')
    const configSource = readFileSync(configPath, 'utf8')
    const crystallizeSource = readFileSync(crystallizePath, 'utf8')
    const promptSource = readFileSync(promptPath, 'utf8')
    // Collapse whitespace so assertions match rendered text, not source wrapping.
    const renderedText = html.replace(/\s+/g, ' ')

    expect(renderedText).toContain(
      'Code and configuration self-modification is a disabled-by-default approval tier.',
    )
    expect(renderedText).toContain(
      'Generated skills are validated, self-tested, and promoted through an evolution log so automatic improvements stay inspectable.',
    )
    expect(html).not.toContain('promoted with user oversight')

    expect(configSource).toContain(
      "tier3: z.boolean().default(false).describe('Self-modification (requires human approval)')",
    )
    expect(crystallizeSource).toContain('3. Validate')
    expect(crystallizeSource).toContain('4. Test')
    expect(crystallizeSource).toContain('5. Promote')
    expect(promptSource).toContain('do not require user intervention')
  })
})
