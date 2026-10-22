import { describe, expect, it } from 'vitest'
import type { ExtractedPage } from './providers'
import { editionFromWish, mergeWishes, WishFields, WishPage, wishPageFromExtracted } from './wishlist'

const page = (over: Partial<ExtractedPage> = {}): ExtractedPage => ({
  provider: 'simania',
  providerId: '690482',
  url: 'https://simania.co.il/bookdetails.php?item_id=690482',
  title: 'המושבה האבודה',
  subtitle: null,
  authors: ['אואן קולפר'],
  translators: ['יעל אכמון'],
  publisher: 'כנרת',
  year: '2012',
  publishedOn: null,
  pageCount: 312,
  isbn13: '9789655170009',
  isbn10: null,
  series: { name: 'ארטמיס פאול', position: 5 },
  language: 'he',
  coverUrl: 'https://cdn.simania.co.il/bookimages/covers69/690482.jpg',
  description: null,
  volume: null,
  importedTitle: null,
  ...over,
})

describe('wishPageFromExtracted', () => {
  it('keeps the edition facts and the page address', () => {
    expect(wishPageFromExtracted(page())).toEqual({
      provider: 'simania',
      url: 'https://simania.co.il/bookdetails.php?item_id=690482',
      publisher: 'כנרת',
      translators: ['יעל אכמון'],
      year: '2012',
      isbn13: '9789655170009',
      isbn10: null,
      pageCount: 312,
      language: 'he',
      coverUrl: 'https://cdn.simania.co.il/bookimages/covers69/690482.jpg',
      volume: null,
      volumeCount: null,
    })
  })
  it('drops a cover that is not on a book site’s image host', () => {
    expect(wishPageFromExtracted(page({ coverUrl: 'https://evil.example/x.jpg' })).coverUrl).toBeNull()
  })
  it('keeps a page that knows almost nothing', () => {
    const bare = wishPageFromExtracted(page({ translators: [], publisher: null, year: null, pageCount: null, isbn13: null, language: null, coverUrl: null }))
    expect(bare).toMatchObject({ translators: [], publisher: null, year: null, isbn13: null, coverUrl: null })
  })
})

describe('editionFromWish', () => {
  const snap: WishPage = wishPageFromExtracted(page())
  it('pre-fills a physical copy from the page', () => {
    expect(editionFromWish(snap, 'physical', '2026-10-13')).toMatchObject({
      format: 'physical',
      ownership: 'owned',
      holdingOn: '2026-10-13',
      publisher: 'כנרת',
      isbn13: '9789655170009',
      pageCount: 312,
      publishedOn: '2012-01-01',
      language: 'he',
      translators: ['יעל אכמון'],
    })
  })
  it('keeps only language and translators for another format: the page describes a print edition', () => {
    const e = editionFromWish(snap, 'audiobook', '2026-10-13')
    expect(e).toMatchObject({ format: 'audiobook', language: 'he', translators: ['יעל אכמון'], isbn13: null, publisher: null, pageCount: null, publishedOn: null })
  })
  it('sets a date only for a four-digit year', () => {
    expect(editionFromWish({ ...snap, year: 'תשע"ב' }, 'physical', '2026-10-13').publishedOn).toBeNull()
  })
  it('makes a bare copy without a page', () => {
    expect(editionFromWish(null, 'ebook', '2026-10-13')).toMatchObject({ format: 'ebook', ownership: 'owned', holdingOn: '2026-10-13', isbn13: null, translators: [] })
  })
  it('keeps a language the catalog accepts, as its code', () => {
    expect(editionFromWish({ ...snap, language: 'Hebrew' }, 'physical', '2026-10-13').language).toBe('he')
  })
  it('drops a language the catalog would reject and keeps the rest', () => {
    expect(editionFromWish({ ...snap, language: 'x'.repeat(40) }, 'physical', '2026-10-13')).toMatchObject({ language: null, publisher: 'כנרת', isbn13: '9789655170009', translators: ['יעל אכמון'] })
  })
  it('keeps only the translators with a valid name', () => {
    expect(editionFromWish({ ...snap, translators: ['', 'יעל אכמון'] }, 'physical', '2026-10-13').translators).toEqual(['יעל אכמון'])
  })
  it('drops an over-long publisher', () => {
    expect(editionFromWish({ ...snap, publisher: 'x'.repeat(400) }, 'physical', '2026-10-13')).toMatchObject({ publisher: null, pageCount: 312 })
  })
  it('drops a bad isbn13 but keeps a valid isbn10', () => {
    expect(editionFromWish({ ...snap, isbn13: '123', isbn10: '0306406152' }, 'physical', '2026-10-13')).toMatchObject({ isbn13: null, isbn10: '0306406152' })
  })
  it('makes the copy without a malformed ISBN', () => {
    const e = editionFromWish({ ...snap, isbn13: '123' }, 'physical', '2026-10-13')
    expect(e).toMatchObject({ format: 'physical', isbn13: null, publisher: 'כנרת', pageCount: 312 })
  })
})

describe('mergeWishes', () => {
  it('unites formats, keeps the target’s language and page, joins notes', () => {
    const snap = wishPageFromExtracted(page())
    expect(
      mergeWishes({ formats: ['physical'], language: 'he', note: 'new translation', page: null }, { formats: ['audiobook', 'physical'], language: 'en', note: 'or audio', page: snap }),
    ).toEqual({ formats: ['physical', 'audiobook'], language: 'he', note: 'new translation · or audio', page: snap })
  })
  it('an empty format list means any format, and any absorbs the rest', () => {
    expect(mergeWishes({ formats: [], language: null, note: null, page: null }, { formats: ['ebook'], language: null, note: null, page: null }).formats).toEqual([])
  })
})

describe('WishFields', () => {
  it('dedupes formats, trims the note and turns blanks into null', () => {
    expect(WishFields.parse({ formats: ['ebook', 'ebook'], language: ' ', note: '  ' })).toEqual({ formats: ['ebook'], language: null, note: null })
  })
  it('rejects a note over 500 characters', () => {
    expect(WishFields.safeParse({ formats: [], language: null, note: 'x'.repeat(501) }).success).toBe(false)
  })
})

describe('wish page volumes', () => {
  it('a wish page keeps the volume; a stored page without one still parses', () => {
    expect(wishPageFromExtracted(page({ volume: { number: 2, count: 2 } }))).toMatchObject({ volume: 2, volumeCount: 2 })
    const old: Partial<WishPage> = wishPageFromExtracted(page())
    delete old.volume
    delete old.volumeCount
    expect(WishPage.parse(old)).toMatchObject({ volume: null, volumeCount: null })
  })
})
