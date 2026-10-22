import { describe, expect, it } from 'vitest'
import { SHELF_MAX_ANSWER } from './shelf'
import { WHAT_NEXT, buildWhatNextPrompt, isFavoriteAuthor, isHeavy, isHooked, isLight, nextPosition, firstUnreadBook, onePerSeries, parseWhatNextAnswer, pickHardcoverSeries, preselectMood, type WhatNextPromptInput } from './what-next'

const none = { pages: null, audioSec: null }

describe('isHeavy', () => {
  it('uses pages, audio length and moods', () => {
    expect(isHeavy({ pages: 600, audioSec: null }, [])).toBe(true)
    expect(isHeavy({ pages: 599, audioSec: null }, [])).toBe(false)
    expect(isHeavy({ pages: null, audioSec: 72_000 }, [])).toBe(true)
    expect(isHeavy({ pages: 300, audioSec: null }, ['dark'])).toBe(true)
    expect(isHeavy(none, [])).toBe(false)
  })
})

describe('isLight', () => {
  it('is short and not heavy', () => {
    expect(isLight({ pages: 399, audioSec: null }, [])).toBe(true)
    expect(isLight({ pages: null, audioSec: 43_199 }, [])).toBe(true)
    expect(isLight({ pages: 399, audioSec: null }, ['dark'])).toBe(false)
    expect(isLight(none, [])).toBe(false)
  })
})

describe('isHooked', () => {
  it('needs two reads and nothing rated below 3', () => {
    expect(isHooked([{ rating: null }, { rating: null }])).toBe(true)
    expect(isHooked([{ rating: 5 }, { rating: 2.5 }])).toBe(false)
    expect(isHooked([{ rating: 4 }])).toBe(false)
  })
})

describe('preselectMood', () => {
  it('follows the rules', () => {
    expect(preselectMood({ lastFinished: { heavy: true }, nextInSeries: { hooked: true } })).toBe('keep_going')
    expect(preselectMood({ lastFinished: { heavy: true }, nextInSeries: { hooked: false } })).toBe('light')
    expect(preselectMood({ lastFinished: { heavy: true }, nextInSeries: null })).toBe('light')
    expect(preselectMood({ lastFinished: { heavy: false }, nextInSeries: { hooked: false } })).toBe('keep_going')
    expect(preselectMood({ lastFinished: { heavy: false }, nextInSeries: null })).toBe('surprise')
    expect(preselectMood({ lastFinished: null, nextInSeries: null })).toBe('surprise')
    expect(preselectMood({ lastFinished: null, nextInSeries: { hooked: false } })).toBe('keep_going')
  })
})

describe('isFavoriteAuthor', () => {
  it('counts reads, or a high rated average over two', () => {
    expect(isFavoriteAuthor([{ rating: null }, { rating: null }, { rating: null }])).toBe(true)
    expect(isFavoriteAuthor([{ rating: 4 }, { rating: 4.5 }])).toBe(true)
    expect(isFavoriteAuthor([{ rating: 4 }, { rating: null }])).toBe(true)
    expect(isFavoriteAuthor([{ rating: 3 }, { rating: 4 }])).toBe(false)
    expect(isFavoriteAuthor([{ rating: 5 }])).toBe(false)
  })
})

describe('nextPosition', () => {
  it('prefers whole numbers after the highest read', () => {
    expect(nextPosition([1, 2], [1, 2, 2.5, 3, 4])).toBe(3)
    expect(nextPosition([], [1, 2])).toBe(1)
    expect(nextPosition([3], [1, 2, 3, 3.5])).toBe(3.5)
    expect(nextPosition([4], [1, 2, 3, 4])).toBeNull()
  })
})

describe('parseWhatNextAnswer', () => {
  const pick = (over: object = {}) => ({ title: 'Cradle', authors: ['Will Wight'], reason: 'fast', ...over })
  const read = [{ title: 'The Final Empire', authors: ['Brandon Sanderson'] }]
  it('reads an array inside prose', () => {
    const r = parseWhatNextAnswer(`Sure!\n${JSON.stringify([pick()])}\nEnjoy`, read)
    expect(r).toEqual({ ok: true, value: { picks: [expect.objectContaining({ title: 'Cradle', kind: 'book', url: null, series: null })], alreadyRead: 0, unusable: 0 } })
  })
  it('drops read books under another spelling', () => {
    const r = parseWhatNextAnswer(JSON.stringify([{ title: 'the final empire', authors: ['brandon sanderson'], reason: 'x' }, pick()]), read)
    expect(r.ok && [r.value.picks.length, r.value.alreadyRead, r.value.unusable]).toEqual([1, 1, 0])
  })
  it('drops fanfiction without a link', () => {
    const r = parseWhatNextAnswer(JSON.stringify([pick({ kind: 'fanfiction' }), pick({ kind: 'fanfiction', url: 'https://archiveofourown.org/works/1' })]), [])
    expect(r.ok && [r.value.picks.length, r.value.alreadyRead, r.value.unusable]).toEqual([1, 0, 1])
  })
  it('drops a web serial without a link', () => {
    const r = parseWhatNextAnswer(JSON.stringify([pick({ kind: 'web_serial' }), pick({ kind: 'web_serial', url: 'https://royalroad.com/x' })]), [])
    expect(r.ok && [r.value.picks.length, r.value.alreadyRead, r.value.unusable]).toEqual([1, 0, 1])
  })
  it('accepts only http(s) links', () => {
    const r = parseWhatNextAnswer(JSON.stringify([pick({ kind: 'fanfiction', url: 'javascript:alert(1)' }), pick({ kind: 'book', url: 'javascript:alert(1)' }), pick({ kind: 'book', url: 'not a url' })]), [])
    expect(r.ok && [r.value.picks.map((p) => p.url), r.value.unusable]).toEqual([[null, null], 1])
  })
  it('reads a kind written loosely (case, spaces, hyphens) as that kind', () => {
    const url = 'https://archiveofourown.org/works/1'
    const r = parseWhatNextAnswer(JSON.stringify([pick({ title: 'A', kind: 'Fan fiction', url }), pick({ title: 'B', kind: 'Web Serial', url }), pick({ title: 'C', kind: 'web-serial', url })]), [])
    expect(r.ok && r.value.picks.map((p) => [p.title, p.kind])).toEqual([['A', 'fanfiction'], ['B', 'web_serial'], ['C', 'web_serial']])
  })
  it('treats an unknown kind as a book instead of dropping the pick', () => {
    const r = parseWhatNextAnswer(JSON.stringify([pick({ kind: 'novel' }), pick({ title: 'Other', kind: 7 })]), [])
    expect(r.ok && [r.value.picks.map((p) => [p.title, p.kind]), r.value.unusable]).toEqual([[['Cradle', 'book'], ['Other', 'book']], 0])
  })
  it('drops an item without a reason', () => {
    const r = parseWhatNextAnswer(JSON.stringify([{ title: 'A', authors: ['B'] }]), [])
    expect(r.ok && [r.value.picks.length, r.value.alreadyRead, r.value.unusable]).toEqual([0, 0, 1])
  })
  it('explains non-JSON text', () => {
    const r = parseWhatNextAnswer('no idea', [])
    expect(!r.ok && r.error).toContain('JSON array')
  })
  it('refuses a huge answer', () => {
    expect(parseWhatNextAnswer(' '.repeat(SHELF_MAX_ANSWER + 1), []).ok).toBe(false)
  })
  it('keeps one pick per series: the lower position, a null one losing, a tie keeping the first', () => {
    const r = parseWhatNextAnswer(
      JSON.stringify([pick({ title: 'B3', series: 'Cradle', position: 3 }), pick({ title: 'Other' }), pick({ title: 'B1', series: 'cradle', position: 1 }), pick({ title: 'N', series: 'Loose' }), pick({ title: 'P', series: 'Loose', position: 4 }), pick({ title: 'T1', series: 'Tie', position: 1 }), pick({ title: 'T2', series: 'Tie', position: 1 })]),
      [],
    )
    expect(r.ok && r.value.picks.map((p) => p.title)).toEqual(['Other', 'B1', 'P', 'T1'])
    expect(r.ok && [r.value.alreadyRead, r.value.unusable]).toEqual([0, 0])
  })
})

describe('buildWhatNextPrompt', () => {
  const input = (over: Partial<WhatNextPromptInput> = {}): WhatNextPromptInput => ({
    mood: 'light', format: 'any', lastFinished: { title: 'Dune', authors: ['Frank Herbert'], rating: 4.5 },
    seriesInProgress: [{ series: 'Cradle', nextPosition: 9 }], favoriteAuthors: ['Terry Pratchett', 'Ursula Le Guin'], topRated: [], read: [], ...over,
  })
  it('carries the person data and the instructions', () => {
    const p = buildWhatNextPrompt(input())
    for (const s of ['Dune', 'Terry Pratchett', 'Ursula Le Guin', 'Reddit', 'fanfiction']) expect(p).toContain(s)
  })
  it('asks for audiobooks but keeps fanfiction under the audio chip', () => {
    const p = buildWhatNextPrompt(input({ format: 'audio' }))
    expect(p).toContain('prefer books that have an audiobook')
    expect(p).toContain('keep fanfiction and web serials')
  })
  it('asks for one book per series, starting a new series at book 1', () => {
    expect(buildWhatNextPrompt(input())).toContain("At most one book per series. For a series I haven't started, suggest book 1.")
  })
  it('caps the read list and says how many were left out', () => {
    const read = Array.from({ length: 500 }, (_, i) => ({ title: `Title${i}x`, authors: ['A'] }))
    const p = buildWhatNextPrompt(input({ read }))
    expect(p.match(/- Title\d+x/g)).toHaveLength(WHAT_NEXT.promptReadCap)
    expect(p).toContain('Title0x')
    expect(p).not.toContain('Title400x')
    expect(p).toContain('(100 older books')
  })
})

describe('pickHardcoverSeries', () => {
  const entries = [
    { id: 1, name: 'The Cosmere', position: 1, featured: false },
    { id: 2, name: 'The Mistborn Saga', position: 1, featured: true },
  ]
  it('prefers the entry that equals the local name, then one that contains or is contained', () => {
    expect(pickHardcoverSeries('Mistborn', entries)?.id).toBe(2)
    expect(pickHardcoverSeries('the cosmere', entries)?.id).toBe(1)
    expect(pickHardcoverSeries('Mistborn Saga: Era One', entries)?.id).toBe(2)
  })
  it('falls back to the first featured entry, else none', () => {
    expect(pickHardcoverSeries('Something Else', entries)?.id).toBe(2)
    expect(pickHardcoverSeries('Something Else', [{ id: 1, name: 'X', position: null, featured: false }])).toBeNull()
    expect(pickHardcoverSeries('Mistborn', [])).toBeNull()
  })
})

describe('onePerSeries', () => {
  const of = (b: { series: string | null; position: number | null }) => b
  const b = (id: string, series: string | null, position: number | null) => ({ id, series, position })
  it('keeps the lowest position of each series, in the list order of the winners', () => {
    const out = onePerSeries([b('a3', 'Cradle', 3), b('x', null, null), b('a1', 'cradle', 1), b('c2', 'Other', 2), b('a2', 'CRADLE', 2)], of)
    expect(out.map((x) => x.id)).toEqual(['x', 'a1', 'c2'])
  })
  it('lets a null position lose to any number, and a tie keep the first', () => {
    expect(onePerSeries([b('n', 'S', null), b('p', 'S', 5)], of).map((x) => x.id)).toEqual(['p'])
    expect(onePerSeries([b('t1', 'S', 2), b('t2', 'S', 2)], of).map((x) => x.id)).toEqual(['t1'])
    expect(onePerSeries([b('n1', 'S', null), b('n2', 'S', null)], of).map((x) => x.id)).toEqual(['n1'])
  })
  it('never drops a book without a series', () => {
    expect(onePerSeries([b('a', null, 1), b('b', null, 1), b('c', '  ', 1), b('d', '', 1)], of)).toHaveLength(4)
  })
})

describe('firstUnreadBook', () => {
  const books = [
    { title: 'One', position: 1, read: true },
    { title: 'Two', position: 2, read: false },
    { title: 'Three', position: 3, read: false },
    { title: 'Loose', position: null, read: false },
  ]
  it('is the lowest unread book before the pick', () => {
    expect(firstUnreadBook(books, 3)).toEqual({ title: 'Two', position: 2 })
  })
  it('counts a position as read when any entry at it is read (a box set, a second edition)', () => {
    const dup = [
      { title: 'One', position: 1, read: true },
      { title: 'One (box set)', position: 1, read: false },
      { title: 'Two', position: 2, read: false },
    ]
    expect(firstUnreadBook(dup, 3)).toEqual({ title: 'Two', position: 2 })
    expect(firstUnreadBook(dup.filter((b) => b.position === 1), 3)).toBeNull()
  })
  it('counts every whole position of a read range as read (a box set)', () => {
    const box = [
      { title: 'Box 1-3', position: 1, positionEnd: 3, read: true },
      { title: 'Two', position: 2, read: false },
    ]
    expect(firstUnreadBook(box, 4)).toBeNull()
    expect(firstUnreadBook([{ title: 'Box 1-3', position: 1, positionEnd: 3, read: false }, { title: 'Two', position: 2, read: false }], 4)).toEqual({ title: 'Box 1-3', position: 1 })
  })
  it('never names a novella or a prequel: only whole positions of 1 or more', () => {
    const saga = [
      { title: 'Zero', position: 0, read: false },
      { title: 'Half', position: 0.5, read: false },
      { title: 'One', position: 1, read: true },
      { title: 'Two', position: 2, read: false },
      { title: 'Two and a half', position: 2.5, read: false },
    ]
    expect(firstUnreadBook(saga, 3)).toEqual({ title: 'Two', position: 2 })
    expect(firstUnreadBook(saga.filter((b) => b.position !== 2), 3)).toBeNull()
  })
  it('is null when the pick is the first unread, nothing is earlier, or no position is known', () => {
    expect(firstUnreadBook(books, 2)).toBeNull()
    expect(firstUnreadBook(books.map((x) => ({ ...x, read: x.position === 2 || x.read })), 3)).toBeNull()
    expect(firstUnreadBook(books, null)).toBeNull()
    expect(firstUnreadBook([], 3)).toBeNull()
  })
})
