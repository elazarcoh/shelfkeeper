import { describe, expect, it, vi } from 'vitest'
import { bulkCreateSummary, csvCandidateResolutions, csvCreateLabel, csvReadSummary, drain, presetFirst, sameCopyResolution, sumCounts, withRemainingNote } from './resolution'

const E = '33333333-3333-4333-8333-333333333333'
const W = '11111111-1111-4111-8111-111111111111'

describe('inbox resolution helpers', () => {
  it('offers "this copy" only for a matched copy of the same format', () => {
    expect(sameCopyResolution({ basis: 'identifier', workId: W, edition: { id: E, format: 'audiobook' } }, 'audiobook')).toEqual({ action: 'link_edition', editionId: E })
    expect(sameCopyResolution({ basis: 'identifier', workId: W, edition: { id: E, format: 'physical' } }, 'audiobook')).toBeNull()
    expect(sameCopyResolution({ basis: 'title_author', workId: W, edition: null }, 'audiobook')).toBeNull()
  })
  it('summarizes a bulk create', () => {
    expect(bulkCreateSummary({ created: 2, linked: 1, wanted: 0, skipped: 0 })).toBe('Created 2 books, added 1 ebook edition')
    expect(bulkCreateSummary({ created: 1, linked: 0, wanted: 0, skipped: 3 })).toBe('Created 1 book, skipped 3 already handled')
    expect(bulkCreateSummary({ created: 0, linked: 0, wanted: 0, skipped: 0 })).toBe('Created 0 books')
  })
})

describe('drain', () => {
  it('repeats a chunked action while something remains and it keeps making progress', async () => {
    const replies = [
      { accepted: 100, remaining: 150 },
      { accepted: 100, remaining: 50 },
      { accepted: 50, remaining: 0 },
    ]
    const step = vi.fn(() => Promise.resolve(replies.shift() ?? { accepted: 0, remaining: 0 }))
    expect(await drain(step, (r) => r.accepted > 0)).toHaveLength(3)
    expect(step).toHaveBeenCalledTimes(3)
  })
  it('stops when a round makes no progress (items someone must look at)', async () => {
    const step = vi.fn(() => Promise.resolve({ accepted: 0, remaining: 5 }))
    expect(await drain(step, (r) => r.accepted > 0)).toHaveLength(1)
  })
})

describe('bulkCreateSummary', () => {
  it('mentions wanted books', () => {
    expect(bulkCreateSummary({ created: 2, linked: 0, wanted: 3, skipped: 0 })).toBe('Created 2 books, added 3 wanted books')
  })
})

describe('sumCounts', () => {
  it('adds up the rounds', () => {
    expect(sumCounts([{ created: 1, linked: 2, wanted: 0, skipped: 0, remaining: 5 }, { created: 3, linked: 0, wanted: 1, skipped: 1, remaining: 0 }])).toEqual({ created: 4, linked: 2, wanted: 1, skipped: 1 })
  })
})

describe('withRemainingNote', () => {
  it('says more remain when draining stopped short (round cap or a stalled chunk)', () => {
    expect(withRemainingNote('Linked 100 exact matches', 50)).toBe('Linked 100 exact matches — 50 still waiting, run it again')
  })
  it('leaves the message alone once nothing remains', () => {
    expect(withRemainingNote('Linked 3 exact matches', 0)).toBe('Linked 3 exact matches')
  })
})

describe('csv proposals', () => {
  const candidate = (edition: { id: string; format: 'physical' | 'ebook' } | null) => ({ basis: 'identifier' as const, workId: 'a1111111-1111-4111-8111-111111111111', edition, volume: null })

  it('offers "just record my read", "add my copy", and "it is this copy" for a same-format copy', () => {
    expect(csvCandidateResolutions(candidate({ id: 'b2222222-2222-4222-8222-222222222222', format: 'physical' }), 'physical')).toEqual([
      { label: 'It’s my copy', resolution: { action: 'link_edition', editionId: 'b2222222-2222-4222-8222-222222222222' } },
      { label: 'Just record my read', resolution: { action: 'track_only', workId: 'a1111111-1111-4111-8111-111111111111' } },
      { label: 'Add my copy to this book', resolution: { action: 'link_new_edition', workId: 'a1111111-1111-4111-8111-111111111111' } },
    ])
    expect(csvCandidateResolutions(candidate({ id: 'b2222222-2222-4222-8222-222222222222', format: 'ebook' }), 'physical').map((o) => o.resolution.action)).toEqual(['track_only', 'link_new_edition'])
  })

  it('never offers "just record my read" for a book from a shelf photo', () => {
    const offered = csvCandidateResolutions(candidate({ id: 'b2222222-2222-4222-8222-222222222222', format: 'physical' }), 'physical', null, true)
    expect(offered.map((o) => o.resolution.action)).toEqual(['link_edition', 'link_new_edition'])
  })

  it('summarises the read and the rating', () => {
    expect(csvReadSummary({ read: { finishedOn: '2023-05-14', finishedPrecision: 'day' }, rating: 4.5 })).toBe('Read 2023-05-14 · ★ 4.5')
    expect(csvReadSummary({ read: { finishedOn: '2019-03-01', finishedPrecision: 'month' }, rating: null })).toBe('Read 2019-03')
    expect(csvReadSummary({ read: { finishedOn: '2020-01-01', finishedPrecision: 'year' }, rating: null })).toBe('Read 2020')
    expect(csvReadSummary({ read: null, rating: null })).toBe('')
  })

  it('shows the shelf when the file gives one', () => {
    expect(csvReadSummary({ read: null, rating: null, shelf: 'want' })).toBe('Want to read')
    expect(csvReadSummary({ read: null, rating: 3, shelf: 'reading' })).toBe('Reading · ★ 3')
    expect(csvReadSummary({ read: null, rating: null, shelf: 'read' })).toBe('Read')
    expect(csvReadSummary({ read: { finishedOn: '2023-05-14', finishedPrecision: 'day' }, rating: null, shelf: 'read' })).toBe('Read 2023-05-14')
  })

  it('offers only "add to my want-to-read" for a to-read row — never a copy', () => {
    const offered = csvCandidateResolutions(candidate({ id: 'b2222222-2222-4222-8222-222222222222', format: 'physical' }), 'physical', 'want')
    expect(offered).toEqual([{ label: 'Add to my want-to-read', resolution: { action: 'track_only', workId: 'a1111111-1111-4111-8111-111111111111' } }])
    expect(csvCreateLabel('want')).toBe('Add to my want-to-read')
    expect(csvCreateLabel('read')).toBe('Create new book')
    expect(csvCreateLabel(null)).toBe('Create new book')
  })

  it('presetFirst moves the review’s chosen book to the front', () => {
    const c = [{ workId: 'a' }, { workId: 'b' }, { workId: 'c' }]
    expect(presetFirst(c, { workId: 'b' }).map((x) => x.workId)).toEqual(['b', 'a', 'c'])
    expect(presetFirst(c, null)).toBe(c)
    expect(presetFirst(c, { workId: 'zz' }).map((x) => x.workId)).toEqual(['a', 'b', 'c'])
  })
})

describe('a candidate that is another volume', () => {
  const c = { workId: W, edition: null, volume: { number: 2 } }
  it('can only be added as that volume', () => {
    expect(csvCandidateResolutions(c, 'physical').map((o) => o.label)).toEqual(['Add as volume 2', 'Just record my read'])
    expect(csvCandidateResolutions(c, 'physical')[0]?.resolution).toEqual({ action: 'link_new_edition', workId: W })
    expect(csvCandidateResolutions(c, 'physical', null, true).map((o) => o.label)).toEqual(['Add as volume 2'])
    expect(csvCandidateResolutions(c, 'physical', 'want').map((o) => o.label)).toEqual(['Add to my want-to-read'])
  })
})
