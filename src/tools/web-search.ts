import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'web-search'

export const description =
  'Search the web and return structured results (title, URL, snippet). ' +
  'Uses DuckDuckGo HTML scraping by default.'

export const schema = z.object({
  query: z.string().describe('The search query'),
  numResults: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5)
    .describe('Number of results to return (default 5)'),
})

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  query: string
  results: SearchResult[]
}

/**
 * Parse DuckDuckGo HTML search results.
 *
 * This is intentionally simple. DuckDuckGo's HTML lite page returns results
 * in a predictable structure that we can parse with regex. For a production
 * system you would use a proper search API.
 */
function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []

  // DuckDuckGo HTML lite wraps each result in a <a class="result-link"> or
  // uses a table-based layout. We try to extract links + snippets.
  const resultBlocks = html.split(/class="result(?:__| )/).slice(1)

  for (const block of resultBlocks) {
    if (results.length >= limit) break

    // Extract URL from href.
    const urlMatch = block.match(/href="([^"]+)"/)
    // Extract title from the link text.
    const titleMatch = block.match(/href="[^"]*"[^>]*>([\s\S]*?)<\/a>/)
    // Extract snippet.
    const snippetMatch = block.match(
      /class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/,
    )

    if (urlMatch) {
      const url = urlMatch[1]
        .replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '')
        .replace(/&rut=.*$/, '')

      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : url

      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

      // Skip DDG internal links.
      if (!url.startsWith('/') && url.startsWith('http')) {
        results.push({
          title,
          url: decodeURIComponent(url),
          snippet,
        })
      }
    }
  }

  return results
}

export const execute: TypedToolExecute<typeof schema, WebSearchResult> = async (
  args,
): Promise<Result<WebSearchResult>> => {
  const { query, numResults } = args

  try {
    const encodedQuery = encodeURIComponent(query)
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ouroboros/0.1; +https://github.com/ouroboros)',
        Accept: 'text/html',
      },
    })

    clearTimeout(timeout)

    if (!response.ok) {
      return err(new Error(`Search request failed: HTTP ${response.status} ${response.statusText}`))
    }

    const html = await response.text()
    const results = parseDuckDuckGoResults(html, numResults)

    return ok({ query, results })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('abort')) {
      return err(new Error(`Search request timed out after 15 s`))
    }
    return err(new Error(`Web search failed: ${message}`))
  }
}
