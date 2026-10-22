import { describe, expect, it } from 'vitest'
import { bookFraction, type SessionProgressInfo } from '@mylib/domain'
import {
  abandonChoiceAllowed,
  abandonNote,
  dayLabel,
  describeLatest,
  formatClock,
  infoForVolume,
  initialDraft,
  initialVolume,
  lowerThanLatestNote,
  offeredKinds,
  parseClock,
  pointLabel,
  pointName,
  progressDayBounds,
  readDraft,
  resolveAbandon,
  selectedAbandonChoice,
  stillGoingLabel,
  whereIStopped,
  volumeOptions,
  type ParsedDraft,
} from './progress-draft'

const SESSION = '71111111-1111-4111-8111-000000000001'
const info = (more: Partial<SessionProgressInfo> = {}): SessionProgressInfo => ({ editionFormat: 'physical', pageCount: 600, durationSec: null, latest: null, pointCount: 0, highest: null, volume: null, ...more })
const point = (on: string) => ({ id: SESSION, sessionId: SESSION, on, kind: 'page' as const, value: 180, fraction: 0.3, editionId: null, volume: null })

describe('progress draft', () => {
  it('starts on the kind that fits the edition (or the last one used)', () => {
    expect(initialDraft(info()).kind).toBe('page')
    expect(initialDraft(info({ editionFormat: 'audiobook', durationSec: 3600 })).kind).toBe('seconds')
    expect(initialDraft(info({ editionFormat: 'ebook', pageCount: null })).kind).toBe('percent')
    expect(initialDraft(info({ editionFormat: null })).kind).toBe('percent')
    expect(initialDraft(info({ editionFormat: 'ebook', latest: { ...point('2026-10-01'), kind: 'percent', value: 40 } })).kind).toBe('percent')
    // #31: an audiobook whose last update was a percentage keeps the % toggle
    expect(initialDraft(info({ editionFormat: 'audiobook', latest: { ...point('2026-10-01'), kind: 'percent', value: 40 } })).kind).toBe('percent')
  })

  it('reads h:mm and h:mm:ss times', () => {
    expect(parseClock('5:30')).toBe(19_800)
    expect(parseClock(' 12:05:09 ')).toBe(43_509)
    expect(parseClock('5')).toBeNull()
    expect(parseClock('5:75')).toBeNull()
    expect(formatClock(43_509)).toBe('12:05:09')
  })

  it('an empty field is no point at all — Still going behaves as before', () => {
    const parsed = readDraft({ kind: 'page', value: '  ', length: '' }, info())
    expect(parsed).toEqual({ ok: true, point: null })
    expect(stillGoingLabel(parsed)).toBe('Still going')
  })

  it('reads a page, a percentage and a time, and labels Still going with it', () => {
    const page = readDraft({ kind: 'page', value: '560', length: '' }, info())
    expect(page).toEqual({ ok: true, point: { kind: 'page', value: 560 } })
    expect(stillGoingLabel(page)).toBe('Still going · p. 560')
    expect(readDraft({ kind: 'percent', value: '45%', length: '' }, info({ editionFormat: 'ebook' }))).toEqual({ ok: true, point: { kind: 'percent', value: 45 } })
    expect(readDraft({ kind: 'seconds', value: '5:30', length: '' }, info({ editionFormat: 'audiobook', durationSec: 36_000 }))).toEqual({
      ok: true,
      point: { kind: 'seconds', value: 19_800 },
    })
  })

  it('explains values it cannot read', () => {
    expect(readDraft({ kind: 'page', value: '12a', length: '' }, info())).toMatchObject({ ok: false, field: 'value' })
    expect(readDraft({ kind: 'percent', value: '101', length: '' }, info({ editionFormat: 'ebook' }))).toMatchObject({ ok: false, field: 'value' })
    expect(readDraft({ kind: 'seconds', value: '90', length: '' }, info({ editionFormat: 'audiobook' }))).toMatchObject({ ok: false, field: 'value' })
  })

  it('sends the one-time length only when the edition lacks it', () => {
    expect(readDraft({ kind: 'page', value: '120', length: '300' }, info({ pageCount: null }))).toEqual({ ok: true, point: { kind: 'page', value: 120, editionLength: 300 } })
    expect(readDraft({ kind: 'page', value: '120', length: '300' }, info())).toEqual({ ok: true, point: { kind: 'page', value: 120 } })
    expect(readDraft({ kind: 'seconds', value: '1:00', length: '9:45' }, info({ editionFormat: 'audiobook' }))).toEqual({
      ok: true,
      point: { kind: 'seconds', value: 3600, editionLength: 35_100 },
    })
    expect(readDraft({ kind: 'page', value: '120', length: 'lots' }, info({ pageCount: null }))).toMatchObject({ ok: false, field: 'length' })
    expect(readDraft({ kind: 'page', value: '120', length: '300' }, info({ pageCount: null }), false)).toEqual({ ok: true, point: { kind: 'page', value: 120 } })
  })

  it('describes the last update in plain words', () => {
    // 2026-10-06 is a Tuesday
    expect(describeLatest(point('2026-10-06'), '2026-10-06')).toBe('last: p. 180, today')
    expect(describeLatest(point('2026-10-04'), '2026-10-06')).toBe('last: p. 180, Sun')
    expect(describeLatest(point('2026-09-20'), '2026-10-06')).toBe('last: p. 180, Sep 20')
    expect(pointLabel('percent', 37.5)).toBe('37.5%')
    expect(pointLabel('seconds', 8100)).toBe('2:15:00')
  })
})

describe('a value past the end of the book', () => {
  it('refuses a page past a known page count, pointing at the book page; the last page is fine', () => {
    const parsed = readDraft({ kind: 'page', value: '1200', length: '' }, info({ pageCount: 300 }))
    expect(parsed).toEqual({ ok: false, field: 'value', error: 'This edition has 300 pages. If yours has more, update the page count on the book page.' })
    expect(readDraft({ kind: 'page', value: '300', length: '' }, info({ pageCount: 300 }))).toEqual({ ok: true, point: { kind: 'page', value: 300 } })
  })

  it('refuses a time past a known length; the full length is fine', () => {
    const audio = info({ editionFormat: 'audiobook', pageCount: null, durationSec: 35_100 })
    const past = readDraft({ kind: 'seconds', value: '9:45:01', length: '' }, audio)
    expect(past).toMatchObject({ ok: false, field: 'value' })
    expect(past.ok ? '' : past.error).toMatch(/^This edition is 9:45:00 long\./)
    expect(readDraft({ kind: 'seconds', value: '9:45', length: '' }, audio)).toEqual({ ok: true, point: { kind: 'seconds', value: 35_100 } })
  })

  it('checks against the one-time length answer too', () => {
    const parsed = readDraft({ kind: 'page', value: '1200', length: '300' }, info({ pageCount: null }))
    expect(parsed).toMatchObject({ ok: false, field: 'value' })
    expect(parsed.ok ? '' : parsed.error).toBe('That is past the end: you said it has 300 pages. Check both numbers.')
  })

  it('checks an edited point against the edition length as well', () => {
    expect(readDraft({ kind: 'page', value: '301', length: '' }, info({ pageCount: 300 }), false)).toMatchObject({ ok: false, field: 'value' })
  })

  it('changes nothing while the length is unknown', () => {
    expect(readDraft({ kind: 'page', value: '5000', length: '' }, info({ pageCount: null }))).toEqual({ ok: true, point: { kind: 'page', value: 5000 } })
    expect(readDraft({ kind: 'seconds', value: '99:00', length: '' }, info({ editionFormat: 'audiobook', durationSec: null }))).toMatchObject({ ok: true })
  })
})

describe('lower than the latest update (a soft note)', () => {
  const latest180 = info({ pageCount: 600, latest: point('2026-10-04') })
  const typed = (value: string, at = latest180) => lowerThanLatestNote(readDraft({ kind: 'page', value, length: '' }, at), at)

  it('notes a value below the latest point, without blocking it', () => {
    // RP5: a lower point never undoes a wrong high one, so the note points at the real fix
    expect(typed('150')).toBe('Lower than your last update (p. 180). If that one was a typo, edit it on the book page.')
    expect(readDraft({ kind: 'page', value: '150', length: '' }, latest180)).toMatchObject({ ok: true })
  })

  it('says nothing for the same or a higher value, an empty field, an unreadable one, or no earlier point', () => {
    expect(typed('180')).toBeNull()
    expect(typed('200')).toBeNull()
    expect(typed('')).toBeNull()
    expect(typed('12a')).toBeNull()
    expect(typed('150', info({ pageCount: 600 }))).toBeNull()
  })

  it('compares fractions across kinds when both are known', () => {
    const ebook = info({ editionFormat: 'ebook', pageCount: 600, latest: point('2026-10-04') })
    expect(lowerThanLatestNote(readDraft({ kind: 'percent', value: '20', length: '' }, ebook), ebook)).toMatch(/^Lower than your last update \(p\. 180\)/)
    expect(lowerThanLatestNote(readDraft({ kind: 'percent', value: '40', length: '' }, ebook), ebook)).toBeNull()
  })
})

describe('round-1 parsing details', () => {
  it('a page starts at 1', () => {
    expect(readDraft({ kind: 'page', value: '0', length: '' }, info())).toMatchObject({ ok: false, field: 'value' })
    expect(readDraft({ kind: 'page', value: '1', length: '' }, info())).toEqual({ ok: true, point: { kind: 'page', value: 1 } })
  })

  it('refuses an audiobook length past the server limit with a plain sentence, not the server JSON', () => {
    const parsed = readDraft({ kind: 'seconds', value: '1:00', length: '300:00' }, info({ editionFormat: 'audiobook' }))
    expect(parsed).toMatchObject({ ok: false, field: 'length' })
    expect(parsed.ok ? '' : parsed.error).toMatch(/^[A-Z][^[{]*$/)
    expect(readDraft({ kind: 'seconds', value: '1:00', length: '277:46:40' }, info({ editionFormat: 'audiobook' }))).toMatchObject({ ok: true })
  })

  it('names days across a year boundary', () => {
    // 2026-01-01 is a Thursday, so 2025-12-30 is a Tuesday
    expect(dayLabel('2025-12-30', '2026-01-02')).toBe('Tue')
    expect(dayLabel('2025-12-20', '2026-01-02')).toBe('Dec 20, 2025')
    expect(dayLabel('2026-01-02', '2026-01-02')).toBe('today')
  })
})

const latest = (fraction: number | null) => ({ ...point('2026-10-04'), fraction })
const empty: ParsedDraft = { ok: true, point: null }

describe('abandon choice (resolved when Save is clicked, not when the card mounted)', () => {
  it('the untouched default is "where I stopped" when there is a latest fraction, else "Not sure" (null), as before', () => {
    const stopped = whereIStopped(empty, info({ latest: latest(0.3) }))
    expect(stopped).toEqual({ kind: 'page', value: 180, fraction: 0.3, save: null })
    expect(selectedAbandonChoice('default', stopped, null)).toBe('stopped')
    expect(resolveAbandon('default', stopped, null)).toEqual({ fractionCompleted: 0.3, save: null })
    expect(whereIStopped(empty, info())).toBeNull()
    expect(selectedAbandonChoice('default', null, null)).toBe('unsure')
    expect(resolveAbandon('default', null, null)).toEqual({ fractionCompleted: null, save: null })
  })

  it('a saved point without a fraction (no edition length) is not offered', () => {
    expect(whereIStopped(empty, info({ pageCount: null, latest: latest(null) }))).toBeNull()
  })

  it('picks up a point added after the card mounted', () => {
    // mounted with no progress: Not sure; a point from the book page arrives before Save
    expect(resolveAbandon('default', whereIStopped(empty, info()), null).fractionCompleted).toBeNull()
    expect(resolveAbandon('default', whereIStopped(empty, info({ latest: latest(0.55) })), null).fractionCompleted).toBe(0.55)
  })

  it('keeps an explicit choice', () => {
    const stopped = whereIStopped(empty, info({ latest: latest(0.3) }))
    expect(resolveAbandon('unsure', stopped, null)).toEqual({ fractionCompleted: null, save: null })
    expect(selectedAbandonChoice('unsure', stopped, null)).toBe('unsure')
    expect(resolveAbandon(0.75, stopped, null)).toEqual({ fractionCompleted: 0.75, save: null })
    expect(selectedAbandonChoice(0.5, stopped, null)).toBe(0.5)
    expect(resolveAbandon('stopped', stopped, null).fractionCompleted).toBe(0.3)
  })

  it('"where I stopped" without a point left (it was removed) falls back to Not sure', () => {
    expect(selectedAbandonChoice('stopped', null, null)).toBe('unsure')
    expect(resolveAbandon('stopped', null, null)).toEqual({ fractionCompleted: null, save: null })
  })
})

describe('abandon choice with a typed value', () => {
  it('a typed page is where I stopped: it is saved, and the abandon uses its fraction', () => {
    const typed = readDraft({ kind: 'page', value: '200', length: '' }, info({ pageCount: 400, latest: latest(0.3) }))
    const stopped = whereIStopped(typed, info({ pageCount: 400, latest: latest(0.3) }))
    expect(stopped).toEqual({ kind: 'page', value: 200, fraction: 0.5, save: { kind: 'page', value: 200 } })
    expect(selectedAbandonChoice('default', stopped, null)).toBe('stopped')
    expect(resolveAbandon('default', stopped, null)).toEqual({ fractionCompleted: 0.5, save: { kind: 'page', value: 200 } })
  })

  it('the one-time length answer gives the typed point its fraction and is saved with it', () => {
    const noLength = info({ pageCount: null })
    const stopped = whereIStopped(readDraft({ kind: 'page', value: '120', length: '300' }, noLength), noLength)
    expect(stopped).toEqual({ kind: 'page', value: 120, fraction: 0.4, save: { kind: 'page', value: 120, editionLength: 300 } })
    const audio = info({ editionFormat: 'audiobook', pageCount: null, durationSec: 36_000 })
    expect(whereIStopped(readDraft({ kind: 'seconds', value: '5:00', length: '' }, audio), audio)?.fraction).toBe(0.5)
  })

  it('#8: without any length the typed point is not a choice, but it is still saved with whatever is picked', () => {
    const noLength = info({ pageCount: null })
    const stopped = whereIStopped(readDraft({ kind: 'page', value: '120', length: '' }, noLength), noLength)
    expect(stopped).toEqual({ kind: 'page', value: 120, fraction: null, save: { kind: 'page', value: 120 } })
    expect(abandonChoiceAllowed('stopped', stopped, null)).toBe(false)
    expect(selectedAbandonChoice('default', stopped, null)).toBe('unsure')
    expect(selectedAbandonChoice('stopped', stopped, null)).toBe('unsure')
    expect(resolveAbandon('default', stopped, null)).toEqual({ fractionCompleted: null, save: { kind: 'page', value: 120 } })
    expect(resolveAbandon(0.25, stopped, null)).toEqual({ fractionCompleted: 0.25, save: { kind: 'page', value: 120 } })
    expect(abandonNote(stopped, null, 0.25)).toBe("p. 120 is saved as an update, but without the book's length it can't say how far you got. Pick one.")
  })

  it('choosing ¼ or Not sure instead saves nothing', () => {
    const stopped = whereIStopped(readDraft({ kind: 'page', value: '200', length: '' }, info()), info())
    expect(resolveAbandon(0.25, stopped, null)).toEqual({ fractionCompleted: 0.25, save: null })
    expect(resolveAbandon('unsure', stopped, null)).toEqual({ fractionCompleted: null, save: null })
  })

  it('an unreadable typed value falls back to the saved point', () => {
    const bad = readDraft({ kind: 'page', value: '12a', length: '' }, info())
    expect(whereIStopped(bad, info({ latest: latest(0.3) }))?.save).toBeNull()
  })
})

describe('abandon choice below the high-water mark (#7, option C)', () => {
  it('turns off the choices below the highest point, and says why', () => {
    const stopped = whereIStopped(empty, info({ latest: latest(0.3), highest: 0.6 }))
    expect(abandonChoiceAllowed(0.25, stopped, 0.6)).toBe(false)
    expect(abandonChoiceAllowed(0.5, stopped, 0.6)).toBe(false)
    expect(abandonChoiceAllowed(0.75, stopped, 0.6)).toBe(true)
    // the latest point is lower than an earlier one: "where I stopped" would say less than was read
    expect(abandonChoiceAllowed('stopped', stopped, 0.6)).toBe(false)
    expect(abandonNote(stopped, 0.6, 0.25)).toBe('You already got to 60%. To pick less, first edit that update on the book page.')
  })

  it('falls back to Not sure when the untouched default or an earlier choice is now below it', () => {
    const stopped = whereIStopped(empty, info({ latest: latest(0.3), highest: 0.6 }))
    expect(selectedAbandonChoice('default', stopped, 0.6)).toBe('unsure')
    expect(resolveAbandon(0.5, stopped, 0.6)).toEqual({ fractionCompleted: null, save: null })
    expect(resolveAbandon(0.75, stopped, 0.6)).toEqual({ fractionCompleted: 0.75, save: null })
  })

  it('"where I stopped" at the highest point is allowed, and no note shows when nothing is off', () => {
    const stopped = whereIStopped(empty, info({ latest: latest(0.6), highest: 0.6 }))
    expect(selectedAbandonChoice('default', stopped, 0.6)).toBe('stopped')
    expect(abandonNote(stopped, 0.2, 0.25)).toBeNull()
    expect(abandonNote(stopped, null, 0.25)).toBeNull()
  })
})

describe('book page progress points', () => {
  it('offers the kinds the edition allows', () => {
    expect(offeredKinds('physical')).toEqual(['page'])
    expect(offeredKinds('ebook')).toEqual(['page', 'percent'])
    expect(offeredKinds('audiobook')).toEqual(['seconds', 'percent'])
    expect(offeredKinds(null)).toEqual(['percent'])
  })

  it("an edited point also offers its own kind, even when its edition changed or is gone (RP11)", () => {
    // edition deleted: a page point stays a page
    expect(offeredKinds(null, 'page')).toEqual(['page', 'percent'])
    // audiobook point, edition now an ebook
    expect(offeredKinds('ebook', 'seconds')).toEqual(['seconds', 'page', 'percent'])
    // already allowed: no duplicate
    expect(offeredKinds('ebook', 'percent')).toEqual(['page', 'percent'])
  })

  it('names a point for its Edit and Remove buttons: value and day (RP3)', () => {
    // the same month-day order as the row's visible day ("Sep 20"), but always a date: a weekday or "today" is ambiguous out of context
    expect(pointName({ kind: 'page', value: 120, on: '2026-10-06' }, '2026-10-07')).toBe('p. 120 on Oct 6')
    expect(pointName({ kind: 'percent', value: 42.5, on: '2026-01-31' }, '2026-10-07')).toBe('42.5% on Jan 31')
    expect(pointName({ kind: 'seconds', value: 3725, on: '2025-12-30' }, '2026-10-07')).toBe('1:02:05 on Dec 30, 2025')
    expect(dayLabel('2025-12-30', '2026-10-07')).toBe('Dec 30, 2025')
  })

  it('a point can be dated from the start day through today, and not after a finished read ended', () => {
    const today = '2026-10-07'
    expect(progressDayBounds({ startedOn: '2026-09-14', startedPrecision: 'day', finishedOn: null, finishedPrecision: null }, today)).toEqual({
      min: '2026-09-14',
      max: today,
    })
    // an imprecise start counts from its earliest day; a finish month ends on its last day
    expect(progressDayBounds({ startedOn: '2026-05-01', startedPrecision: 'month', finishedOn: '2026-06-01', finishedPrecision: 'month' }, today)).toEqual({
      min: '2026-05-01',
      max: '2026-06-30',
    })
    // a finish range that runs past today is capped at today
    expect(progressDayBounds({ startedOn: '2026-01-01', startedPrecision: 'year', finishedOn: '2026-01-01', finishedPrecision: 'year' }, today)).toEqual({
      min: '2026-01-01',
      max: today,
    })
  })
})

describe('in a volume set', () => {
  const vol = (length: number) => ({ volume: null, pageCount: length, durationSec: null, wordCount: null })
  const set = info({
    pageCount: 600,
    volume: { volume: 2, size: 2, volumes: [{ ...vol(400), volume: 1 }, { ...vol(600), volume: 2 }], waiting: false },
  })

  it('reads a typed page as a fraction of the whole book', () => {
    const parsed = readDraft({ kind: 'page', value: '300', length: '' }, set)
    expect(whereIStopped(parsed, set)?.fraction).toBeCloseTo(0.7)
  })

  it('an abandon choice is judged against the book high-water mark', () => {
    const stopped = whereIStopped(readDraft({ kind: 'page', value: '300', length: '' }, set), set)
    expect(abandonChoiceAllowed(0.5, stopped, 0.4)).toBe(true)
  })
})

describe('a later volume against a book-fraction latest', () => {
  const vol = (volume: number, pageCount: number) => ({ volume, pageCount, durationSec: null, wordCount: null })
  const ctx = { volume: 2, size: 2, volumes: [vol(1, 400), vol(2, 600)], waiting: false }
  const lastOfVol1 = bookFraction('page', 400, { pageCount: 400, durationSec: null }, { ...ctx, volume: 1 })
  const second = info({
    pageCount: 600,
    volume: ctx,
    highest: lastOfVol1,
    latest: { ...point('2026-10-04'), kind: 'page', value: 400, fraction: lastOfVol1 },
  })

  it('derives the latest from the book fraction', () => {
    expect(lastOfVol1).toBeCloseTo(0.4)
  })

  it('page 10 of volume 2 is not lower than page 400 of volume 1, but page 100 of volume 1 would be', () => {
    expect(lowerThanLatestNote(readDraft({ kind: 'page', value: '10', length: '' }, second), second)).toBeNull()
    const back = info({ ...second, volume: { ...ctx, volume: 1 }, pageCount: 400 })
    expect(lowerThanLatestNote(readDraft({ kind: 'page', value: '100', length: '' }, back), back)).not.toBeNull()
  })

  it('an abandon at 0.5 is allowed above the 0.4 high-water mark, 0.3 is not', () => {
    const stopped = whereIStopped(readDraft({ kind: 'page', value: '10', length: '' }, second), second)
    expect(abandonChoiceAllowed('stopped', stopped, second.highest)).toBe(true)
    expect(abandonChoiceAllowed(0.3, stopped, second.highest)).toBe(false)
  })
})

describe('choosing the volume of a progress update (#69)', () => {
  const ed = (id: string, volume: number | null, over: Record<string, unknown> = {}) => ({
    id,
    format: 'physical' as const,
    language: 'he',
    volume,
    volumeCount: 2,
    pageCount: volume === 1 ? 400 : 600,
    durationSec: null,
    ...over,
  })
  const v1 = ed('e1', 1)
  const v2 = ed('e2', 2)

  it('offers the session set only when it has two or more editions', () => {
    expect(volumeOptions([v1, v2], 'e2')?.map((o) => [o.id, o.label])).toEqual([
      ['e1', 'Vol 1 of 2'],
      ['e2', 'Vol 2 of 2'],
    ])
    expect(volumeOptions([v1], 'e1')).toBeNull()
    expect(volumeOptions([ed('a', null), ed('b', null)], 'a')).toBeNull()
    expect(volumeOptions([v1, v2, ed('x', 1, { format: 'ebook' })], 'x')).toBeNull()
    expect(volumeOptions([v1, v2], null)).toBeNull()
  })

  it('defaults to the session volume for a new update and to the point own volume when editing', () => {
    const options = volumeOptions([v1, v2], 'e2') ?? []
    expect(initialVolume(options, 'e2')).toBe('e2')
    expect(initialVolume(options, 'e2', { ...point('2026-10-01'), editionId: 'e1' })).toBe('e1')
    // a point whose volume is gone: nothing is chosen, so saving keeps it as it is
    expect(initialVolume(options, 'e2', point('2026-10-01'))).toBe('')
  })

  it("reads the chosen volume's length", () => {
    const options = volumeOptions([v1, v2], 'e2') ?? []
    const base = info({ pageCount: 600, volume: { volume: 2, size: 2, volumes: [], waiting: false } })
    expect(infoForVolume(base, options, 'e1')).toMatchObject({ pageCount: 400, volume: { volume: 1 } })
    expect(infoForVolume(base, options, '')).toBe(base)
  })
})
