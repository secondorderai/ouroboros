import { describe, test, expect } from 'bun:test'
import { hardenHtml, buildCspContent, DEFAULT_CDN_ALLOWLIST } from '@src/artifacts/csp'

describe('hardenHtml', () => {
  test('injects CSP meta as first child of <head>', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const cspIdx = result.value.html.indexOf('Content-Security-Policy')
    const titleIdx = result.value.html.indexOf('<title>')
    expect(cspIdx).toBeGreaterThan(0)
    expect(cspIdx).toBeLessThan(titleIdx)
    expect(result.value.warnings).toEqual([])
  })

  test('wraps headless documents', () => {
    const html = '<!DOCTYPE html><html><body>hi</body></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.html).toContain('<head>')
    expect(result.value.html).toContain('Content-Security-Policy')
  })

  test('wraps fragment-only documents with full skeleton', () => {
    const html = '<p>just a fragment</p>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.html).toMatch(/^<!DOCTYPE html><html><head>/)
    expect(result.value.html).toContain('<p>just a fragment</p>')
  })

  test('rejects <base> tag', () => {
    const html = '<html><head><base href="http://evil.example"></head><body></body></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(false)
  })

  test('rejects refresh meta', () => {
    const html = '<html><head><meta http-equiv="refresh" content="0; url=http://x"></head></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(false)
  })

  test('rejects pre-existing CSP meta', () => {
    const html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(false)
  })

  test('warns on script src outside the allowlist', () => {
    const html =
      '<html><head><script src="https://evil.example/x.js"></script></head><body></body></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.some((w) => w.includes('https://evil.example'))).toBe(true)
  })

  test('does not warn on allowlisted CDN script', () => {
    const html =
      '<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head><body></body></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings).toEqual([])
  })

  test('warns on dynamic-evaluation script type', () => {
    const html = '<html><head><script type="text/babel">return 1</script></head></html>'
    const result = hardenHtml(html, DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.some((w) => w.includes('text/babel'))).toBe(true)
  })

  test('rejects empty html', () => {
    const result = hardenHtml('', DEFAULT_CDN_ALLOWLIST)
    expect(result.ok).toBe(false)
  })
})

describe('buildCspContent', () => {
  test('includes all allowlisted hosts in script-src and style-src', () => {
    const csp = buildCspContent(DEFAULT_CDN_ALLOWLIST)
    expect(csp).toContain(
      "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    )
    expect(csp).toContain(
      "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    )
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain('unsafe-eval')
  })

  test('handles empty allowlist (no external CDNs)', () => {
    const csp = buildCspContent([])
    expect(csp).toContain("script-src 'unsafe-inline'")
    expect(csp).not.toContain('https://')
  })
})
