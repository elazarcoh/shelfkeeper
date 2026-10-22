import { describe, expect, it } from 'vitest'
import type { WishPage, WishVolumes } from '@mylib/domain'
import { boughtVolumeChoices } from './bought-state'

const volumes = (over: Partial<WishVolumes> = {}): WishVolumes => ({ have: [1], size: 3, missing: [2, 3], format: 'physical', language: 'he', ...over })

describe('boughtVolumeChoices', () => {
  it('offers the missing volumes of the chosen format', () => {
    expect(boughtVolumeChoices({ page: null, volumes: volumes() }, 'physical')).toEqual([2, 3])
  })
  it('offers nothing for a format other than the one of the set', () => {
    expect(boughtVolumeChoices({ page: null, volumes: volumes({ have: [1], size: 2, missing: [2] }) }, 'ebook')).toEqual([])
  })
  it('asks nothing when the saved page already names its volume', () => {
    expect(boughtVolumeChoices({ page: { volume: 2 } as WishPage, volumes: volumes({ size: 2, missing: [2] }) }, 'physical')).toEqual([])
  })
  it('asks nothing when the book has no volume set', () => {
    expect(boughtVolumeChoices({ page: null, volumes: null }, 'physical')).toEqual([])
  })
})
