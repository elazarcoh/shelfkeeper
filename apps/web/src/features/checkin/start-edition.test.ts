import { describe, expect, it } from 'vitest'
import { editionsForMode, resolveStartEdition } from './start-edition'

const editions = [
  { id: 'p', format: 'physical' as const },
  { id: 'e', format: 'ebook' as const },
  { id: 'a', format: 'audiobook' as const },
]

describe('editionsForMode', () => {
  it('keeps the formats that match the mode', () => {
    expect(editionsForMode(editions, 'listen').map((e) => e.id)).toEqual(['a'])
    expect(editionsForMode(editions, 'read').map((e) => e.id)).toEqual(['p', 'e'])
  })
})

describe('resolveStartEdition', () => {
  it('auto-picks the only matching edition, ignoring any other pick', () => {
    expect(resolveStartEdition(editions, 'listen', null)).toBe('a')
    expect(resolveStartEdition(editions, 'listen', 'p')).toBe('a')
  })
  it('uses the pick among several matching editions, and none otherwise', () => {
    expect(resolveStartEdition(editions, 'read', 'e')).toBe('e')
    expect(resolveStartEdition(editions, 'read', null)).toBeNull()
    expect(resolveStartEdition(editions, 'read', 'a')).toBeNull()
  })
  it('is none when nothing matches', () => {
    expect(resolveStartEdition([{ id: 'p', format: 'physical' }], 'listen', null)).toBeNull()
  })
})

describe('resolveStartEdition in a volume set', () => {
  const he = (id: string, volume: number, inPossession: boolean) => ({ id, format: 'physical' as const, language: 'he', volume, volumeCount: 2, inPossession })
  it('defaults to the lowest volume, in possession first', () => {
    const set = [he('v2', 2, true), he('v1-lent', 1, false), he('v1-own', 1, true)]
    expect(resolveStartEdition(set, 'read', null)).toBe('v1-own')
    expect(resolveStartEdition(set, 'read', 'v2')).toBe('v2')
  })
  it('still defaults to volume 1 when no volume-1 copy is in possession', () => {
    expect(resolveStartEdition([he('v2', 2, true), he('v1', 1, false)], 'read', null)).toBe('v1')
  })
  it('is none when the editions are not one set', () => {
    const mixed = [he('v2', 2, true), he('v1', 1, true), { id: 'en', format: 'physical' as const, language: 'en', volume: null, volumeCount: null, inPossession: true }]
    expect(resolveStartEdition(mixed, 'read', null)).toBeNull()
  })
})
