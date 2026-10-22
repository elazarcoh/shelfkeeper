import { describe, expect, it } from 'vitest'
import { htmlToText } from './html'

describe('htmlToText', () => {
  it('turns paragraphs and breaks into lines, drops tags and decodes entities', () => {
    expect(htmlToText('<p>One &amp; <b>two</b></p><p>Three<br/>four&nbsp;&#8212; five &quot;x&quot; &#x27;y&#x27;</p>')).toBe('One & two\n\nThree\nfour — five "x" \'y\'')
  })
  it('leaves plain text (including a lone "<") alone and maps blank to null', () => {
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d')
    expect(htmlToText('  <p> </p> ')).toBeNull()
    expect(htmlToText(null)).toBeNull()
  })
  it('drops script and style contents', () => {
    expect(htmlToText('<style>p{}</style><script>alert(1)</script>Hi')).toBe('Hi')
  })
  it('handles invalid Unicode code points gracefully', () => {
    expect(htmlToText('Out of range: &#99999999;')).toBe('Out of range: &#99999999;')
    expect(htmlToText('Surrogate: &#xD800;')).toBe('Surrogate: &#xD800;')
    expect(htmlToText('Valid: &#x1F600; emoji')).toBe('Valid: 😀 emoji')
  })
})
