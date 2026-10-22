import { describe, expect, it } from 'vitest'
import { editableSets, quickActionModel, RATING_STEPS, type QuickActionInput } from './quick-action-model'

const base: QuickActionInput = {
  isAdmin: false,
  status: 'none',
  inQueue: false,
  rating: null,
  formats: ['physical'],
  inProgress: [],
  sessionsFailed: false,
  editableSets: [],
  memberSetIds: new Set(),
}
const labels = (input: Partial<QuickActionInput>) => quickActionModel({ ...base, ...input }).reading.map((a) => a.label)

describe('quickActionModel — reading group', () => {
  it('a physical book with nothing in progress offers start and mark, then Want to read', () => {
    expect(labels({})).toEqual(['Start reading', 'Mark as read', 'Want to read'])
  })

  it('a read in progress offers finish and set aside instead', () => {
    const m = quickActionModel({ ...base, status: 'reading', inProgress: [{ id: 's1', mode: 'read', editionId: null, volume: null }] })
    expect(m.reading).toEqual([
      { kind: 'finish', id: 'finish:read', label: 'Finish reading', sessionId: 's1' },
      { kind: 'setAside', id: 'setAside:read', label: 'Set aside', sessionId: 's1' },
    ])
  })

  describe('finishing a volume', () => {
    const on = (volume: { volume: number; size: number; waiting: boolean }) =>
      labels({ status: 'reading', inProgress: [{ id: 's1', mode: 'read', editionId: 'e1', volume }] })

    it('offers Finished volume k before finish while volumes remain', () => {
      expect(on({ volume: 1, size: 2, waiting: false }).slice(0, 3)).toEqual(['Finished volume 1', 'Finish reading', 'Set aside'])
    })

    it('does not offer it while waiting for the next volume', () => {
      expect(on({ volume: 1, size: 2, waiting: true })).not.toContain('Finished volume 1')
    })

    it('does not offer it on the last volume', () => {
      expect(on({ volume: 2, size: 2, waiting: false })).toEqual(['Finish reading', 'Set aside', 'Want to read'].slice(0, 2))
    })
  })

  it('an audiobook speaks of listening', () => {
    expect(labels({ formats: ['audiobook'] })).toEqual(['Start listening', 'Mark as listened', 'Want to read'])
  })

  it('a book with no edition is read', () => {
    expect(labels({ formats: [] })).toEqual(['Start reading', 'Mark as read', 'Want to read'])
  })

  it('print and audio: one pair per mode; two open sessions name which one is set aside', () => {
    expect(labels({ formats: ['ebook', 'audiobook'] })).toEqual(['Start reading', 'Mark as read', 'Start listening', 'Mark as listened', 'Want to read'])
    expect(
      labels({ status: 'reading', formats: ['ebook', 'audiobook'], inProgress: [{ id: 'a', mode: 'read', editionId: null, volume: null }, { id: 'b', mode: 'listen', editionId: null, volume: null }] }),
    ).toEqual(['Finish reading', 'Set aside (reading)', 'Finish listening', 'Set aside (listening)'])
  })

  it('a session open in a mode the editions no longer have is still offered', () => {
    expect(labels({ status: 'reading', formats: ['physical'], inProgress: [{ id: 'x', mode: 'listen', editionId: null, volume: null }] })).toEqual([
      'Start reading',
      'Mark as read',
      'Finish listening',
      'Set aside',
    ])
  })

  it('sessions loading: one disabled loading item, never a Start', () => {
    const m = quickActionModel({ ...base, inProgress: undefined })
    expect(m.reading).toEqual([
      { kind: 'loading', id: 'loading', label: 'Loading…' },
      { kind: 'status', id: 'status', label: 'Want to read', status: 'want_to_read' },
    ])
  })

  it('sessions failed to load: the loading item says so', () => {
    expect(labels({ inProgress: undefined, sessionsFailed: true })[0]).toBe('Couldn’t load reading')
  })

  it.each([
    ['none', 'Want to read'],
    ['read', 'Want to read'],
    ['abandoned', 'Want to read'],
    ['want_to_read', 'Remove from Want to read'],
    ['reading', null],
  ] as const)('status %s → %s', (status, label) => {
    const statusItem = quickActionModel({ ...base, status, inProgress: undefined }).reading.find((a) => a.kind === 'status')
    expect(statusItem?.label ?? null).toBe(label)
  })
})

describe('quickActionModel — queue, rating, sets', () => {
  it('queue toggles', () => {
    expect(quickActionModel(base).queue).toEqual({ kind: 'queue', id: 'queue', label: 'Add to Up next', add: true })
    expect(quickActionModel({ ...base, inQueue: true }).queue).toEqual({ kind: 'queue', id: 'queue', label: 'Remove from Up next', add: false })
  })

  it('clear rating only when rated, remembering the rating for Undo', () => {
    expect(quickActionModel(base).rating).toEqual({ value: null, clear: null })
    expect(quickActionModel({ ...base, rating: 3.5 }).rating).toEqual({
      value: 3.5,
      clear: { kind: 'clearRating', id: 'clearRating', label: 'Clear rating', previous: 3.5 },
    })
  })

  it('sets: hidden when none are editable, loading until both lists arrive, checked by membership', () => {
    expect(quickActionModel(base).sets).toBeNull()
    expect(quickActionModel({ ...base, editableSets: undefined }).sets).toBe('loading')
    expect(quickActionModel({ ...base, editableSets: [{ id: 'k', name: 'Kids' }], memberSetIds: undefined }).sets).toBe('loading')
    expect(quickActionModel({ ...base, editableSets: [], memberSetIds: undefined }).sets).toBeNull()
    expect(
      quickActionModel({ ...base, editableSets: [{ id: 'k', name: 'Kids' }, { id: 'b', name: 'Beach' }], memberSetIds: new Set(['b']) }).sets,
    ).toEqual([
      { kind: 'set', id: 'set:k', label: 'Kids', setId: 'k', checked: false },
      { kind: 'set', id: 'set:b', label: 'Beach', setId: 'b', checked: true },
    ])
  })
})

describe('editableSets', () => {
  const sets = [
    { id: 'p', kind: 'manual', scope: 'personal' },
    { id: 'g', kind: 'manual', scope: 'global' },
    { id: 's', kind: 'smart', scope: 'personal' },
  ]
  it('a member edits only personal manual sets; an admin also global ones; never smart sets', () => {
    expect(editableSets(sets, false).map((s) => s.id)).toEqual(['p'])
    expect(editableSets(sets, true).map((s) => s.id)).toEqual(['p', 'g'])
  })
})

it('rating steps run from 5 down to ½ in halves', () => {
  expect(RATING_STEPS).toEqual([5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5])
})

describe('quickActionModel — merge', () => {
  it('only an admin is offered Merge into another book', () => {
    expect(quickActionModel(base).merge).toBeNull()
    expect(quickActionModel({ ...base, isAdmin: true }).merge).toEqual({ kind: 'merge', id: 'merge', label: 'Merge into another book…' })
  })
})
