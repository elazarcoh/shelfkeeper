import { describe, expect, it } from 'vitest'
import { CreateSourceInput, ExternalItem, externalItemFingerprint, globalIdKeys, isSyncedKind, libraryPathOf, MAX_OTHER_ID_LENGTH, SourceConfig, sourceKinds, toPublicConfig, withVolumeOverride } from './sources'

const item = (overrides: Record<string, unknown> = {}) =>
  ExternalItem.parse({
    externalId: 'li_1',
    format: 'audiobook',
    title: 'The Final Empire',
    authors: ['Brandon Sanderson'],
    ...overrides,
  })

describe('SourceConfig', () => {
  it('validates an Audiobookshelf config and trims a trailing slash from the URL', () => {
    const config = SourceConfig.parse({ kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378/', apiToken: 'secret' })
    expect(config).toEqual({ kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378', apiToken: 'secret', libraryIds: null })
  })
  it('rejects a non-http URL', () => {
    expect(SourceConfig.safeParse({ kind: 'audiobookshelf', baseUrl: 'ftp://abs.local', apiToken: 'x' }).success).toBe(false)
  })
  it('never exposes the token in the public view', () => {
    const config = SourceConfig.parse({ kind: 'audiobookshelf', baseUrl: 'http://abs.local', apiToken: 'secret' })
    expect(toPublicConfig(config)).toEqual({ kind: 'audiobookshelf', baseUrl: 'http://abs.local', libraryIds: null, hasSecret: true })
  })
  it('requires a name and defaults the schedule to off', () => {
    const input = CreateSourceInput.parse({ name: 'Home ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://abs.local', apiToken: 't' } })
    expect(input.schedule).toBeNull()
  })
})

describe('per-kind source configs', () => {
  it('parses a Calibre config with optional login, library and word-count column', () => {
    const config = SourceConfig.parse({ kind: 'calibre', baseUrl: 'http://calibre.lan:8080/', username: '', password: null })
    expect(config).toEqual({ kind: 'calibre', baseUrl: 'http://calibre.lan:8080', username: null, password: null, libraryId: null, wordCountColumn: null })
    expect(SourceConfig.safeParse({ kind: 'calibre', baseUrl: 'http://c', wordCountColumn: 'words' }).success).toBe(false)
  })

  it('parses Readarr and Chaptarr configs with an API key', () => {
    expect(SourceConfig.parse({ kind: 'readarr', baseUrl: 'http://readarr:8787', apiKey: 'k' })).toEqual({ kind: 'readarr', baseUrl: 'http://readarr:8787', apiKey: 'k' })
    expect(SourceConfig.safeParse({ kind: 'chaptarr', baseUrl: 'http://chaptarr:8789' }).success).toBe(false)
  })

  it('never exposes a secret in the public view', () => {
    expect(toPublicConfig(SourceConfig.parse({ kind: 'readarr', baseUrl: 'http://r', apiKey: 'k' }))).toEqual({ kind: 'readarr', baseUrl: 'http://r', hasSecret: true })
    expect(toPublicConfig(SourceConfig.parse({ kind: 'calibre', baseUrl: 'http://c' }))).toEqual({
      kind: 'calibre',
      baseUrl: 'http://c',
      username: null,
      libraryId: null,
      wordCountColumn: null,
      hasSecret: false,
    })
  })

  it('tells synced kinds from CSV and manual ones', () => {
    expect(isSyncedKind('chaptarr')).toBe(true)
    expect(isSyncedKind('csv')).toBe(false)
  })
})

describe('ExternalItem', () => {
  it('fills defaults for a minimal item', () => {
    expect(item()).toMatchObject({
      subtitle: null,
      narrators: [],
      series: [],
      identifiers: { isbn13: null, isbn10: null, asin: null, others: {} },
      durationSec: null,
      tags: [],
      wantedOnly: false,
    })
  })
  it('keeps a valid ISBN (dashes removed) and drops an invalid one instead of rejecting the item', () => {
    expect(item({ identifiers: { isbn13: '978-0-7653-1178-8' } }).identifiers.isbn13).toBe('9780765311788')
    expect(item({ identifiers: { isbn13: '9780765311789', asin: 'nope' } }).identifiers).toEqual({ isbn13: null, isbn10: null, asin: null, others: {} })
  })
  it('keeps an item with no author and a series without a position', () => {
    const parsed = item({ authors: [], series: [{ name: 'Mistborn', position: null }] })
    expect(parsed.authors).toEqual([])
    expect(parsed.series).toEqual([{ name: 'Mistborn', position: null, positionEnd: null }])
  })
  it('keeps Hebrew text as is', () => {
    expect(item({ title: 'הארי פוטר ואבן החכמים' }).title).toBe('הארי פוטר ואבן החכמים')
  })
  it('carries source-specific identifiers in others and defaults to empty', () => {
    const withOthers = item({ identifiers: { others: { audiobookshelfId: 'lib_1', customKey: 'value' } } })
    expect(withOthers.identifiers.others).toEqual({ audiobookshelfId: 'lib_1', customKey: 'value' })
    expect(item().identifiers.others).toEqual({})
  })
  it('drops invalid others values instead of rejecting the item', () => {
    const invalid = item({ identifiers: { others: { validKey: 'good', emptyKey: '', badKey: 123 } } })
    expect(invalid.identifiers.others).toEqual({})
    const valid = item({ identifiers: { others: { audiobookshelfId: 'lib_1', customKey: 'val' } } })
    expect(valid.identifiers.others).toEqual({ audiobookshelfId: 'lib_1', customKey: 'val' })
  })
  it('drops an over-long language, publisher or tag instead of rejecting the item', () => {
    const parsed = ExternalItem.safeParse({ externalId: 'li_1', format: 'audiobook', title: 'Dune', language: 'x'.repeat(36), publisher: 'p'.repeat(301), tags: ['Sci-Fi', 't'.repeat(101), 'Classic'] })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ language: null, publisher: null, tags: ['Sci-Fi', 'Classic'] })
    expect(item({ language: 'heb', publisher: 'Tor', tags: ['t'.repeat(100)] })).toMatchObject({ language: 'he', publisher: 'Tor', tags: ['t'.repeat(100)] })
  })
  it('changes fingerprint when others values change', () => {
    const a = item()
    const b = item({ identifiers: { others: { audiobookshelfId: 'lib_1' } } })
    expect(externalItemFingerprint(a)).not.toBe(externalItemFingerprint(b))
  })
})

describe('externalItemFingerprint', () => {
  it('ignores raw and key order, and changes when content changes', () => {
    const a = item({ raw: { anything: 1 } })
    const b = ExternalItem.parse({ authors: ['Brandon Sanderson'], title: 'The Final Empire', format: 'audiobook', externalId: 'li_1', raw: { other: 2 } })
    expect(externalItemFingerprint(a)).toBe(externalItemFingerprint(b))
    expect(externalItemFingerprint(item({ durationSec: 100 }))).not.toBe(externalItemFingerprint(a))
  })
  it('is unchanged by an empty translators list, so items synced before translators existed stay unchanged', () => {
    const a = item({})
    const withoutKey = JSON.stringify(JSON.parse(externalItemFingerprint(a)))
    expect(withoutKey).not.toContain('translators')
    expect(externalItemFingerprint(item({ translators: ['אורי בלסם'] }))).not.toBe(externalItemFingerprint(a))
  })
  it('ignores the cover URL, which moves whenever the source is given a new server address', () => {
    const a = item({ coverUrl: 'http://abs.local:13378/api/items/li_1/cover' })
    const b = item({ coverUrl: 'https://abs.example.com/api/items/li_1/cover' })
    expect(externalItemFingerprint(a)).toBe(externalItemFingerprint(b))
  })
})

describe('shelf additions', () => {
  it('knows the shelf source kind and the simania global id', () => {
    expect(sourceKinds).toContain('shelf')
    expect(globalIdKeys).toContain('simania')
  })
  it('reads translators, dropping blanks, and defaults them to none', () => {
    const base = { externalId: 'photo:1', format: 'physical', title: 'הקמיע מסמרקנד' }
    expect(ExternalItem.parse(base).translators).toEqual([])
    expect(ExternalItem.parse({ ...base, translators: ['אורי בלסם'] }).translators).toEqual(['אורי בלסם'])
  })
})

describe('ExternalItem.volume', () => {
  it('an item has no volume by default, and a null volume leaves the fingerprint as it was', () => {
    const base = { externalId: 'x', format: 'physical', title: 'T' } as const
    const plain = ExternalItem.parse(base)
    expect(plain.volume).toBeNull()
    expect(externalItemFingerprint(plain)).not.toContain('volume')
    const vol = ExternalItem.parse({ ...base, volume: { number: 2, count: 1 } })
    expect(vol.volume).toEqual({ number: 2, count: null })
    expect(ExternalItem.parse({ ...base, volume: { number: 0, count: null } }).volume).toBeNull()
    expect(externalItemFingerprint(vol)).not.toBe(externalItemFingerprint(plain))
  })
})

describe('withVolumeOverride', () => {
  const base = { externalId: 'x', format: 'physical', title: 'Henry IV', subtitle: null } as const
  const marked = ExternalItem.parse({ ...base, volume: { number: 1, count: null }, importedTitle: { title: 'Henry IV, Part 1', subtitle: null } })
  it('no choice leaves the item alone', () => {
    expect(withVolumeOverride(marked, undefined)).toBe(marked)
  })
  it('a volume replaces the volume and cleans the title again', () => {
    const restored = withVolumeOverride(marked, null)
    expect(restored.title).toBe('Henry IV, Part 1')
    expect(withVolumeOverride(restored, { number: 2, count: null })).toMatchObject({ title: 'Henry IV', volume: { number: 2, count: null } })
  })
  it('"not a volume" brings back the imported title and subtitle', () => {
    expect(withVolumeOverride(marked, null)).toMatchObject({ title: 'Henry IV, Part 1', subtitle: null, volume: null })
    const sub = ExternalItem.parse({ ...base, title: 'T', subtitle: 'S', volume: { number: 2, count: null }, importedTitle: { title: 'T', subtitle: 'S, Vol. 2' } })
    expect(withVolumeOverride(sub, null)).toMatchObject({ title: 'T', subtitle: 'S, Vol. 2', volume: null })
  })
  it('an item that lost no marker keeps its title', () => {
    const plain = ExternalItem.parse({ ...base, title: 'Saga' })
    expect(plain.importedTitle).toBeNull()
    expect(withVolumeOverride(plain, null)).toMatchObject({ title: 'Saga', volume: null })
  })
  it('a null importedTitle stays out of the fingerprint', () => {
    const plain = ExternalItem.parse({ ...base, title: 'Saga' })
    expect(externalItemFingerprint(plain)).not.toContain('importedTitle')
    expect(externalItemFingerprint(marked)).toContain('importedTitle')
  })
})

describe('libraryPathOf (#104)', () => {
  it('gives one spelling of a relative folder, whatever the separators and Unicode form', () => {
    expect(libraryPathOf('Brandon Sanderson/Mistborn/The Final Empire')).toBe('Brandon Sanderson/Mistborn/The Final Empire')
    expect(libraryPathOf('/Brandon Sanderson//The Final Empire/')).toBe('Brandon Sanderson/The Final Empire')
    expect(libraryPathOf('Brandon Sanderson\\The Final Empire')).toBe('Brandon Sanderson/The Final Empire')
    expect(libraryPathOf('./Author/Title')).toBe('Author/Title')
    expect(libraryPathOf('Café')).toBe(libraryPathOf('Café'))
  })
  it('has no path for nothing, an escape upwards or a path too long to store', () => {
    expect(libraryPathOf('')).toBeNull()
    expect(libraryPathOf('/')).toBeNull()
    expect(libraryPathOf('Author/../Other')).toBeNull()
    expect(libraryPathOf('a'.repeat(MAX_OTHER_ID_LENGTH + 1))).toBeNull()
  })
  it('names the same book across sources, and a long path fits next to the other ids', () => {
    expect(globalIdKeys).toContain('libraryPath')
    const long = `Author/${'t'.repeat(500)}`
    const parsed = ExternalItem.parse({ externalId: 'x', format: 'audiobook', title: 'T', identifiers: { others: { chaptarrBookId: '1', libraryPath: long } } })
    expect(parsed.identifiers.others).toEqual({ chaptarrBookId: '1', libraryPath: long })
  })
})

describe('ExternalItem series ranges (#122)', () => {
  const base = { externalId: 'x', format: 'audiobook', title: 'Pack' } as const
  it('keeps a range that goes up, and drops an end that does not', () => {
    expect(ExternalItem.parse({ ...base, series: [{ name: 'Mage Errant', position: 1, positionEnd: 2 }] }).series).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(ExternalItem.parse({ ...base, series: [{ name: 'S', position: 2, positionEnd: 1 }] }).series).toEqual([{ name: 'S', position: 2, positionEnd: null }])
    expect(ExternalItem.parse({ ...base, series: [{ name: 'S', position: null, positionEnd: 2 }] }).series).toEqual([{ name: 'S', position: null, positionEnd: null }])
    expect(ExternalItem.parse({ ...base, series: [{ name: 'S', position: 1, positionEnd: 'x' }] }).series).toEqual([{ name: 'S', position: 1, positionEnd: null }])
  })
  it('an item with no range fingerprints exactly as before', () => {
    const plain = ExternalItem.parse({ ...base, series: [{ name: 'Mistborn', position: 1 }] })
    expect(externalItemFingerprint(plain)).not.toContain('positionEnd')
    expect(externalItemFingerprint(plain)).toContain('"series":[{"name":"Mistborn","position":1}]')
    const ranged = ExternalItem.parse({ ...base, series: [{ name: 'Mistborn', position: 1, positionEnd: 2 }] })
    expect(externalItemFingerprint(ranged)).not.toBe(externalItemFingerprint(plain))
  })
})
