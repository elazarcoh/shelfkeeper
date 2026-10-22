import { describe, expect, it } from 'vitest'
import { autoKindApplies, inferKind, KIND_SUGGESTION_SQL_PATTERNS, kindFromTags, kindFromText, mergeKind, workKindLabel } from './work-kind'

const at = '2026-01-01T00:00:00.000Z'
const manual = { kind: { origin: 'manual' as const, at, locked: true } }
const auto = { kind: { origin: 'source' as const, at, locked: false } }

describe('kindFromTags', () => {
  it('reads tag spellings loosely', () => {
    expect(kindFromTags(['Fantasy', 'Fan Fiction'])).toBe('fanfiction')
    expect(kindFromTags(['fan-fic'])).toBe('fanfiction')
    expect(kindFromTags(['Web_Serial'])).toBe('web_serial')
    expect(kindFromTags(['Web Novel', 'Fanfic'])).toBe('fanfiction')
    expect(kindFromTags(['Fantasy'])).toBeNull()
  })
})

describe('kindFromText', () => {
  it('reads site links', () => {
    expect(kindFromText(['Text found here: http://archiveofourown.org/works/189189/'])).toBe('fanfiction')
    expect(kindFromText(['read on https://www.royalroad.com/fiction/1'])).toBe('web_serial')
    expect(kindFromText([null, 'nothing'])).toBeNull()
  })
  it('lets fanfiction beat web serial when one text names both', () => {
    expect(kindFromText(['royalroad.com archiveofourown.org'])).toBe('fanfiction')
  })
})

describe('inferKind', () => {
  it('prefers the AI pick, then tags, then links', () => {
    expect(inferKind({ aiKind: 'web_serial', tags: ['Fan Fiction'], texts: [] })).toBe('web_serial')
    expect(inferKind({ tags: [], texts: ['fanfiction.net/s/1'] })).toBe('fanfiction')
    expect(inferKind({ aiKind: 'book', tags: ['fanfic'], texts: [] })).toBe('fanfiction')
    expect(inferKind({ tags: ['webserial'], texts: ['archiveofourown.org'] })).toBe('web_serial')
  })
})

describe('autoKindApplies', () => {
  it('only touches unlocked books', () => {
    expect(autoKindApplies({ kind: 'book', provenance: {} })).toBe(true)
    expect(autoKindApplies({ kind: 'book', provenance: manual })).toBe(false)
    expect(autoKindApplies({ kind: 'fanfiction', provenance: {} })).toBe(false)
  })
})

describe('mergeKind', () => {
  it('lets a manual source beat an automatic target', () => {
    expect(mergeKind({ kind: 'fanfiction', provenance: auto }, { kind: 'book', provenance: manual })).toEqual({ kind: 'book', fromSource: true })
  })
  it('lets a non-book beat a book when neither is manual', () => {
    expect(mergeKind({ kind: 'book', provenance: {} }, { kind: 'web_serial', provenance: auto })).toEqual({ kind: 'web_serial', fromSource: true })
    expect(mergeKind({ kind: 'web_serial', provenance: auto }, { kind: 'book', provenance: {} })).toEqual({ kind: 'web_serial', fromSource: false })
  })
  it('lets a locked source carry its lock even when the kinds are equal', () => {
    expect(mergeKind({ kind: 'book', provenance: {} }, { kind: 'book', provenance: manual })).toEqual({ kind: 'book', fromSource: true })
  })
  it('keeps the target when both are manual', () => {
    expect(mergeKind({ kind: 'fanfiction', provenance: manual }, { kind: 'web_serial', provenance: manual })).toEqual({ kind: 'fanfiction', fromSource: false })
  })
  it('keeps a manual target over a non-book source', () => {
    expect(mergeKind({ kind: 'book', provenance: manual }, { kind: 'fanfiction', provenance: auto })).toEqual({ kind: 'book', fromSource: false })
  })
})

describe('KIND_SUGGESTION_SQL_PATTERNS', () => {
  // Postgres word anchors (\m, \M) read as \b in JS
  const re = (p: string) => new RegExp(p.replaceAll('\\m', '\\b').replaceAll('\\M', '\\b'), 'i')
  it('matches the suggestion signals', () => {
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionText).test('Made with https://github.com/aedocw/epub2tts-vibevoice')).toBe(true)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionText).test('Text found here: http://archiveofourown.org/works/189189/')).toBe(true)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionText).test('from www.fanfiction.net/s/1')).toBe(true)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionTitle).test('Founding Hogwarts')).toBe(true)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionTitle).test('Draco in Winter')).toBe(true)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionTitle).test('Draconic Rising')).toBe(false)
    expect(re(KIND_SUGGESTION_SQL_PATTERNS.fanfictionTitle).test("Harry Potter and the Philospher's Zombie")).toBe(true)
    for (const t of ['originally published on Royal Road', 'a web serial', 'Scribble Hub', 'Spacebattles', 'originally published online'])
      expect(re(KIND_SUGGESTION_SQL_PATTERNS.serialText).test(t)).toBe(true)
  })
})

describe('workKindLabel', () => {
  it('labels every kind', () => {
    expect(workKindLabel).toEqual({ book: 'Book', fanfiction: 'Fanfiction', web_serial: 'Web serial' })
  })
})
