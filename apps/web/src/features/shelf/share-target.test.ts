import { describe, expect, it } from 'vitest'
import { sharedFromSearch } from './share-target'

const q = (params: Record<string, string>) => '?' + new URLSearchParams(params).toString()
const ANSWER = 'My Library shelf answer, format 1\n```json\n[{"title":"Dune","authors":["Frank Herbert"]}]\n```'

describe('sharedFromSearch', () => {
  it('is null with nothing shared', () => {
    expect(sharedFromSearch('')).toBeNull()
    expect(sharedFromSearch(q({ text: '  ' }))).toBeNull()
    expect(sharedFromSearch(q({ batch: 'x' }))).toBeNull()
  })
  it("reads the AI's answer, with or without the format line", () => {
    expect(sharedFromSearch(q({ text: ANSWER }))).toEqual({ kind: 'answer', text: ANSWER })
    expect(sharedFromSearch(q({ title: 'Claude', text: '[{"title":"Dune"}]' }))).toEqual({ kind: 'answer', text: '[{"title":"Dune"}]' })
  })
  it('opens a book page link, wherever the share sheet put it', () => {
    const url = 'https://simania.co.il/bookdetails.php?item_id=12345'
    expect(sharedFromSearch(q({ url }))).toEqual({ kind: 'link', text: url })
    expect(sharedFromSearch(q({ title: 'Dune', text: `Dune ${url}` }))).toEqual({ kind: 'link', text: `Dune ${url}` })
  })
  it('an answer that mentions a link is still an answer', () => {
    const text = '[{"title":"Dune","notes":"see https://openlibrary.org/works/OL893415W"}]'
    expect(sharedFromSearch(q({ text }))).toEqual({ kind: 'answer', text })
  })
  it('anything else goes to the answer box, so reading it explains the problem', () => {
    expect(sharedFromSearch(q({ title: 'Hi', text: 'https://example.com/a-book' }))).toEqual({ kind: 'answer', text: 'https://example.com/a-book' })
  })
})
