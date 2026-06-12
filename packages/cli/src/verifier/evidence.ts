/**
 * Verifier Model — evidence-ledger summarization.
 *
 * `summarizeEvidence()` turns one raw tool result into the compact one-line
 * summary recorded in the per-run evidence ledger and later rendered into the
 * verifier prompt. Presentation-only formatting is stripped first so the
 * verifier judges against actual content: `file-read` returns line-number
 * prefixed text ("N\t<line>"), and leaving the prefixes in caused exact-content
 * criteria to fail against evidence that didn't literally match the file.
 */

/** Default max length of one ledger summary, matching the agent's ledger cap. */
export const EVIDENCE_SUMMARY_MAX_LENGTH = 400

/** Remove "N\t" line-number prefixes from line-numbered tool output. */
function stripLineNumberPrefixes(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^\d+\t/, ''))
    .join('\n')
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/**
 * Summarize one tool result for the verifier evidence ledger. For successful
 * `file-read` results the line-number prefixes are stripped from `content`
 * before serialization; everything else is summarized as-is.
 */
export function summarizeEvidence(
  toolName: string,
  result: unknown,
  maxLength = EVIDENCE_SUMMARY_MAX_LENGTH,
): string {
  let value = result
  if (
    toolName === 'file-read' &&
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    typeof (result as { content: unknown }).content === 'string'
  ) {
    value = {
      ...(result as Record<string, unknown>),
      content: stripLineNumberPrefixes((result as { content: string }).content),
    }
  }
  return summarizeText(serializeUnknown(value), maxLength)
}
