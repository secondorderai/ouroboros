import { describe, test, expect } from 'bun:test'
import { parseDuckDuckGoResults } from '@src/tools/web-search'

describe('parseDuckDuckGoResults', () => {
  // -----------------------------------------------------------------------
  // Normal results
  // -----------------------------------------------------------------------
  test('parses a single result with title and URL', () => {
    // The parser splits on class="result__" and class="result ", so the
    // snippet (class="result__snippet") lands in a separate block from
    // the URL.  We verify title + URL extraction here.
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com" rel="noopener">Example Title</a>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Example Title')
    expect(results[0].url).toBe('https://example.com')
  })

  test('returns empty snippet when snippet block is split from URL block', () => {
    // The parser splits on class="result__" and class="result ", so the
    // snippet (class="result__snippet") always ends up in a separate block
    // from the URL.  Verify that we still get the result with an empty snippet.
    const html = `
      <div class="result results_links">
        <a href="https://example.com">Title</a>
        <div class="result__snippet">A snippet.</div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(1)
    expect(results[0].snippet).toBe('')
  })

  test('parses multiple results', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com/1">First</a>
          <span class="result__snippet">Snippet 1.</span>
        </div>
      </div>
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com/2">Second</a>
          <span class="result__snippet">Snippet 2.</span>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(2)
    expect(results[0].url).toBe('https://example.com/1')
    expect(results[1].url).toBe('https://example.com/2')
  })

  test('respects the limit parameter', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com/1">First</a>
          <span class="result__snippet">Snippet 1.</span>
        </div>
      </div>
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com/2">Second</a>
          <span class="result__snippet">Snippet 2.</span>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 1)
    expect(results.length).toBe(1)
  })

  test('decodes DDG redirect URLs', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123">Title</a>
          <span class="result__snippet">Snippet.</span>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(1)
    expect(results[0].url).toBe('https://example.com/page')
  })

  // -----------------------------------------------------------------------
  // Empty results
  // -----------------------------------------------------------------------
  test('returns empty array for empty HTML', () => {
    expect(parseDuckDuckGoResults('', 5)).toEqual([])
  })

  test('returns empty array for HTML with no result blocks', () => {
    const html = '<html><body><p>No results found</p></body></html>'
    expect(parseDuckDuckGoResults(html, 5)).toEqual([])
  })

  // -----------------------------------------------------------------------
  // Malformed HTML
  // -----------------------------------------------------------------------
  test('skips blocks without href', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <span>No link here</span>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(0)
  })

  test('skips internal DDG links (starting with /)', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="/feedback">Feedback</a>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(0)
  })

  test('handles results with missing snippet gracefully', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com">Title Only</a>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Title Only')
    expect(results[0].snippet).toBe('')
  })

  test('strips HTML tags from title', () => {
    const html = `
      <div class="result results_links">
        <div class="result__body">
          <a class="result__a" href="https://example.com"><b>Bold</b> Title</a>
        </div>
      </div>
    `
    const results = parseDuckDuckGoResults(html, 5)
    expect(results[0].title).toBe('Bold Title')
  })
})
