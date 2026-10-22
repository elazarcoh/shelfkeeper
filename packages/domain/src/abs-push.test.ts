import { describe, expect, it } from 'vitest'
import { absMetadataPatch, absPushFields, currentAbsRecord, diffAbs, outgoingAbsRecord, type AbsEditionSource, type AbsRecord } from './abs-push'

const hash = (t: string) => t
const edition = (o: Partial<AbsEditionSource> = {}): AbsEditionSource => ({
  title: 'Worm', subtitle: null, volume: null, authors: [], narrators: [], series: [], publishedOn: null, publisher: null, language: null, isbn13: null, isbn10: null, asin: null, ...o,
})
const rec = (o: Partial<AbsRecord> = {}): AbsRecord => ({
  title: null, subtitle: null, authors: [], narrators: [], series: [], publishedDate: null, publisher: null, language: null, isbn: null, asin: null, ...o,
})
const fields = (d: { field: string }[]) => d.map((x) => x.field)

describe('outgoingAbsRecord', () => {
  it('Worm volume 5', () => {
    const r = outgoingAbsRecord(edition({ volume: 5, series: [{ name: 'Parahumans', position: 1, positionEnd: null }] }))
    expect(r.title).toBe('Worm, Part 5')
    expect(r.series).toEqual([{ name: 'Parahumans', sequence: '1' }, { name: 'Worm', sequence: '5' }])
  })
  it('not a volume', () => {
    const r = outgoingAbsRecord(edition({ series: [{ name: 'Parahumans', position: 1, positionEnd: null }] }))
    expect(r.title).toBe('Worm')
    expect(r.series).toEqual([{ name: 'Parahumans', sequence: '1' }])
  })
  it('range sequence', () => {
    expect(outgoingAbsRecord(edition({ series: [{ name: 'P', position: 1, positionEnd: 2 }] })).series[0]?.sequence).toBe('1-2')
  })
  it('a null position gives a null sequence', () => {
    expect(outgoingAbsRecord(edition({ series: [{ name: 'P', position: null, positionEnd: null }] })).series[0]?.sequence).toBeNull()
  })
})

describe('diffAbs', () => {
  it('empty never clears', () => {
    const cur = rec({ publisher: 'Tor' })
    expect(fields(diffAbs(cur, rec(), hash))).toEqual([])
    expect(absMetadataPatch(rec(), cur, absPushFields)).not.toHaveProperty('publisher')
  })
  it('capitalisation counts', () => {
    const d = diffAbs(rec({ authors: ['pirateaba'] }), rec({ authors: ['Pirateaba'] }), hash)
    expect(d).toMatchObject([{ field: 'authors', from: 'pirateaba', to: 'Pirateaba' }])
  })
  it('sequence numeric', () => {
    expect(diffAbs(rec({ series: [{ name: 'Parahumans', sequence: '1.0' }] }), rec({ series: [{ name: 'Parahumans', sequence: '1' }] }), hash)).toEqual([])
  })
  it('series as a set', () => {
    const a = { name: 'A', sequence: '1' }
    const b = { name: 'B', sequence: '2' }
    expect(diffAbs(rec({ series: [a, b] }), rec({ series: [b, a] }), hash)).toEqual([])
  })
  it('series display', () => {
    const d = diffAbs(rec(), rec({ series: [{ name: 'A', sequence: '1' }, { name: 'B', sequence: null }] }), hash)
    expect(d[0]).toMatchObject({ from: '', to: 'A #1, B' })
  })
  it('authors ordered', () => {
    expect(fields(diffAbs(rec({ authors: ['A', 'B'] }), rec({ authors: ['B', 'A'] }), hash))).toEqual(['authors'])
  })
  it('language', () => {
    expect(diffAbs(rec({ language: 'English' }), rec({ language: 'en' }), hash)).toEqual([])
    expect(fields(diffAbs(rec({ language: 'English' }), rec({ language: 'he' }), hash))).toEqual(['language'])
    expect(absMetadataPatch(rec({ language: 'he' }), rec({ language: 'English' }), ['language'])).toEqual({ language: 'Hebrew' })
  })
  it('isbn', () => {
    expect(diffAbs(rec({ isbn: '978-0-7653-1178-8' }), rec({ isbn: '9780765311788' }), hash)).toEqual([])
  })
  it('identifiers lists only the parts that differ', () => {
    const d = diffAbs(rec({ isbn: '9780765311788', asin: 'B0OLD' }), rec({ isbn: '9780765311788', asin: 'B0NEW' }), hash)
    expect(d).toMatchObject([{ field: 'identifiers', from: 'ASIN B0OLD', to: 'ASIN B0NEW' }])
  })
  it('publishedDate', () => {
    const out = rec({ publishedDate: '2006-07-17' })
    const cur = rec({ publishedDate: '2006' })
    expect(fields(diffAbs(cur, out, hash))).toEqual(['publishedDate'])
    expect(absMetadataPatch(out, cur, ['publishedDate'])).toEqual({ publishedDate: '2006-07-17', publishedYear: '2006' })
  })
  it('trimmed', () => {
    const cur = currentAbsRecord({ media: { metadata: { title: ' Mistborn ' } } }) ?? rec()
    expect(diffAbs(cur, rec({ title: 'Mistborn' }), hash)).toEqual([])
  })
  it('hash changes with either side', () => {
    const h = (c: string, o: string) => diffAbs(rec({ title: c }), rec({ title: o }), (t) => `h:${t}`)[0]?.hash
    expect(h('a', 'b')).not.toBe(h('c', 'b'))
    expect(h('a', 'b')).not.toBe(h('a', 'c'))
  })
})

describe('absMetadataPatch', () => {
  it('patch only ticked fields', () => {
    const cur = rec({ title: 'a', series: [{ name: 'S', sequence: '1' }] })
    const out = rec({ title: 'b', series: [{ name: 'S', sequence: '2' }] })
    expect(Object.keys(absMetadataPatch(out, cur, ['title']))).toEqual(['title'])
  })
  it('authors as name objects', () => {
    expect(absMetadataPatch(rec({ authors: ['A'] }), rec(), ['authors'])).toEqual({ authors: [{ name: 'A' }] })
  })
})

describe('currentAbsRecord', () => {
  it('junk is null', () => {
    expect(currentAbsRecord({ nope: 1 })).toBeNull()
    expect(currentAbsRecord(null)).toBeNull()
  })
})
