import { describe, expect, it } from 'vitest'
import { seriesActionModel, type SeriesActionInput, type SeriesEntryLike } from './series-action-model'

const entry = (id: string, position: number, over: Partial<SeriesEntryLike> = {}): SeriesEntryLike => ({
  id,
  title: `Book ${id}`,
  position,
  status: 'none',
  inQueue: false,
  formats: ['physical'],
  ...over,
})

const base: SeriesActionInput = {
  entries: [entry('a', 1), entry('b', 2)],
  entriesFailed: false,
  entryIds: ['a', 'b'],
  editableSets: [],
  membership: [],
  continuationHidden: false,
}
const model = (over: Partial<SeriesActionInput> = {}) => {
  const input = { ...base, ...over }
  // entryIds follow the entries unless a test says otherwise
  return seriesActionModel({ ...input, entryIds: 'entryIds' in over ? over.entryIds : input.entries?.map((e) => e.id) })
}

describe('seriesActionModel — Up next', () => {
  it('offers the first unread book by position', () => {
    const m = model({ entries: [entry('b', 2), entry('a', 1)] })
    expect(m.main[0]).toEqual({ kind: 'queue', id: 'queue', label: 'Add “Book a” to Up next', workId: 'a' })
  })

  it('skips read and reading books', () => {
    const m = model({ entries: [entry('a', 1, { status: 'read' }), entry('b', 2, { status: 'reading' }), entry('c', 3)] })
    expect(m.main[0]).toMatchObject({ kind: 'queue', workId: 'c', label: 'Add “Book c” to Up next' })
  })

  it('is a disabled note when that book is already in Up next', () => {
    const m = model({ entries: [entry('a', 1, { inQueue: true }), entry('b', 2)] })
    expect(m.main[0]).toEqual({ kind: 'info', id: 'queue', label: '“Book a” is in Up next' })
  })

  it('says Nothing unread when every book is read or being read', () => {
    const m = model({ entries: [entry('a', 1, { status: 'read' }), entry('b', 2, { status: 'reading' })] })
    expect(m.main[0]).toEqual({ kind: 'info', id: 'queue', label: 'Nothing unread' })
  })
})

describe('seriesActionModel — Mark all as read', () => {
  it('counts books that are neither read nor reading', () => {
    const m = model({
      entries: [entry('a', 1, { status: 'read' }), entry('b', 2, { status: 'reading' }), entry('c', 3), entry('d', 4, { status: 'want_to_read' })],
    })
    expect(m.main[1]).toEqual({
      kind: 'markAll',
      id: 'markAll',
      label: 'Mark all as read (2)',
      targets: [
        { workId: 'c', mode: 'read', previous: 'none' },
        { workId: 'd', mode: 'read', previous: 'want_to_read' },
      ],
    })
  })

  it('is a disabled All read when there is nothing to mark', () => {
    const m = model({ entries: [entry('a', 1, { status: 'read' }), entry('b', 2, { status: 'reading' })] })
    expect(m.main[1]).toEqual({ kind: 'info', id: 'markAll', label: 'All read' })
  })

  it('marks an audiobook-only book as listened, one with a physical or ebook edition, or none, as read', () => {
    const m = model({
      entries: [entry('a', 1, { formats: ['audiobook'] }), entry('b', 2, { formats: ['audiobook', 'ebook'] }), entry('c', 3, { formats: [] })],
    })
    const action = m.main[1]
    expect(action?.kind === 'markAll' ? action.targets.map((t) => t.mode) : []).toEqual(['listen', 'read', 'read'])
  })
})

describe('seriesActionModel — loading', () => {
  it('shows one Loading item in place of both actions while entries load', () => {
    expect(model({ entries: undefined }).main).toEqual([{ kind: 'loading', id: 'loading', label: 'Loading…' }])
  })

  it('says so when the entries failed', () => {
    expect(model({ entries: undefined, entriesFailed: true }).main).toEqual([{ kind: 'loading', id: 'loading', label: 'Couldn’t load series' }])
  })
})

describe('seriesActionModel — sets', () => {
  const sets = [
    { id: 's1', name: 'Beach' },
    { id: 's2', name: 'Kids' },
  ]
  it('is null with no editable sets', () => {
    expect(model({ editableSets: [] }).sets).toBeNull()
  })

  it('is loading until sets and membership arrive', () => {
    expect(model({ editableSets: undefined }).sets).toBe('loading')
    expect(model({ editableSets: sets, membership: undefined }).sets).toBe('loading')
  })

  it('checks a set only when every entry is in it', () => {
    const m = model({
      editableSets: sets,
      membership: [
        { setId: 's1', workId: 'a' },
        { setId: 's1', workId: 'b' },
        { setId: 's2', workId: 'a' },
      ],
    })
    expect(m.sets).toEqual([
      { kind: 'set', id: 'set:s1', label: 'Beach', setId: 's1', checked: true },
      { kind: 'set', id: 'set:s2', label: 'Kids', setId: 's2', checked: false },
    ])
  })

  it('does not check a set for an empty series', () => {
    const m = model({ entries: [], editableSets: sets, membership: [] })
    expect(m.sets).toMatchObject([{ checked: false }, { checked: false }])
  })

  it('keeps its checkmarks while entries refetch, but is loading before the ids are known', () => {
    const membership = [
      { setId: 's1', workId: 'a' },
      { setId: 's1', workId: 'b' },
    ]
    expect(model({ entries: undefined, entryIds: ['a', 'b'], editableSets: sets, membership }).sets).toMatchObject([{ checked: true }, { checked: false }])
    expect(model({ entries: undefined, entryIds: undefined, editableSets: sets, membership }).sets).toBe('loading')
  })
})

describe('seriesActionModel — Series continuation', () => {
  it('offers to hide the series, or to show a hidden one again', () => {
    expect(model().main[2]).toEqual({ kind: 'continuation', id: 'continuation', label: 'Hide from Series continuation', hidden: true })
    expect(model({ continuationHidden: true }).main[2]).toEqual({
      kind: 'continuation',
      id: 'continuation',
      label: 'Show in Series continuation',
      hidden: false,
    })
  })

  it('is a disabled note while the hidden series load', () => {
    expect(model({ continuationHidden: undefined }).main[2]).toEqual({ kind: 'info', id: 'continuation', label: 'Loading…' })
  })
})

describe('seriesActionModel — Mark series as…', () => {
  it('offers the three kinds, even while the books load', () => {
    for (const m of [model(), model({ entries: undefined })]) {
      expect(m.markAs.label).toBe('Mark series as…')
      expect(m.markAs.options.map((o) => [o.workKind, o.label])).toEqual([
        ['book', 'Book'],
        ['fanfiction', 'Fanfiction'],
        ['web_serial', 'Web serial'],
      ])
    }
  })
})
