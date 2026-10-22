import { describe, expect, it } from 'vitest'
import { languagesMatch, missingLabel, missingVolumes, newVolumeLabel, sameVolumeSet, setForVolume, volumeLabel, volumeList, volumeSets, wishVolumes, wishVolumesLabel, type VolumeEditionLike } from './volumes'

const ed = (id: string, over: Partial<VolumeEditionLike> = {}): VolumeEditionLike => ({
  id,
  format: 'physical',
  language: 'he',
  volume: null,
  volumeCount: null,
  ...over,
})

describe('volumeSets', () => {
  it('groups volumes by format and language, ignoring non-volume editions', () => {
    const sets = volumeSets([
      ed('en', { language: 'en' }),
      ed('he2', { volume: 2, volumeCount: 2 }),
      ed('he1', { volume: 1, volumeCount: 2 }),
      ed('heE1', { format: 'ebook', volume: 1 }),
    ])
    expect(sets.map((s) => [s.format, s.language, s.size, s.members.map((m) => m.id)])).toEqual([
      ['physical', 'he', 2, ['he1', 'he2']],
      ['ebook', 'he', 1, ['heE1']],
    ])
  })

  it('treats a null language as its own set', () => {
    const sets = volumeSets([ed('a', { volume: 1 }), ed('b', { volume: 2, language: null })])
    expect(sets).toHaveLength(2)
  })

  it('sizes a set by the largest count or highest volume', () => {
    expect(volumeSets([ed('a', { volume: 3 }), ed('b', { volume: 1, volumeCount: 2 })])[0]?.size).toBe(3)
    expect(volumeSets([ed('a', { volume: 1, volumeCount: 4 })])[0]?.size).toBe(4)
  })
})

describe('missingVolumes', () => {
  it('lists absent volume numbers up to the size', () => {
    const [set] = volumeSets([ed('a', { volume: 1, volumeCount: 3 })])
    expect(set && missingVolumes(set)).toEqual([2, 3])
  })

  it('counts two copies of one volume once', () => {
    const [set] = volumeSets([ed('a', { volume: 1, volumeCount: 2 }), ed('b', { volume: 1, volumeCount: 2 })])
    expect(set && missingVolumes(set)).toEqual([2])
  })

  it('knows nothing is missing when the count is unknown and volumes are contiguous', () => {
    const [set] = volumeSets([ed('a', { volume: 1 }), ed('b', { volume: 2 })])
    expect(set && missingVolumes(set)).toEqual([])
  })

  it('reports gaps below the highest volume even without a count', () => {
    const [set] = volumeSets([ed('a', { volume: 3 })])
    expect(set && missingVolumes(set)).toEqual([1, 2])
  })
})

describe('labels', () => {
  it('formats volume and missing labels', () => {
    expect(volumeLabel(1, 2)).toBe('Vol 1 of 2')
    expect(volumeLabel(1, null)).toBe('Vol 1')
    expect(volumeLabel(null, null)).toBeNull()
    expect(missingLabel([2])).toBe('Missing: vol 2')
    expect(missingLabel([2, 3])).toBe('Missing: vols 2, 3')
    expect(missingLabel([1, 2, 3, 5])).toBe('Missing: vols 1–3, 5')
    expect(missingLabel(Array.from({ length: 119 }, (_, i) => i + 1))).toBe('Missing: vols 1–119')
    expect(missingLabel([])).toBeNull()
  })

  it('compares sets by format and language', () => {
    expect(sameVolumeSet({ format: 'physical', language: 'he' }, { format: 'physical', language: 'he' })).toBe(true)
    expect(sameVolumeSet({ format: 'physical', language: 'he' }, { format: 'physical', language: null })).toBe(false)
    expect(sameVolumeSet({ format: 'physical', language: 'he' }, { format: 'ebook', language: 'he' })).toBe(false)
  })
})

describe('volumeList, languagesMatch and newVolumeLabel', () => {
  it('lists volumes as missingLabel does', () => {
    expect(volumeList([2])).toBe('vol 2')
    expect(volumeList([1, 2, 3, 5])).toBe('vols 1–3, 5')
    expect(missingLabel([1, 2, 3, 5])).toBe('Missing: vols 1–3, 5')
  })
  it('a missing language matches any; otherwise case-insensitive', () => {
    expect(languagesMatch(null, 'he')).toBe(true)
    expect(languagesMatch('HE ', 'he')).toBe(true)
    expect(languagesMatch('en', 'he')).toBe(false)
  })
  it('names the new volume and what you have', () => {
    expect(newVolumeLabel({ number: 2, have: [1], size: 2 }, 'דרך המלכים')).toBe('Volume 2 of דרך המלכים (you have vol 1)')
    expect(newVolumeLabel({ number: 4, have: [1, 3], size: 4 }, null)).toBe('Volume 4 (you have vols 1, 3)')
  })
})

describe('wishVolumes', () => {
  const e = (id: string, format: 'physical' | 'ebook', language: string | null, volume: number | null, volumeCount: number | null = null) => ({ id, format, language, volume, volumeCount })
  it('the set in the wish format and language: what is owned and what is missing', () => {
    const v = wishVolumes({ formats: ['physical'], language: 'he' }, [e('a', 'physical', 'he', 1, 2), e('b', 'ebook', 'he', 1, 3)])
    expect(v).toEqual({ have: [1], size: 2, missing: [2], format: 'physical', language: 'he' })
    expect(wishVolumesLabel(v ?? { have: [], size: 0, missing: [], format: 'physical', language: null })).toBe('Have vol 1 of 2 — missing vol 2')
  })
  it('any format: the fullest set; a complete set says so; no set → null', () => {
    const v = wishVolumes({ formats: [], language: null }, [e('a', 'physical', 'he', 1, 2), e('b', 'physical', 'he', 2), e('c', 'ebook', 'en', 1, 3)])
    expect(v).toEqual({ have: [1, 2], size: 2, missing: [], format: 'physical', language: 'he' })
    expect(wishVolumesLabel(v ?? { have: [], size: 0, missing: [], format: 'physical', language: null })).toBe('Have all 2 volumes')
    expect(wishVolumes({ formats: ['physical'], language: null }, [e('a', 'physical', 'he', null)])).toBeNull()
  })
})

describe('setForVolume', () => {
  const sets = (...es: VolumeEditionLike[]) => volumeSets(es)
  it('an exact language wins, null equals null', () => {
    const s = sets(ed('a', { language: null, volume: 1 }), ed('b', { language: 'he', volume: 1 }))
    expect(setForVolume(s, 'physical', 'he')?.language).toBe('he')
    expect(setForVolume(s, 'physical', null)?.language).toBeNull()
  })
  it('the exact pass ignores case and spaces (#76)', () => {
    const s = sets(ed('a', { language: 'he', volume: 1 }), ed('b', { language: null, volume: 1 }))
    expect(setForVolume(s, 'physical', 'HE ')?.language).toBe('he')
  })
  it('else the only set whose language matches leniently', () => {
    expect(setForVolume(sets(ed('a', { language: null, volume: 1 })), 'physical', 'he')?.language).toBeNull()
    expect(setForVolume(sets(ed('a', { language: 'he', volume: 1 })), 'physical', null)?.language).toBe('he')
    expect(setForVolume(sets(ed('a', { language: 'HE ', volume: 1 })), 'physical', 'he')?.language).toBe('HE ')
  })
  it('two lenient candidates, another format, or no set → none', () => {
    expect(setForVolume(sets(ed('a', { language: 'he', volume: 1 }), ed('b', { language: 'en', volume: 1 })), 'physical', null)).toBeUndefined()
    expect(setForVolume(sets(ed('a', { language: 'he', volume: 1 })), 'ebook', 'he')).toBeUndefined()
    expect(setForVolume(sets(ed('a', { language: 'he', volume: 1 })), 'physical', 'en')).toBeUndefined()
    expect(setForVolume([], 'physical', 'he')).toBeUndefined()
  })
})
