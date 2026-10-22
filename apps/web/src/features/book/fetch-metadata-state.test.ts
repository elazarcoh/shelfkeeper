import { describe, expect, it } from 'vitest'
import type { ExtractedPage } from '@mylib/domain'
import type { RouterOutputs } from '@/lib/trpc'
import { copyForPage, defaultEditionId, FIELD_ORDER, groupRows, hardcoverLinkLine, keepLabel, mergedSeries, metadataRows, patchesFor, type MetaField } from './fetch-metadata-state'

type WorkDetail = RouterOutputs['catalog']['get']
type EditionDetail = WorkDetail['editions'][number]

const edition = (over: Partial<EditionDetail> = {}): EditionDetail =>
  ({
    id: 'e1',
    format: 'physical',
    title: null,
    isbn13: null,
    isbn10: null,
    asin: null,
    publisher: null,
    publishedOn: null,
    pageCount: null,
    wordCount: null,
    durationSec: null,
    language: null,
    shelfLocation: null,
    volume: null,
    volumeCount: null,
    coverAssetId: null,
    narrators: [],
    translators: [],
    ...over,
  }) as EditionDetail

const work = (over: Partial<WorkDetail> = {}): WorkDetail =>
  ({
    id: 'w1',
    title: 'ארטמיס פאול - המושבה האבודה', primaryTitle: 'ארטמיס פאול - המושבה האבודה',
    subtitle: null,
    description: null,
    language: null,
    originalYear: null,
    authors: [{ id: 'a', name: 'אואן קולפר', creditedName: 'אואן קולפר' }],
    series: [],
    tags: [],
    editions: [edition()],
    coverAssetId: null,
    ...over,
  }) as WorkDetail

const page: ExtractedPage = {
  provider: 'simania',
  providerId: '690482',
  url: 'https://simania.co.il/bookdetails.php?item_id=690482',
  title: 'המושבה האבודה',
  subtitle: null,
  authors: ['אואן קולפר'],
  translators: ['עפרה אביגד'],
  publisher: 'כנרת',
  year: '2007',
  publishedOn: null,
  pageCount: 352,
  isbn13: '9789655173419',
  isbn10: null,
  series: { name: 'ארטמיס פאול', position: 5 },
  language: 'he',
  coverUrl: 'https://cdn.simania.co.il/bookimages/covers69/690482.jpg',
  description: 'ארטמיס חוזר',
  volume: null,
  importedTitle: null,
}

const byField = (rows: ReturnType<typeof metadataRows>) => Object.fromEntries(rows.map((r) => [r.field, r]))

describe('metadataRows', () => {
  it('lists only what the page changes, ticking only what the book does not have yet', () => {
    const rows = metadataRows(work(), edition({ publisher: 'Kinneret' }), page)
    expect(rows.map((r) => [r.field, r.on, r.checked])).toEqual([
      ['title', 'work', false],
      ['series', 'work', true],
      ['description', 'work', true],
      ['cover', 'edition', true],
      ['pageCount', 'edition', true],
      ['publisher', 'edition', false],
      ['isbn13', 'edition', true],
      ['language', 'edition', true],
      ['translators', 'edition', true],
    ])
    // the same authors (spelled the same) are not a change
    expect(byField(rows)['authors']).toBeUndefined()
    expect(byField(rows)['series']).toMatchObject({ current: '', next: 'ארטמיס פאול #5' })
  })

  it('leaves out the edition fields when the book has no copy, and the page count for an audiobook', () => {
    expect(metadataRows(work({ editions: [] }), null, page).every((r) => r.on === 'work')).toBe(true)
    const audio = metadataRows(work(), edition({ format: 'audiobook' }), page)
    expect(audio.some((r) => r.field === 'pageCount')).toBe(false)
  })

  it('offers a cover only from a book site, unticked when the copy has one', () => {
    expect(byField(metadataRows(work(), edition({ coverAssetId: 'c' }), page))['cover']).toMatchObject({ checked: false, current: 'This copy has a cover' })
    expect(byField(metadataRows(work(), edition(), { ...page, coverUrl: 'https://evil.example/x.jpg' }))['cover']).toBeUndefined()
  })

  it('treats differences in case, spacing and punctuation as the same value', () => {
    const rows = metadataRows(work({ primaryTitle: 'המושבה  האבודה!' }), edition({ publisher: 'כנרת' }), page)
    expect(byField(rows)['title']).toBeUndefined()
    expect(byField(rows)['publisher']).toBeUndefined()
  })

  it('looking up one copy offers only that copy’s fields, and its volume when it has none yet', () => {
    const rows = metadataRows(work(), edition({ publisher: 'Kinneret' }), { ...page, volume: { number: 2, count: 3 } }, 'edition')
    expect(rows.map((r) => [r.field, r.on, r.checked])).toEqual([
      ['cover', 'edition', true],
      ['pageCount', 'edition', true],
      ['publisher', 'edition', false],
      ['isbn13', 'edition', true],
      ['language', 'edition', true],
      ['translators', 'edition', true],
      ['volume', 'edition', true],
    ])
    expect(byField(rows)['volume']).toMatchObject({ current: '', next: '2' })
    // a copy already numbered keeps its number: moving it between volumes is the edit dialog's job
    expect(byField(metadataRows(work(), edition({ volume: 1, volumeCount: 2 }), { ...page, volume: { number: 2, count: 3 } }, 'edition'))['volume']).toBeUndefined()
    // the whole book's lookup never offers a volume
    expect(byField(metadataRows(work(), edition(), { ...page, volume: { number: 2, count: 3 } }))['volume']).toBeUndefined()
  })
})

describe('mergedSeries', () => {
  it('adds a new series after the others, and numbers an existing one from the page', () => {
    expect(mergedSeries([{ name: 'Other', position: 2, positionEnd: null }], { name: 'ארטמיס פאול', position: 5 })).toEqual([
      { name: 'Other', position: 2, positionEnd: null },
      { name: 'ארטמיס פאול', position: 5, positionEnd: null },
    ])
    expect(mergedSeries([{ name: 'ארטמיס פאול', position: null, positionEnd: null }], { name: 'ארטמיס  פאול', position: 5 })).toEqual([
      { name: 'ארטמיס פאול', position: 5, positionEnd: null },
    ])
    expect(mergedSeries([{ name: 'ארטמיס פאול', position: 4, positionEnd: null }], { name: 'ארטמיס פאול', position: null })).toEqual([
      { name: 'ארטמיס פאול', position: 4, positionEnd: null },
    ])
    expect(mergedSeries([], null)).toBeNull()
  })
  it('a new start clears a range end; no number keeps both (#122)', () => {
    const current = [{ name: 'Mage Errant', position: 1, positionEnd: 2 }]
    expect(mergedSeries(current, { name: 'Mage Errant', position: 4 })).toEqual([{ name: 'Mage Errant', position: 4, positionEnd: null }])
    expect(mergedSeries(current, { name: 'Mage Errant', position: 1 })).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(mergedSeries(current, { name: 'Mage Errant', position: null })).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(mergedSeries(current, { name: 'Cosmere', position: 2 })).toEqual([...current, { name: 'Cosmere', position: 2, positionEnd: null }])
  })
})

describe('patchesFor', () => {
  it('saves only the ticked rows, each on the book or the copy it belongs to', () => {
    const w = work({ series: [{ id: 's', name: 'Other', position: 1, positionEnd: null }] })
    const rows = metadataRows(w, edition(), page)
    const ticked = new Set<MetaField>(['title', 'series', 'translators', 'cover'])
    expect(patchesFor(w, page, rows, ticked)).toEqual({
      work: { title: 'המושבה האבודה', series: [{ name: 'Other', position: 1, positionEnd: null }, { name: 'ארטמיס פאול', position: 5, positionEnd: null }] },
      edition: { translators: ['עפרה אביגד'] },
      coverUrl: page.coverUrl,
    })
  })

  it('saves nothing for a ticked field that has no row (nothing to change)', () => {
    const rows = metadataRows(work(), edition(), page)
    expect(patchesFor(work(), page, rows, new Set<MetaField>(['authors']))).toEqual({ work: null, edition: null, coverUrl: null })
  })

  it('a copy’s lookup saves the volume, and never a work field even if one is ticked', () => {
    const volumed = { ...page, volume: { number: 2, count: 3 } }
    const rows = metadataRows(work(), edition(), volumed, 'edition')
    expect(patchesFor(work(), volumed, rows, new Set<MetaField>(['title', 'volume', 'publisher']))).toEqual({
      work: null,
      edition: { publisher: 'כנרת', volume: 2 },
      coverUrl: null,
    })
  })
})

describe('defaultEditionId', () => {
  it('picks the first physical copy, else the first copy, else none', () => {
    expect(defaultEditionId({ editions: [edition({ id: 'a', format: 'ebook' }), edition({ id: 'b' })] })).toBe('b')
    expect(defaultEditionId({ editions: [edition({ id: 'a', format: 'ebook' })] })).toBe('a')
    expect(defaultEditionId({ editions: [] })).toBeNull()
  })
})

describe('published date', () => {
  it('is a row on the copy, and saved when ticked', () => {
    const p = { ...page, publishedOn: '2013-11-19' }
    const rows = metadataRows(work(), edition(), p)
    expect(rows.find((r) => r.field === 'publishedOn')).toMatchObject({ label: 'Published', on: 'edition', next: '2013-11-19', checked: true })
    expect(patchesFor(work(), p, rows, new Set<MetaField>(['publishedOn'])).edition).toEqual({ publishedOn: '2013-11-19' })
  })
})

describe('row order', () => {
  it('follows FIELD_ORDER', () => {
    const full: ExtractedPage = { ...page, authors: ['Someone Else'], publishedOn: '2013-11-19', isbn10: '0316055433' }
    const fields = metadataRows(work(), edition({ volume: null }), { ...full, volume: { number: 2, count: 3 } }, 'edition').map((r) => r.field)
    expect(fields).toEqual(FIELD_ORDER.filter((f) => fields.includes(f)))
    const book = metadataRows(work(), edition(), full).map((r) => r.field)
    expect(book).toEqual(FIELD_ORDER.filter((f) => book.includes(f)))
    expect(book.slice(0, 4)).toEqual(['title', 'authors', 'series', 'description'])
  })
})

describe('groupRows', () => {
  it('splits rows the book has nothing for from ones it would replace, the latter unticked', () => {
    const rows = metadataRows(work(), edition({ publisher: 'Kinneret' }), page)
    const { fresh, replace } = groupRows(rows)
    expect(fresh.every((r) => r.current.trim() === '')).toBe(true)
    expect(replace.map((r) => r.field)).toEqual(['title', 'publisher'])
    expect(replace.every((r) => !r.checked)).toBe(true)
    expect(fresh.length + replace.length).toBe(rows.length)
  })
})

describe('copyForPage', () => {
  const physical = edition({ id: 'p', isbn13: '9780000000002' })
  const ebook = edition({ id: 'e', format: 'ebook', isbn13: '9789655173419', isbn10: '0316055433' })
  const w = work({ editions: [physical, ebook] })
  it('picks the copy with the page’s ISBN, else the default copy', () => {
    expect(copyForPage(w, { ...page, isbn13: ebook.isbn13 })).toBe('e')
    expect(copyForPage(w, { ...page, isbn13: null, isbn10: '0316055433' })).toBe('e')
    expect(copyForPage(w, { ...page, isbn13: null, isbn10: null })).toBe(defaultEditionId(w))
    expect(copyForPage(w, { ...page, isbn13: '9781111111117' })).toBe(defaultEditionId(w))
  })
})

describe('keepLabel', () => {
  it('counts ticked rows; with none, Hardcover can still just link', () => {
    expect(keepLabel('hardcover', 0)).toEqual({ text: 'Only link', disabled: false })
    expect(keepLabel('openlibrary', 0)).toEqual({ text: 'Keep', disabled: true })
    expect(keepLabel('simania', 3).text).toBe('Keep 3')
    expect(keepLabel('hardcover', 2)).toEqual({ text: 'Keep 2', disabled: false })
  })
})

describe('hardcoverLinkLine', () => {
  it('says whether fetching will link, change or keep the Hardcover link', () => {
    expect(hardcoverLinkLine(null, '474572')).toBe('Will link this book to Hardcover')
    expect(hardcoverLinkLine({ hardcoverId: 1 }, '474572')).toBe("Will change this book's Hardcover link")
    expect(hardcoverLinkLine({ hardcoverId: 474572 }, '474572')).toBe('Linked to this Hardcover book')
  })
})
