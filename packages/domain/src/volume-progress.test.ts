import { describe, expect, it } from 'vitest'
import { atVolumeEnd, bookFraction, bookHighest, nextVolumePresent, setAmountSource, volumeContexts, type VolumeEditionLengths } from './volume-progress'

const ed = (id: string, over: Partial<VolumeEditionLengths> = {}): VolumeEditionLengths => ({
  id, format: 'physical', language: 'he', volume: null, volumeCount: null, pageCount: null, durationSec: null, wordCount: null, ...over,
})

const twoVolumes = volumeContexts([
  ed('v1', { volume: 1, volumeCount: 2, pageCount: 400, wordCount: 100_000 }),
  ed('v2', { volume: 2, volumeCount: 2, pageCount: 600, wordCount: 150_000 }),
  ed('en', { language: 'en', pageCount: 1000 }),
])

describe('volumeContexts', () => {
  it('gives each volume its place and the set lengths; plain editions have none', () => {
    expect(twoVolumes.get('v2')).toMatchObject({ volume: 2, size: 2 })
    expect(twoVolumes.get('v2')?.volumes.map((v) => v.pageCount)).toEqual([400, 600])
    expect(twoVolumes.has('en')).toBe(false)
  })

  it('counts a duplicated volume number once, preferring the copy with a length', () => {
    const ctx = volumeContexts([ed('a', { volume: 1, volumeCount: 2 }), ed('b', { volume: 1, volumeCount: 2, pageCount: 300 }), ed('c', { volume: 2, pageCount: 200 })])
    expect(ctx.get('a')?.volumes.map((v) => [v.volume, v.pageCount])).toEqual([[1, 300], [2, 200]])
  })
})

describe('bookFraction', () => {
  it('uses summed lengths when every volume has one', () => {
    expect(bookFraction('page', 200, { pageCount: 600, durationSec: null }, twoVolumes.get('v2') ?? null)).toBeCloseTo(0.6)
    expect(bookFraction('page', 400, { pageCount: 400, durationSec: null }, twoVolumes.get('v1') ?? null)).toBeCloseTo(0.4)
  })

  it('falls back to equal weight when a volume length is missing', () => {
    const ctx = volumeContexts([ed('v1', { volume: 1, volumeCount: 2, pageCount: 400 }), ed('v2', { volume: 2, volumeCount: 2 })])
    expect(bookFraction('page', 200, { pageCount: 400, durationSec: null }, ctx.get('v1') ?? null)).toBeCloseTo(0.25)
    expect(bookFraction('page', 10, { pageCount: null, durationSec: null }, ctx.get('v2') ?? null)).toBeNull()
    expect(bookFraction('percent', 50, { pageCount: null, durationSec: null }, ctx.get('v2') ?? null)).toBeCloseTo(0.75)
  })

  it('treats a missing volume (absent from the catalog) as unknown length', () => {
    const ctx = volumeContexts([ed('v1', { volume: 1, volumeCount: 3, pageCount: 400 }), ed('v2', { volume: 2, pageCount: 300 })])
    expect(bookFraction('page', 300, { pageCount: 300, durationSec: null }, ctx.get('v2') ?? null)).toBeCloseTo(2 / 3)
  })

  it('is today’s rule outside a set, and never exceeds 1', () => {
    expect(bookFraction('page', 500, { pageCount: 1000, durationSec: null }, null)).toBe(0.5)
    expect(bookFraction('page', 900, { pageCount: 600, durationSec: null }, twoVolumes.get('v2') ?? null)).toBe(1)
  })

  it('uses the given own length for the point’s volume (the one-time length answer)', () => {
    const ctx = volumeContexts([ed('v1', { volume: 1, volumeCount: 2, pageCount: 400 }), ed('v2', { volume: 2, volumeCount: 2 })])
    expect(bookFraction('page', 300, { pageCount: 600, durationSec: null }, ctx.get('v2') ?? null)).toBeCloseTo(0.7)
  })
})

describe('bookHighest', () => {
  it('does not fall back when moving from the end of volume 1 to the start of volume 2', () => {
    const v1 = twoVolumes.get('v1') ?? null
    const v2 = twoVolumes.get('v2') ?? null
    expect(bookHighest([
      { kind: 'page', value: 400, length: { pageCount: 400, durationSec: null }, ctx: v1 },
      { kind: 'page', value: 0, length: { pageCount: 600, durationSec: null }, ctx: v2 },
    ])).toBeCloseTo(0.4)
  })
})

describe('setAmountSource and helpers', () => {
  it('sums volume lengths when all are known, else multiplies the own value by the size', () => {
    expect(setAmountSource(twoVolumes.get('v1') ?? null, { pageCount: 400, durationSec: null, wordCount: 100_000 })).toEqual({ pageCount: 1000, durationSec: null, wordCount: 250_000 })
    const partial = volumeContexts([ed('v1', { volume: 1, volumeCount: 2, pageCount: 400 }), ed('v2', { volume: 2 })])
    expect(setAmountSource(partial.get('v1') ?? null, { pageCount: 400, durationSec: null, wordCount: null })).toEqual({ pageCount: 800, durationSec: null, wordCount: null })
    expect(setAmountSource(null, { pageCount: 5, durationSec: 6, wordCount: 7 })).toEqual({ pageCount: 5, durationSec: 6, wordCount: 7 })
  })

  it('knows whether the next volume is in the catalog and when a volume is done', () => {
    expect(nextVolumePresent(twoVolumes.get('v1') ?? { volume: 1, size: 1, volumes: [] })).toBe(true)
    const lonely = volumeContexts([ed('v1', { volume: 1, volumeCount: 2 })])
    expect(nextVolumePresent(lonely.get('v1') ?? { volume: 1, size: 1, volumes: [] })).toBe(false)
    expect(atVolumeEnd('page', 400, { pageCount: 400, durationSec: null })).toBe(true)
    expect(atVolumeEnd('percent', 100, { pageCount: null, durationSec: null })).toBe(true)
    expect(atVolumeEnd('page', 399, { pageCount: 400, durationSec: null })).toBe(false)
  })
})
