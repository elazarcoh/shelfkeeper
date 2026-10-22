import { describe, expect, it } from 'vitest'
import english from './fixtures/nli-isbn-english.json'
import hebrew from './fixtures/nli-isbn-hebrew.json'
import noIsbn from './fixtures/nli-no-isbn-thumbnail.json'
import { extractPage, isAllowedCoverUrl, pageFromText, providerById, sourceLabel } from '.'
import { cleanNliTitle, nliPersonName, nliResults, nliSearchUrl } from './nli'
import type { PageCapture } from './page-capture'

function first(json: unknown): PageCapture {
  const capture = nliResults(json)[0]
  if (capture === undefined) throw new Error('no record')
  return capture
}

// real answers of the search API (2026-10-22), as saved by a look-up: `any,contains,<isbn>` and a title search
describe('National Library of Israel', () => {
  it('reads a Hebrew book found by its ISBN', () => {
    const capture = first(hebrew)
    expect(capture.url).toBe('https://www.nli.org.il/en/books/NNL_ALEPH990026932820205171')
    const page = extractPage(capture)
    expect(page.ok && page.value).toMatchObject({
      provider: 'nli',
      providerId: '990026932820205171',
      title: 'לויתני האפר',
      authors: ['חגית גרוסמן'],
      publisher: 'קשב לשירה',
      // no machine date on this record: the year comes from "תש"ע 2010"
      year: '2010',
      pageCount: 89,
      isbn13: '9789655310320',
      isbn10: null,
      language: 'heb',
      coverUrl: null,
    })
  })

  it('reads an English record with an ISBN-10 and a name in reading order', () => {
    const page = extractPage(first(english))
    expect(page.ok && page.value).toMatchObject({ title: 'Harry Potter and the Chamber of Secrets', authors: ['J. K. Rowling'], publisher: 'Bloomsbury', year: '1998', pageCount: 251, isbn10: '0747538484', isbn13: null })
  })

  it('keeps a record without an ISBN, and its cover thumbnail', () => {
    const page = extractPage(first(noIsbn))
    expect(page.ok && page.value).toMatchObject({ title: 'הארי פוטר ואבן החכמים', authors: ["ג'יי. קיי. רולינג"], publisher: 'משכל', year: '2000', pageCount: 316 })
    const cover = page.ok ? page.value.coverUrl : null
    expect(cover).toBe('https://nli.alma.exlibrisgroup.com/view/delivery/thumbnail/12303779780005171')
    expect(isAllowedCoverUrl(cover ?? '')).toBe(true)
  })

  it('skips what is not a book record, and a broken answer', () => {
    expect(nliResults([{ 'http://purl.org/dc/elements/1.1/recordid': [{ '@value': '990000000000205171' }], 'http://purl.org/dc/elements/1.1/title': [{ '@value': 'A photo' }], 'http://purl.org/dc/elements/1.1/type': [{ '@value': 'photograph' }] }])).toEqual([])
    expect(nliResults({ error: 'nope' })).toEqual([])
    expect(nliResults([{ title: 'no record id' }])).toEqual([])
  })

  it('cleans catalog titles and names', () => {
    expect(cleanNliTitle('לויתני האפר : שירים / חגית גרוסמן.')).toBe('לויתני האפר')
    expect(cleanNliTitle('Dune.')).toBe('Dune')
    expect(nliPersonName('רולינג, ג\'יי. קיי., 1965-$$Qרולינג, ג\'יי. קיי., 1965-')).toBe("ג'יי. קיי. רולינג")
    expect(nliPersonName('Herbert, Frank, 1920-1986')).toBe('Frank Herbert')
    expect(nliPersonName('J. K. Rowling$$QRowling, J. K')).toBe('J. K. Rowling')
  })

  it('takes a pasted catalog link, and refuses a page for another record', () => {
    const found = pageFromText('look: https://www.nli.org.il/he/books/NNL_ALEPH990026932820205171/')
    expect(found?.provider.id).toBe('nli')
    expect(found?.id).toBe('990026932820205171')
    const capture = first(hebrew)
    const moved = { ...capture, url: 'https://www.nli.org.il/en/books/NNL_ALEPH990019857740205171' }
    expect(extractPage(moved)).toEqual({ ok: false, error: 'stale' })
    expect(providerById('nli').fetch.capture(JSON.stringify(hebrew), capture.url)?.url).toBe(capture.url)
    expect(providerById('nli').fetch.capture(JSON.stringify(hebrew), moved.url)).toBeNull()
  })

  it('builds the search address without a key, and names itself', () => {
    expect(nliSearchUrl('any,contains,9789655310320')).toBe('https://api.nli.org.il/openlibrary/search?query=any%2Ccontains%2C9789655310320&output_format=json')
    expect(sourceLabel('nli')).toBe('National Library')
  })
})
