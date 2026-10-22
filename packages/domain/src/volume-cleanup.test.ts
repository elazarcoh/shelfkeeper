import { describe, expect, it } from 'vitest'
import {
  MergeVolumesInput,
  VOLUMES_PROMPT_HEAD,
  findVolumeGroups,
  parseVolumesAnswer,
  reviewDefaults,
  reviewProblem,
  volumeGroupKey,
  volumesPrompts,
  type VolumeCatalogEdition,
  type VolumeCatalogEntry,
  type VolumeGroup,
} from './volume-cleanup'

function entry(id: string, title: string, over: Partial<VolumeCatalogEntry> = {}): VolumeCatalogEntry {
  return { id, title, subtitle: null, authors: ['Author'], series: [], editions: [], ...over }
}
function edition(over: Partial<VolumeCatalogEdition> = {}): VolumeCatalogEdition {
  return { id: 'e', format: 'physical', language: 'he', isbn: null, volume: null, volumeCount: null, ...over }
}

describe('findVolumeGroups', () => {
  it('groups Hebrew volumes of one book', () => {
    const groups = findVolumeGroups([entry('b', "דרך המלכים - כרך ב'"), entry('a', "דרך המלכים - כרך א'")])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'a,b', source: 'app', bookTitle: 'דרך המלכים', volumeCount: null })
    expect(groups[0]?.members).toEqual([
      { workId: 'a', volume: 1 },
      { workId: 'b', volume: 2 },
    ])
  })
  it('puts an unread volume last', () => {
    const groups = findVolumeGroups([entry('n', 'Mr Norrell'), entry('v', 'Mr Norrell, Volume 2')])
    expect(groups[0]?.members).toEqual([
      { workId: 'v', volume: 2 },
      { workId: 'n', volume: null },
    ])
    expect(groups[0]?.bookTitle).toBe('Mr Norrell')
  })
  it('needs the same first author', () => {
    expect(findVolumeGroups([entry('a', 'X Vol. 1', { authors: ['A'] }), entry('b', 'X Vol. 2', { authors: ['B'] })])).toEqual([])
  })
  it('ignores equal volumes', () => {
    expect(findVolumeGroups([entry('a', 'X Vol. 2'), entry('b', 'X Vol. 2')])).toEqual([])
  })
  it('ignores buckets with no read volume', () => {
    expect(findVolumeGroups([entry('a', 'Dune'), entry('b', 'Dune')])).toEqual([])
  })
  it('reads the volume count from titles and editions', () => {
    const g = findVolumeGroups([entry('a', 'X Vol. 2 of 3'), entry('b', 'X Vol. 1')])
    expect(g[0]?.volumeCount).toBe(3)
    const h = findVolumeGroups([entry('a', 'X Vol. 2'), entry('b', 'X Vol. 1', { editions: [edition({ volumeCount: 4 })] })])
    expect(h[0]?.volumeCount).toBe(4)
  })
})

describe('volumesPrompts', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`id${String(i).padStart(5, '0')}`, `Title ${String(i).padStart(5, '0')}`))
  it('has no prompts without entries', () => {
    expect(volumesPrompts([])).toEqual({ prompts: [], omitted: 0 })
  })
  it('chunks by 500', () => {
    const r = volumesPrompts(many(1201))
    expect(r.prompts).toHaveLength(3)
    expect(r.omitted).toBe(0)
    for (const p of r.prompts) expect(p.startsWith(VOLUMES_PROMPT_HEAD)).toBe(true)
    expect(r.prompts.filter((p) => p.includes('"id00007"'))).toHaveLength(1)
  })
  it('omits beyond 2000', () => {
    const r = volumesPrompts(many(2001))
    expect(r.prompts).toHaveLength(4)
    expect(r.omitted).toBe(1)
  })
  it('writes compact books', () => {
    const r = volumesPrompts([
      entry('a', 'T', {
        subtitle: 'S',
        series: [{ name: 'Ser', position: 2 }],
        editions: [edition({ isbn: '9789650000000', volume: 1, volumeCount: 2 }), edition({ language: null })],
      }),
    ])
    const line = (r.prompts[0] ?? '').slice(VOLUMES_PROMPT_HEAD.length).split('\n').find((l) => l.includes('"a"')) ?? ''
    expect(JSON.parse(line.replace(/,$/, ''))).toEqual({
      id: 'a',
      title: 'T',
      subtitle: 'S',
      authors: ['Author'],
      series: 'Ser #2',
      editions: ['physical · he · 9789650000000 · vol 1 of 2', 'physical'],
    })
  })
})

describe('parseVolumesAnswer', () => {
  const entries = [entry('a', 'Foo A'), entry('b', 'Foo B'), entry('c', 'Bar'), entry('d', 'Baz')]
  it('reads fenced JSON with prose', () => {
    const r = parseVolumesAnswer(
      'Here you go:\n```json\n[{"book_title":"Foo","works":[{"id":"b","volume":2},{"id":"a","volume":1}],"volume_count":2}]\n```\nDone',
      entries,
      [],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.notes).toEqual([])
    expect(r.value.groups).toEqual([
      {
        key: 'a,b',
        source: 'ai',
        bookTitle: 'Foo',
        volumeCount: 2,
        members: [
          { workId: 'a', volume: 1 },
          { workId: 'b', volume: 2 },
        ],
      },
    ])
  })
  it('notes unknown ids', () => {
    const r = parseVolumesAnswer('[{"book_title":"X","works":[{"id":"a","volume":1},{"id":"zz","volume":2},{"id":"b","volume":2}]}]', entries, [])
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.notes).toEqual(['Unknown book id “zz” left out'])
    expect(r.value.groups[0]?.members).toHaveLength(2)
  })
  it('notes an id already in an earlier group', () => {
    const r = parseVolumesAnswer(
      '[{"book_title":"X","works":[{"id":"a"},{"id":"b"}]},{"book_title":"Y","works":[{"id":"b"},{"id":"c"}]}]',
      entries,
      [],
    )
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.notes).toEqual(['“Foo B” is already in another group, left out', 'Group “Y” has fewer than two books, left out'])
    expect(r.value.groups).toHaveLength(1)
  })
  it('notes a single-member group and a non-object item', () => {
    const r = parseVolumesAnswer('[{"book_title":"Solo","works":[{"id":"c"}]}, 5]', entries, [])
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.notes).toEqual(['Group “Solo” has fewer than two books, left out', 'Item 2 is not a group, left out'])
    expect(r.value.groups).toEqual([])
  })
  it('reads string numbers', () => {
    const r = parseVolumesAnswer('[{"works":[{"id":"c","volume":"2"},{"id":"d","volume":"x"}],"volume_count":"3"}]', entries, [])
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.groups[0]).toMatchObject({
      bookTitle: 'Bar',
      volumeCount: 3,
      members: [
        { workId: 'c', volume: 2 },
        { workId: 'd', volume: null },
      ],
    })
  })
  it('drops a group the app already found, silently', () => {
    const taken: VolumeGroup = { key: 'a,b', source: 'app', bookTitle: 'Foo', members: [], volumeCount: null }
    const r = parseVolumesAnswer('[{"works":[{"id":"a"},{"id":"b"}]}]', entries, [taken])
    if (!r.ok) throw new Error('expected ok')
    expect(r.value).toEqual({ groups: [], notes: [] })
  })
  it('notes an id in a taken group', () => {
    const taken: VolumeGroup = {
      key: 'a,b',
      source: 'app',
      bookTitle: 'Foo',
      members: [
        { workId: 'a', volume: 1 },
        { workId: 'b', volume: 2 },
      ],
      volumeCount: null,
    }
    const r = parseVolumesAnswer('[{"works":[{"id":"a"},{"id":"c"},{"id":"d"}]}]', entries, [taken])
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.notes).toEqual(['“Foo A” is already in another group, left out'])
    expect(r.value.groups[0]?.key).toBe('c,d')
  })
  it('errs on garbage', () => {
    expect(parseVolumesAnswer('no list here', entries, [])).toEqual({ ok: false, error: 'No list of groups found in the answer' })
  })
})

describe('reviewDefaults', () => {
  const group = (members: { workId: string; volume: number | null }[], bookTitle = 'Foo'): VolumeGroup => ({
    key: volumeGroupKey(members.map((m) => m.workId)),
    source: 'app',
    bookTitle,
    members,
    volumeCount: 3,
  })
  it('keeps volume 1 as survivor and fills the single null with the free number', () => {
    const entries = [entry('a', 'Foo'), entry('b', 'Foo Vol. 2'), entry('c', 'Foo Vol. 1')]
    const r = reviewDefaults(
      group([
        { workId: 'c', volume: 1 },
        { workId: 'b', volume: 2 },
        { workId: 'a', volume: null },
      ]),
      entries,
    )
    expect(r.survivorId).toBe('c')
    expect(r.title).toBe('Foo')
    expect(r.volumeCount).toBe(3)
    expect(r.members).toEqual([
      { workId: 'c', volume: 1 },
      { workId: 'b', volume: 2 },
      { workId: 'a', volume: 3 },
    ])
  })
  it('keeps the member that already holds volume 1 in its editions', () => {
    const entries = [entry('a', 'Saga', { editions: [edition({ volume: 1 }), edition({ volume: 2 })] }), entry('b', 'Saga, Volume 3')]
    const r = reviewDefaults(
      group([
        { workId: 'a', volume: null },
        { workId: 'b', volume: 3 },
      ]),
      entries,
    )
    expect(r.survivorId).toBe('a')
  })
  it('keeps null when the member has an edition volume', () => {
    const entries = [entry('a', 'Foo', { editions: [edition({ volume: 3 })] }), entry('b', 'Foo Vol. 1')]
    const r = reviewDefaults(
      group([
        { workId: 'b', volume: 1 },
        { workId: 'a', volume: null },
      ]),
      entries,
    )
    expect(r.members).toEqual([
      { workId: 'b', volume: 1 },
      { workId: 'a', volume: null },
    ])
  })
  it('uses the AI group title and leaves several nulls alone', () => {
    const entries = [entry('a', 'Alpha'), entry('b', 'Beta')]
    const g: VolumeGroup = {
      ...group(
        [
          { workId: 'a', volume: null },
          { workId: 'b', volume: null },
        ],
        'Whole',
      ),
      source: 'ai',
    }
    const r = reviewDefaults(g, entries)
    expect(r.title).toBe('Whole')
    expect(r.survivorId).toBe('a')
    expect(r.members).toEqual([
      { workId: 'a', volume: null },
      { workId: 'b', volume: null },
    ])
  })
})

describe('reviewProblem', () => {
  const entries = [entry('a', 'Foo'), entry('b', 'Bar', { editions: [edition({ volume: 4 })] })]
  const base = {
    survivorId: 'a',
    title: 'Foo',
    members: [
      { workId: 'a', volume: 1 },
      { workId: 'b', volume: null },
    ],
    volumeCount: null,
  }
  it('is null for a good review', () => expect(reviewProblem(base, entries)).toBeNull())
  it('needs a title', () => expect(reviewProblem({ ...base, title: '  ' }, entries)).toBe('The book needs a title'))
  it('needs volumes', () =>
    expect(
      reviewProblem(
        {
          ...base,
          members: [
            { workId: 'a', volume: null },
            { workId: 'b', volume: 2 },
          ],
        },
        entries,
      ),
    ).toBe('Give “Foo” a volume number'))
  it('checks the count against member and edition volumes', () => {
    expect(reviewProblem({ ...base, volumeCount: 3 }, entries)).toBe("The number of volumes can't be lower than volume 4")
    const high = {
      ...base,
      members: [
        { workId: 'a', volume: 5 },
        { workId: 'b', volume: 2 },
      ],
      volumeCount: 4,
    }
    expect(reviewProblem(high, entries)).toBe("The number of volumes can't be lower than volume 5")
  })
})

describe('MergeVolumesInput', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const good = {
    survivorId: a,
    title: ' Foo ',
    members: [
      { workId: a, volume: 1 },
      { workId: b, volume: 2 },
    ],
    volumeCount: 2,
  }
  it('trims the title', () => expect(MergeVolumesInput.parse(good).title).toBe('Foo'))
  it('rejects a survivor not among the members', () => {
    expect(MergeVolumesInput.safeParse({ ...good, survivorId: '33333333-3333-4333-8333-333333333333' }).success).toBe(false)
  })
  it('rejects duplicate members', () => {
    const members = [
      { workId: a, volume: 1 },
      { workId: a, volume: 2 },
    ]
    expect(MergeVolumesInput.safeParse({ ...good, members }).success).toBe(false)
  })
  it('rejects a count below a volume', () => {
    expect(MergeVolumesInput.safeParse({ ...good, volumeCount: 1 }).success).toBe(false)
  })
})
