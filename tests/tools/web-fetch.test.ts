import { describe, test, expect } from 'bun:test'
import { htmlToMarkdown } from '@src/tools/web-fetch'

describe('htmlToMarkdown', () => {
  // -----------------------------------------------------------------------
  // Headings
  // -----------------------------------------------------------------------
  test('converts h1 through h6 to markdown headings', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toContain('# Title')
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub')
    expect(htmlToMarkdown('<h3>Sub3</h3>')).toContain('### Sub3')
    expect(htmlToMarkdown('<h4>Sub4</h4>')).toContain('#### Sub4')
    expect(htmlToMarkdown('<h5>Sub5</h5>')).toContain('##### Sub5')
    expect(htmlToMarkdown('<h6>Sub6</h6>')).toContain('###### Sub6')
  })

  test('handles headings with attributes', () => {
    expect(htmlToMarkdown('<h1 class="title" id="main">Hello</h1>')).toContain('# Hello')
  })

  // -----------------------------------------------------------------------
  // Links
  // -----------------------------------------------------------------------
  test('converts links to markdown format', () => {
    const result = htmlToMarkdown('<a href="https://example.com">Example</a>')
    expect(result).toContain('[Example](https://example.com)')
  })

  // -----------------------------------------------------------------------
  // Bold / Italic
  // -----------------------------------------------------------------------
  test('converts strong/b to bold markdown', () => {
    expect(htmlToMarkdown('<strong>bold</strong>')).toContain('**bold**')
    expect(htmlToMarkdown('<b>bold</b>')).toContain('**bold**')
  })

  test('converts em/i to italic markdown', () => {
    expect(htmlToMarkdown('<em>italic</em>')).toContain('*italic*')
    expect(htmlToMarkdown('<i>italic</i>')).toContain('*italic*')
  })

  // -----------------------------------------------------------------------
  // Script / Style removal
  // -----------------------------------------------------------------------
  test('removes script tags and their contents', () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>'
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('alert')
    expect(result).not.toContain('script')
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })

  test('removes style tags and their contents', () => {
    const html = '<style>.foo { color: red; }</style><p>Content</p>'
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('color')
    expect(result).toContain('Content')
  })

  test('removes nav tags and their contents', () => {
    const html = '<nav><a href="/">Home</a></nav><p>Main content</p>'
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('Home')
    expect(result).toContain('Main content')
  })

  // -----------------------------------------------------------------------
  // HTML entity decoding
  // -----------------------------------------------------------------------
  test('decodes common HTML entities', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('&')
    expect(result).toContain('<')
    expect(result).toContain('>')
    expect(result).toContain('"')
    expect(result).toContain("'")
  })

  // -----------------------------------------------------------------------
  // Nested tags
  // -----------------------------------------------------------------------
  test('handles nested tags like bold inside a heading', () => {
    const html = '<h2><strong>Bold Heading</strong></h2>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('## **Bold Heading**')
  })

  test('handles link inside a paragraph with bold text', () => {
    const html = '<p>Click <a href="/go"><strong>here</strong></a> now</p>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('[**here**](/go)')
  })

  // -----------------------------------------------------------------------
  // Paragraphs and line breaks
  // -----------------------------------------------------------------------
  test('converts br tags to newlines', () => {
    const result = htmlToMarkdown('line1<br>line2<br/>line3')
    expect(result).toContain('line1\nline2\nline3')
  })

  test('converts closing p tags to double newlines', () => {
    const result = htmlToMarkdown('<p>First</p><p>Second</p>')
    expect(result).toContain('First')
    expect(result).toContain('Second')
  })

  // -----------------------------------------------------------------------
  // List items
  // -----------------------------------------------------------------------
  test('converts li to markdown list items', () => {
    const html = '<ul><li>One</li><li>Two</li></ul>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('- One')
    expect(result).toContain('- Two')
  })

  // -----------------------------------------------------------------------
  // Remaining tags stripped
  // -----------------------------------------------------------------------
  test('strips unknown/remaining HTML tags', () => {
    const html = '<div><span>text</span></div>'
    const result = htmlToMarkdown(html)
    expect(result).toBe('text')
  })

  // -----------------------------------------------------------------------
  // Whitespace collapsing
  // -----------------------------------------------------------------------
  test('collapses excessive newlines', () => {
    const html = '<p>A</p>\n\n\n\n<p>B</p>'
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('\n\n\n')
  })

  test('trims leading and trailing whitespace', () => {
    const result = htmlToMarkdown('  <p>Hello</p>  ')
    expect(result).toBe(result.trim())
  })
})
