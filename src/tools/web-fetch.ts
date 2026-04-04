import { z } from 'zod'
import { type Result, ok, err } from '@src/types'
import type { TypedToolExecute } from './types'

export const name = 'web-fetch'

export const description =
  'Fetch the content of a URL. Optionally converts HTML to a simplified markdown ' +
  'representation for easier consumption by the LLM.'

export const schema = z.object({
  url: z.string().url().describe('The URL to fetch'),
  extractMarkdown: z
    .boolean()
    .optional()
    .default(true)
    .describe('Convert HTML to simplified markdown (default true)'),
})

export interface WebFetchResult {
  content: string
  url: string
  contentType: string | null
}

/**
 * Very lightweight HTML-to-markdown converter.
 *
 * For a production system you would use a library like `turndown` or
 * `@mozilla/readability`. This covers the common cases without adding
 * a dependency.
 */
function htmlToMarkdown(html: string): string {
  let text = html

  // Remove script and style blocks.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '')

  // Headings.
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')

  // Links.
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  // Bold / italic.
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')

  // Line breaks and paragraphs.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<p[^>]*>/gi, '')

  // List items.
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')

  // Remove remaining tags.
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities.
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // Collapse excessive whitespace.
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}

export const execute: TypedToolExecute<typeof schema, WebFetchResult> = async (
  args,
): Promise<Result<WebFetchResult>> => {
  const { url, extractMarkdown } = args

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Ouroboros/0.1 (AI Agent)',
        Accept: 'text/html, application/json, text/plain, */*',
      },
    })

    clearTimeout(timeout)

    if (!response.ok) {
      return err(
        new Error(`HTTP ${response.status} ${response.statusText} fetching "${url}"`),
      )
    }

    const contentType = response.headers.get('content-type')
    let content = await response.text()

    if (
      extractMarkdown &&
      contentType?.includes('text/html')
    ) {
      content = htmlToMarkdown(content)
    }

    return ok({ content, url, contentType })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('abort')) {
      return err(new Error(`Request to "${url}" timed out after 30 s`))
    }
    return err(new Error(`Failed to fetch "${url}": ${message}`))
  }
}
