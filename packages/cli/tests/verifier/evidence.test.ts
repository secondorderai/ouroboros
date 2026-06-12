/**
 * Tests for verifier evidence-ledger summarization.
 */
import { describe, test, expect } from 'bun:test'
import { summarizeEvidence, EVIDENCE_SUMMARY_MAX_LENGTH } from '@src/verifier/evidence'

describe('summarizeEvidence', () => {
  test('strips line-number prefixes from file-read content', () => {
    const summary = summarizeEvidence('file-read', {
      content: '1\thello verifier',
      lines: 1,
      path: '/tmp/note.txt',
    })

    expect(summary).toContain('hello verifier')
    expect(summary).not.toContain('1\\thello verifier')
    expect(summary).toBe('{"content":"hello verifier","lines":1,"path":"/tmp/note.txt"}')
  })

  test('strips the prefix on every line of multi-line file-read content', () => {
    const summary = summarizeEvidence('file-read', {
      content: '1\tfirst line\n2\tsecond line\n10\ttenth line',
      lines: 3,
      path: '/tmp/multi.txt',
    })

    expect(summary).toContain('"first line\\nsecond line\\ntenth line"')
    expect(summary).not.toContain('\\t')
  })

  test('preserves file content that itself starts with digits', () => {
    // Only the "N\t" presentation prefix is stripped; real content survives.
    const summary = summarizeEvidence('file-read', {
      content: '1\t42 is the answer',
      lines: 1,
      path: '/tmp/n.txt',
    })

    expect(summary).toContain('42 is the answer')
  })

  test('leaves file-read error strings untouched', () => {
    const summary = summarizeEvidence('file-read', 'File not found: /tmp/missing.txt')

    expect(summary).toBe('File not found: /tmp/missing.txt')
  })

  test('does not rewrite results from other tools', () => {
    const summary = summarizeEvidence('bash', { content: '1\traw output', exitCode: 0 })

    expect(summary).toContain('1\\traw output')
  })

  test('serializes plain strings and collapses whitespace', () => {
    const summary = summarizeEvidence('bash', '  12 pass\n 0 fail  ')

    expect(summary).toBe('12 pass 0 fail')
  })

  test('truncates to the max length with an ellipsis', () => {
    const summary = summarizeEvidence('bash', 'x'.repeat(1000))

    expect(summary.length).toBe(EVIDENCE_SUMMARY_MAX_LENGTH)
    expect(summary.endsWith('…')).toBe(true)
  })

  test('falls back to String() for unserializable values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(summarizeEvidence('bash', cyclic)).toBe('[object Object]')
  })
})
