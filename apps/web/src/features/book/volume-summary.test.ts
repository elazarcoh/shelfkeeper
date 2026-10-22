import { describe, expect, it } from 'vitest'
import { editionGroups } from './volume-summary'
import type { EditionDetail } from './edition-form-state'

const ed = (id: string, over: Partial<EditionDetail>): EditionDetail =>
  ({ id, format: 'physical', language: 'he', volume: null, volumeCount: null, ...over }) as EditionDetail

const ids = (g: ReturnType<typeof editionGroups>[number]) => (g.kind === 'single' ? [g.edition.id] : g.editions.map((e) => e.id))

describe('editionGroups', () => {
  it('pulls a scattered set together at its first member, in volume order', () => {
    const groups = editionGroups([ed('v2', { volume: 2, volumeCount: 2 }), ed('en', { language: 'en' }), ed('v1', { volume: 1, volumeCount: 2 })])
    expect(groups.map(ids)).toEqual([['v1', 'v2'], ['en']])
    expect(groups[0]).toMatchObject({ kind: 'set', key: 'physical:he' })
    expect(groups[1]).toMatchObject({ kind: 'single' })
  })

  it('headlines a complete set with no missing line', () => {
    const [g] = editionGroups([ed('a', { volume: 1, volumeCount: 2 }), ed('b', { volume: 2, volumeCount: 2 })])
    expect(g).toMatchObject({ kind: 'set', heading: 'Hebrew · Physical · 2 volumes', missing: null })
  })

  it('names the missing volumes of an incomplete set', () => {
    const [g] = editionGroups([ed('a', { volume: 1, volumeCount: 2 })])
    expect(g).toMatchObject({ kind: 'set', heading: 'Hebrew · Physical · 2 volumes', missing: 'Missing: vol 2' })
  })

  it('keeps editions that are not volumes as singles in API order', () => {
    expect(editionGroups([ed('b', {}), ed('a', { language: 'en' })]).map(ids)).toEqual([['b'], ['a']])
  })
})
