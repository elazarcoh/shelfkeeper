import { describe, expect, it } from 'vitest'
import { SHELF_FORMAT, SHELF_PROMPT, SHELF_SETUP_PROMPT, PhotoLink, parseShelfAnswer, prefillQuery, sameShelfBook, searchQueries, shelfAnswerFormat, shelfStatus, toExternalItem, type ShelfRow } from './shelf'
import { seriesPosition } from './numerals'

const row = (over: Partial<ShelfRow> = {}): ShelfRow => ({
  title: 'המושבה האבודה', subtitle: null, authors: ['אואן קולפר'], translators: [], publisher: 'כנרת', series: 'ארטמיס פאול',
  seriesNumber: null, language: 'he', spineText: null, originalTitle: 'Artemis Fowl and the Lost Colony', confidence: 'high', notes: null, volume: null, volumeCount: null, volumeSet: false, ...over,
})

/** FNV-1a, enough to notice that a text changed */
const fingerprint = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16)
}

describe('the shelf answer format', () => {
  it('moves with the prompt', () => {
    // changed SHELF_PROMPT? bump SHELF_FORMAT (saved AI setups are then told to refresh), and update the fingerprint
    expect([SHELF_FORMAT, fingerprint(SHELF_PROMPT)]).toEqual([1, 'a50853d8'])
  })
  it('the prompt asks for the format line', () => {
    expect(SHELF_PROMPT).toContain(`My Library shelf answer, format ${SHELF_FORMAT}`)
  })
  it('the setup prompt asks the AI to save the whole prompt as a skill', () => {
    expect(SHELF_SETUP_PROMPT).toContain(`----- BEGIN SKILL -----\n${SHELF_PROMPT}\n----- END SKILL -----`)
    expect(SHELF_SETUP_PROMPT).toContain('My Library — shelf photo')
  })
  it('reads the format line, wherever the AI put it', () => {
    expect(shelfAnswerFormat('My Library shelf answer, format 1\n```json\n[]\n```')).toBe(1)
    expect(shelfAnswerFormat('Sure!\n\n**My Library shelf answer, format 3**\n[]')).toBe(3)
    expect(shelfAnswerFormat('my library shelf answer format 2\n[]')).toBe(2)
  })
  it('an answer without the line has no format', () => {
    expect(shelfAnswerFormat('```json\n[{"title": "x"}]\n```')).toBeNull()
  })
})

describe('parseShelfAnswer', () => {
  const answer = (rows: unknown[]) => '```json\n' + JSON.stringify(rows) + '\n```'
  it('reads the fenced array and maps the AI field names', () => {
    const r = parseShelfAnswer(answer([{ position: 1, title: 'שם הרוח', authors: ['פטריק רותפס'], series_number: 'כרך א\'', spine_text: 'שם הרוח פטריק רותפס', original_title_hint: 'The Name of the Wind', translator: 'צפריר גרוסמן' }]))
    expect(r).toEqual({ ok: true, value: { rows: [expect.objectContaining({ title: 'שם הרוח', seriesNumber: "כרך א'", spineText: 'שם הרוח פטריק רותפס', originalTitle: 'The Name of the Wind', translators: ['צפריר גרוסמן'] })], unreadable: [], truncated: false } })
  })
  it('reads an unfenced array with prose around it, and repairs trailing commas', () => {
    const r = parseShelfAnswer('Here you go:\n[{"title": "בשורות טובות", "authors": ["ניל גיימן", "טרי פראצ\'ט",],},]\nEnjoy!')
    expect(r.ok && r.value.rows.map((x) => x.authors)).toEqual([['ניל גיימן', "טרי פראצ'ט"]])
  })
  it('skips rows without a title and reports them by position', () => {
    const r = parseShelfAnswer(JSON.stringify([{ position: 1, title: '' }, { position: 2, title: 'אלפי' }, 'junk']))
    expect(r.ok && r.value.unreadable).toEqual([{ position: 1, reason: 'no title' }, { position: 3, reason: 'not a book' }])
    expect(r.ok && r.value.rows.map((x) => x.title)).toEqual(['אלפי'])
  })
  it('keeps the first 100 rows and says so', () => {
    const r = parseShelfAnswer(JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ title: `ספר ${i}` }))))
    expect(r.ok && [r.value.rows.length, r.value.truncated]).toEqual([100, true])
  })
  it('explains an answer with no list', () => {
    expect(parseShelfAnswer('Sorry, I cannot see the photo')).toEqual({ ok: false, error: "Couldn't find the list in that answer — paste the whole reply" })
    expect(parseShelfAnswer('[{"title": "x"')).toEqual({ ok: false, error: "Couldn't find the list in that answer — paste the whole reply" })
  })
  it('ignores a wrong confidence and non-string authors instead of rejecting the row', () => {
    const r = parseShelfAnswer(JSON.stringify([{ title: 'א', confidence: 'sure', authors: [3, 'ב', ''] }]))
    expect(r.ok && r.value.rows[0]).toMatchObject({ confidence: null, authors: ['ב'] })
  })
})

describe('seriesPosition', () => {
  it.each([
    ['1', 1], ['12', 12], ['ב', 2], ["כרך א'", 1], ['כרך ב׳', 2], ['יא', 11], ['ספר 3', 3], ['#4', 4], ['חלק ג', 3],
    ['ספר שני', 2], ['חלק שני', 2], ['כרך ראשון', 1], ['שנייה', 2], ['עשירית', 10], ['ספר מוזר', null], ['', null], [null, null], ['abc', null],
  ])('%s → %s', (text, expected) => expect(seriesPosition(text)).toBe(expected))
})

describe('toExternalItem', () => {
  it('builds a physical item with the series position and translators', () => {
    const item = toExternalItem(row({ seriesNumber: "כרך ב'", translators: ['עפרה אביגד'] }), 3)
    expect(item).toMatchObject({ externalId: 'photo:3', format: 'physical', title: 'המושבה האבודה', series: [{ name: 'ארטמיס פאול', position: 2 }], translators: ['עפרה אביגד'], publisher: 'כנרת' })
  })
})

describe('searchQueries', () => {
  it('drops a separate series label, then offers the parts, the full title and title + author', () => {
    expect(searchQueries(row({ title: 'ארטמיס פאול – המושבה האבודה', series: null }))).toEqual(['המושבה האבודה', 'ארטמיס פאול', 'ארטמיס פאול – המושבה האבודה', 'המושבה האבודה אואן קולפר'])
    expect(searchQueries(row({ title: 'ארטמיס פאול – המושבה האבודה' }))[0]).toBe('המושבה האבודה')
    expect(searchQueries(row({ title: 'הארי פוטר ואבן החכמים', series: 'הארי פוטר', authors: [] }))).toEqual(['הארי פוטר ואבן החכמים'])
  })
  it('adds the spine text and never more than five', () => {
    const q = searchQueries(row({ title: 'א – ב – ג', subtitle: 'ד', spineText: 'ה ו', series: null }))
    expect(q.length).toBeLessThanOrEqual(5)
    expect(new Set(q).size).toBe(q.length)
  })
  it('puts a known ISBN first: it finds the exact edition', () => {
    const q = searchQueries({ ...row({ title: 'ארטמיס פאול – המושבה האבודה', series: null }), isbn: ' 9789655173419 ' })
    expect(q[0]).toBe('9789655173419')
    expect(q[1]).toBe('המושבה האבודה')
    expect(q.length).toBeLessThanOrEqual(5)
    expect(searchQueries({ ...row(), isbn: null })).toEqual(searchQueries(row()))
  })
})

describe('sameShelfBook', () => {
  const key = (title: string, originalTitle: string | null, seriesNumber: string | null = null) => ({ title, originalTitle, seriesNumber })
  it('two readings of the same spine are the same book through the English title', () => {
    expect(sameShelfBook(key('פחדיו של האדם החכם', "The Wise Man's Fear", "כרך א'"), key('פחדו של אדם חכם', "The Wise Man's Fear", "כרך א'"))).toBe(true)
  })
  it('different volumes are different books', () => {
    expect(sameShelfBook(key('פחדיו של האדם החכם', "The Wise Man's Fear", "כרך א'"), key('פחדיו של האדם החכם', "The Wise Man's Fear", "כרך ב'"))).toBe(false)
  })
  it('volumes marked in words that differ are different books; the same words are the same book', () => {
    expect(sameShelfBook(key('שם הרוח', null, 'כרך ראשון'), key('שם הרוח', null, 'כרך שני'))).toBe(false)
    expect(sameShelfBook(key('שם הרוח', null, 'כרך מוזר'), key('שם הרוח', null, 'כרך אחר'))).toBe(false)
    expect(sameShelfBook(key('שם הרוח', null, 'כרך מוזר'), key('שם הרוח', null, 'כרך  מוזר'))).toBe(true)
  })
  it('equal titles ignoring niqqud and punctuation', () => {
    expect(sameShelfBook(key('הַקָּמִיעַ מִסַּמַרְקַנְד!', null), key('הקמיע מסמרקנד', null))).toBe(true)
    expect(sameShelfBook(key('שם הרוח', null), key('בשורות טובות', null))).toBe(false)
  })
})

describe('shelfStatus', () => {
  const top = (over = {}) => ({ workId: '66666666-6666-4666-8666-666666666666', title: 'X', score: 0.9, basis: 'title_author' as const, hasPhysicalInHand: false, volume: null, ...over })
  it('orders repeat, inbox, have, copy_of, maybe, new', () => {
    expect(shelfStatus({ repeatOf: 0, inInbox: null, top: top() })).toEqual({ kind: 'repeat', of: 0 })
    expect(shelfStatus({ repeatOf: null, inInbox: { proposalId: 'p', title: 'T' }, top: top() })).toEqual({ kind: 'in_inbox', proposalId: 'p', title: 'T' })
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: top({ hasPhysicalInHand: true }) }).kind).toBe('have')
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: top() }).kind).toBe('copy_of')
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: top({ score: 0.7 }) }).kind).toBe('copy_of')
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: top({ score: 0.69 }) }).kind).toBe('maybe')
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: top({ score: 0.2, basis: 'identifier' }) }).kind).toBe('copy_of')
    expect(shelfStatus({ repeatOf: null, inInbox: null, top: null })).toEqual({ kind: 'new' })
  })
})

describe('volumes on the shelf', () => {
  const base = { title: 'דרך המלכים', subtitle: null, authors: ['ברנדון סנדרסון'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'he', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume: null, volumeCount: null, volumeSet: false }
  it('the prompt asks for the volume apart from the series number', () => {
    expect(SHELF_PROMPT).toContain('"volume"')
    expect(SHELF_PROMPT).toContain('"volume_count"')
  })
  it('reads volume and volume_count from the answer', () => {
    const r = parseShelfAnswer('[{"title":"דרך המלכים","volume":"כרך ב\'","volume_count":"2"}]')
    expect(r.ok && r.value.rows[0]).toMatchObject({ title: 'דרך המלכים', volume: 2, volumeCount: 2 })
    const junk = parseShelfAnswer('[{"title":"x","volume":"maybe","volume_count":"lots"}]')
    expect(junk.ok && junk.value.rows[0]).toMatchObject({ volume: null, volumeCount: null })
  })
  it('the item gets the row volume, else a marker on the title, else a volume-looking series number with no series', () => {
    expect(toExternalItem({ ...base, volume: 2, volumeCount: 2 }, 1).volume).toEqual({ number: 2, count: 2 })
    expect(toExternalItem({ ...base, title: "דרך המלכים כרך א'" }, 1)).toMatchObject({ title: 'דרך המלכים', volume: { number: 1, count: null } })
    expect(toExternalItem({ ...base, seriesNumber: "כרך ב'" }, 1)).toMatchObject({ volume: { number: 2, count: null }, series: [] })
    // a series number in a named series stays a series position
    expect(toExternalItem({ ...base, series: 'ארכיון אור הסערה', seriesNumber: '1' }, 1)).toMatchObject({ volume: null, series: [{ name: 'ארכיון אור הסערה', position: 1 }] })
  })
  it("the person's volume wins over a title marker, and 'not a volume' is kept", () => {
    const r = { ...base, title: "דרך המלכים כרך א'" }
    expect(toExternalItem({ ...r, volume: 2, volumeCount: null, volumeSet: true }, 1).volume).toEqual({ number: 2, count: null })
    expect(toExternalItem({ ...r, volume: null, volumeCount: null, volumeSet: true }, 1)).toMatchObject({ title: "דרך המלכים כרך א'", volume: null })
    // not set: the marker still counts
    expect(toExternalItem({ ...r, volume: null, volumeCount: null, volumeSet: false }, 1).volume).toEqual({ number: 1, count: null })
  })
  it('drops a count below the volume, and takes the count out of the volume text', () => {
    const low = parseShelfAnswer('[{"title":"x","volume":"3","volume_count":"2"}]')
    expect(low.ok && low.value.rows[0]).toMatchObject({ volume: 3, volumeCount: null })
    const inline = parseShelfAnswer('[{"title":"x","volume":"2 of 3"}]')
    expect(inline.ok && inline.value.rows[0]).toMatchObject({ volume: 2, volumeCount: 3 })
  })
  it('two volumes of one book on a shelf are not repeats', () => {
    expect(sameShelfBook({ title: 'דרך המלכים', originalTitle: null, seriesNumber: null, volume: 1 }, { title: 'דרך המלכים', originalTitle: null, seriesNumber: null, volume: 2 })).toBe(false)
    expect(sameShelfBook({ title: 'דרך המלכים', originalTitle: null, seriesNumber: null, volume: 1 }, { title: 'דרך המלכים', originalTitle: null, seriesNumber: null, volume: 1 })).toBe(true)
  })
})

it('a strong match whose set lacks the volume is a new volume, even when a volume is in hand', () => {
  const volume = { number: 2, have: [1], size: 2 }
  expect(shelfStatus({ repeatOf: null, inInbox: null, top: { workId: 'w', title: 'דרך המלכים', score: 0.9, basis: 'title_author', hasPhysicalInHand: true, volume } })).toEqual({ kind: 'new_volume', workId: 'w', title: 'דרך המלכים', volume })
  expect(shelfStatus({ repeatOf: null, inInbox: null, top: { workId: 'w', title: 'x', score: 0.4, basis: 'title_author', hasPhysicalInHand: false, volume } }).kind).toBe('maybe')
})

describe('toExternalItem importedTitle', () => {
  const r = { title: 'Henry IV, Part 1', subtitle: null, authors: ['Shakespeare'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'en', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume: null, volumeCount: null, volumeSet: false }
  it('remembers the title as printed, and "not a volume" keeps it', () => {
    expect(toExternalItem(r, 1)).toMatchObject({ title: 'Henry IV', volume: { number: 1, count: null }, importedTitle: { title: 'Henry IV, Part 1', subtitle: null } })
    expect(toExternalItem({ ...r, volumeSet: true }, 1)).toMatchObject({ title: 'Henry IV, Part 1', volume: null })
  })
  it('has none when nothing was stripped', () => {
    expect(toExternalItem({ ...r, title: 'Henry IV' }, 1).importedTitle).toBeNull()
  })
})

describe('Hardcover links and prefill', () => {
  it('a photo link may point at Hardcover', () => {
    expect(PhotoLink.parse({ provider: 'hardcover', providerId: '474572', url: 'https://hardcover.app/books/worm-parahumans', year: '2013', title: 'Worm' }).provider).toBe('hardcover')
  })
  it('prefills with the ISBN, else title and first author', () => {
    const seed = { title: 'Worm', subtitle: null, series: null, authors: ['Wildbow'], spineText: null }
    expect(prefillQuery(seed)).toBe('Worm Wildbow')
    expect(prefillQuery({ ...seed, isbn: '9780000000002' })).toBe('9780000000002')
  })
})
