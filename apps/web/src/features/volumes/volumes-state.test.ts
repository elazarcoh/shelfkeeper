import { describe, expect, it } from 'vitest'
import type { GroupReview, VolumeGroup } from '@mylib/domain'
import { dismissedKey, loadDismissed, saveDismissed, shownGroups, toMergeInput } from './volumes-state'

const group = (key: string, ids: string[], source: 'app' | 'ai' = 'app'): VolumeGroup => ({
  key,
  source,
  bookTitle: key,
  members: ids.map((workId, i) => ({ workId, volume: i + 1 })),
  volumeCount: null,
})

describe('dismissed groups store', () => {
  it('round-trips per user', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    saveDismissed(storage, 'u1', new Set(['a,b', 'c,d']))
    expect(dismissedKey('u1')).toBe('mylib:volumes:dismissed:u1')
    expect(loadDismissed(storage, 'u1')).toEqual(new Set(['a,b', 'c,d']))
    expect(loadDismissed(storage, 'u2')).toEqual(new Set())
  })
  it('reads bad JSON, wrong shapes, a throw and no storage as empty', () => {
    expect(loadDismissed({ getItem: () => '{nope' }, 'u')).toEqual(new Set())
    expect(loadDismissed({ getItem: () => '{"a":1}' }, 'u')).toEqual(new Set())
    expect(loadDismissed({ getItem: () => { throw new Error('blocked') } }, 'u')).toEqual(new Set())
    expect(loadDismissed(null, 'u')).toEqual(new Set())
  })
  it('ignores a storage that throws or is missing when saving', () => {
    expect(() => saveDismissed({ setItem: () => { throw new Error('full') } }, 'u', new Set(['a']))).not.toThrow()
    expect(() => saveDismissed(null, 'u', new Set(['a']))).not.toThrow()
  })
})

describe('shownGroups', () => {
  const app = [group('a,b', ['a', 'b']), group('c,d', ['c', 'd'])]
  const ai = [group('e,f', ['e', 'f'], 'ai'), group('g,h', ['g', 'h'], 'ai')]
  const all = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  it('lists app groups first, then AI groups', () => {
    expect(shownGroups(app, ai, new Set(), all).map((g) => g.key)).toEqual(['a,b', 'c,d', 'e,f', 'g,h'])
  })
  it('drops dismissed groups', () => {
    expect(shownGroups(app, ai, new Set(['c,d', 'e,f']), all).map((g) => g.key)).toEqual(['a,b', 'g,h'])
  })
  it('drops groups with a member that left the catalog', () => {
    const left = new Set(['a', 'b', 'c', 'e', 'f', 'g', 'h'])
    expect(shownGroups(app, ai, new Set(), left).map((g) => g.key)).toEqual(['a,b', 'e,f', 'g,h'])
  })
})

describe('toMergeInput', () => {
  it('trims the title and keeps the rest', () => {
    const review: GroupReview = { survivorId: 'a', title: '  Saga  ', members: [{ workId: 'a', volume: 1 }, { workId: 'b', volume: null }], volumeCount: 2 }
    expect(toMergeInput(review)).toEqual({ survivorId: 'a', title: 'Saga', members: review.members, volumeCount: 2 })
  })
})
