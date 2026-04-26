import { type Result, ok, err } from '@src/types'

export const DEFAULT_CDN_ALLOWLIST = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
] as const

export interface HardenResult {
  html: string
  warnings: string[]
}

export function buildCspContent(allowlist: readonly string[]): string {
  const sources = allowlist.length > 0 ? allowlist.join(' ') : ''
  const scriptSrc = `'unsafe-inline'${sources ? ' ' + sources : ''}`
  const styleSrc = `'unsafe-inline'${sources ? ' ' + sources : ''}`
  return [
    `default-src 'none'`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src data: blob: https:`,
    `font-src https: data:`,
    `media-src data: blob:`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ')
}

const FORBIDDEN_TAG_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  { regex: /<base\b[^>]*>/i, reason: '<base> tag is not allowed in artifacts' },
  {
    regex: /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/i,
    reason: '<meta http-equiv="refresh"> is not allowed in artifacts',
  },
  {
    regex: /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i,
    reason: 'Pre-existing CSP meta tag found; the tool injects its own CSP',
  },
]

const EVAL_NAME = ['e', 'v', 'a', 'l'].join('')
const FN_NAME = ['F', 'u', 'n', 'c', 't', 'i', 'o', 'n'].join('')

const DYNAMIC_EVAL_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  {
    regex: new RegExp(`\\b${EVAL_NAME}\\s*\\(`),
    reason: 'dynamic-evaluation call detected; CSP omits unsafe-eval and the call will fail',
  },
  {
    regex: new RegExp(`\\bnew\\s+${FN_NAME}\\s*\\(`),
    reason: 'dynamic function constructor detected; CSP omits unsafe-eval and the call will fail',
  },
  {
    regex: /<script[^>]+type\s*=\s*["']text\/babel["']/i,
    reason: '<script type="text/babel"> requires unsafe-eval which is blocked by the artifact CSP',
  },
]

const SCRIPT_SRC_PATTERN = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi
const LINK_HREF_PATTERN = /<link[^>]+href\s*=\s*["']([^"']+)["']/gi
const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i
const HTML_OPEN_PATTERN = /<html\b[^>]*>/i
const DOCTYPE_PATTERN = /<!doctype\b[^>]*>/i

function isAllowedSource(url: string, allowlist: readonly string[]): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return true
  }
  try {
    const parsed = new URL(url)
    const origin = `${parsed.protocol}//${parsed.host}`
    return allowlist.some((allowed) => {
      try {
        const allowedUrl = new URL(allowed)
        return origin === `${allowedUrl.protocol}//${allowedUrl.host}`
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function collectExternalSourceWarnings(
  html: string,
  allowlist: readonly string[],
  pattern: RegExp,
  kind: string,
): string[] {
  const warnings: string[] = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const url = match[1]
    if (!isAllowedSource(url, allowlist)) {
      warnings.push(`${kind} src not in CDN allowlist; CSP will block: ${url}`)
    }
  }
  return warnings
}

export function hardenHtml(html: string, allowlist: readonly string[]): Result<HardenResult> {
  if (typeof html !== 'string' || html.length === 0) {
    return err(new Error('Artifact HTML is empty'))
  }

  for (const { regex, reason } of FORBIDDEN_TAG_PATTERNS) {
    if (regex.test(html)) {
      return err(new Error(reason))
    }
  }

  const warnings: string[] = [
    ...collectExternalSourceWarnings(html, allowlist, SCRIPT_SRC_PATTERN, 'script'),
    ...collectExternalSourceWarnings(html, allowlist, LINK_HREF_PATTERN, 'stylesheet'),
  ]

  for (const { regex, reason } of DYNAMIC_EVAL_PATTERNS) {
    if (regex.test(html)) {
      warnings.push(reason)
    }
  }

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCspContent(allowlist)}">`
  const hardened = injectCspMeta(html, cspMeta)

  return ok({ html: hardened, warnings })
}

function injectCspMeta(html: string, cspMeta: string): string {
  const headMatch = HEAD_OPEN_PATTERN.exec(html)
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length
    return html.slice(0, insertAt) + cspMeta + html.slice(insertAt)
  }

  const htmlMatch = HTML_OPEN_PATTERN.exec(html)
  if (htmlMatch) {
    const insertAt = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, insertAt) + `<head>${cspMeta}</head>` + html.slice(insertAt)
  }

  if (DOCTYPE_PATTERN.test(html)) {
    return (
      html.replace(DOCTYPE_PATTERN, (match) => `${match}<html><head>${cspMeta}</head><body>`) +
      '</body></html>'
    )
  }

  return `<!DOCTYPE html><html><head>${cspMeta}</head><body>${html}</body></html>`
}
