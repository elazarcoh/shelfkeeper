import { describe, expect, it } from 'vitest'
import { describePastSession, markLabel, markableModes, pastFinish, type PastFinishFields } from './mark-finished'

const physical = { format: 'physical' as const }
const ebook = { format: 'ebook' as const }
const audiobook = { format: 'audiobook' as const }

describe('markableModes', () => {
  it('follows the edition formats: audiobook → listened, physical or ebook → read, both when both exist', () => {
    expect(markableModes([audiobook], new Set())).toEqual(['listen'])
    expect(markableModes([physical], new Set())).toEqual(['read'])
    expect(markableModes([ebook, physical], new Set())).toEqual(['read'])
    expect(markableModes([physical, audiobook], new Set())).toEqual(['read', 'listen'])
  })
  it('offers "read" for a book with no edition yet', () => {
    expect(markableModes([], new Set())).toEqual(['read'])
  })
  it('leaves out a mode with a session in progress', () => {
    expect(markableModes([physical, audiobook], new Set(['listen'] as const))).toEqual(['read'])
    expect(markableModes([audiobook], new Set(['listen'] as const))).toEqual([])
    expect(markableModes([], new Set(['read'] as const))).toEqual([])
  })
})

describe('markLabel', () => {
  it('names the mode', () => {
    expect(markLabel('read')).toBe('Mark as read…')
    expect(markLabel('listen')).toBe('Mark as listened…')
  })
})

describe('pastFinish', () => {
  const today = '2026-10-07'
  const fields: PastFinishFields = { year: '2019', month: '2026-10', day: '2026-10-07' }

  it('"long ago / don\'t remember" is an unknown date, stored with today', () => {
    expect(pastFinish('unknown', fields, today)).toEqual({ ok: true, finishedOn: today, finishedPrecision: 'unknown' })
  })
  it('a year is its first day, precision year', () => {
    expect(pastFinish('year', fields, today)).toEqual({ ok: true, finishedOn: '2019-01-01', finishedPrecision: 'year' })
  })
  it('a month is its first day, precision month', () => {
    expect(pastFinish('month', { ...fields, month: '2021-03' }, today)).toEqual({ ok: true, finishedOn: '2021-03-01', finishedPrecision: 'month' })
  })
  it('an exact date is that day', () => {
    expect(pastFinish('day', { ...fields, day: '2024-02-29' }, today)).toEqual({ ok: true, finishedOn: '2024-02-29', finishedPrecision: 'day' })
  })
  it('refuses an empty or future pick, with a message', () => {
    expect(pastFinish('day', { ...fields, day: '' }, today)).toEqual({ ok: false, message: 'Pick the day you finished' })
    expect(pastFinish('day', { ...fields, day: '2026-10-08' }, today)).toEqual({ ok: false, message: 'That date is in the future' })
    expect(pastFinish('month', { ...fields, month: '' }, today)).toEqual({ ok: false, message: 'Pick the month you finished' })
    expect(pastFinish('month', { ...fields, month: '2026-11' }, today)).toEqual({ ok: false, message: 'That month is in the future' })
    expect(pastFinish('year', { ...fields, year: '2027' }, today)).toEqual({ ok: false, message: 'That year is in the future' })
    expect(pastFinish('year', { ...fields, year: '' }, today)).toEqual({ ok: false, message: 'Pick the year you finished' })
  })
})

describe('describePastSession', () => {
  const base = { outcome: 'finished' as const, startedOn: '2026-03-01', startedPrecision: 'day' as const, finishedOn: '2026-03-05', finishedPrecision: 'day' as const }

  it('shows exact dates as before', () => {
    expect(describePastSession(base)).toEqual({ dates: '2026-03-01 → 2026-03-05', outcome: 'Finished' })
  })
  it('says "date unknown" instead of a date for an unknown finish', () => {
    const longAgo = { ...base, startedOn: '2026-10-07', startedPrecision: 'unknown' as const, finishedOn: '2026-10-07', finishedPrecision: 'unknown' as const }
    expect(describePastSession(longAgo)).toEqual({ dates: null, outcome: 'Finished, date unknown' })
    expect(describePastSession({ ...longAgo, outcome: 'abandoned' })).toEqual({ dates: null, outcome: 'Set aside, date unknown' })
  })
  it('keeps a known start beside an unknown finish', () => {
    expect(describePastSession({ ...base, startedOn: '2024-03-01', startedPrecision: 'month', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })).toEqual({
      dates: null,
      outcome: 'Started 2024-03 · finished, date unknown',
    })
    expect(describePastSession({ ...base, outcome: 'abandoned', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })).toEqual({
      dates: null,
      outcome: 'Started 2026-03-01 · set aside, date unknown',
    })
  })
  it('shows an exact-date past read (unknown start) as "? → day"', () => {
    expect(describePastSession({ ...base, startedOn: '2024-02-29', startedPrecision: 'unknown', finishedOn: '2024-02-29' })).toEqual({
      dates: '? → 2024-02-29',
      outcome: 'Finished',
    })
  })
  it('shows a past read in a year or a month once, at its precision', () => {
    const year = { ...base, startedOn: '2019-01-01', startedPrecision: 'year' as const, finishedOn: '2019-01-01', finishedPrecision: 'year' as const }
    expect(describePastSession(year)).toEqual({ dates: '2019', outcome: 'Finished' })
    const month = { ...base, startedOn: '2021-03-01', startedPrecision: 'month' as const, finishedOn: '2021-03-01', finishedPrecision: 'month' as const }
    expect(describePastSession(month)).toEqual({ dates: '2021-03', outcome: 'Finished' })
  })
  it('formats each end at its own precision, "?" for an unknown start', () => {
    expect(describePastSession({ ...base, startedPrecision: 'unknown', finishedOn: '2026-04-01', finishedPrecision: 'month' })).toEqual({
      dates: '? → 2026-04',
      outcome: 'Finished',
    })
  })
  it('a session without a finish shows its start', () => {
    expect(describePastSession({ ...base, outcome: 'in_progress', finishedOn: null, finishedPrecision: null })).toEqual({ dates: '2026-03-01 → ?', outcome: 'In progress' })
  })
})
