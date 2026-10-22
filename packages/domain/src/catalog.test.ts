import { describe, expect, it } from 'vitest'
import { AddWorkTitleInput, CreateWorkInput, EditionInput, EditionPatch, SeriesRef, WorkPatch } from './catalog'

const base = { title: ' The Final Empire ', authors: ['Brandon Sanderson'], editions: [{ format: 'physical' }] }

describe('CreateWorkInput', () => {
  it('trims text, fills defaults and cleans identifiers', () => {
    const w = CreateWorkInput.parse({ ...base, editions: [{ format: 'physical', isbn13: '978-0-7653-1178-8' }] })
    expect(w.title).toBe('The Final Empire')
    expect(w.subtitle).toBeNull()
    expect(w.series).toEqual([])
    expect(w.tags).toEqual([])
    expect(w.editions[0]?.isbn13).toBe('9780765311788')
    expect(w.editions[0]?.narrators).toEqual([])
    expect(w.editions[0]?.pageCount).toBeNull()
    expect(w.editions[0]?.ownership).toBe('owned')
  })
  it('accepts a borrowed edition with where it came from', () => {
    const w = CreateWorkInput.parse({ ...base, editions: [{ format: 'physical', ownership: 'borrowed', holdingNote: 'City library' }] })
    expect(w.editions[0]).toMatchObject({ ownership: 'borrowed', holdingNote: 'City library', holdingOn: null })
  })
  it('rejects a bad ISBN-13 checksum', () => {
    const r = CreateWorkInput.safeParse({ ...base, editions: [{ format: 'physical', isbn13: '9780765311789' }] })
    expect(r.success).toBe(false)
  })
  it('requires at least one author and one edition', () => {
    expect(CreateWorkInput.safeParse({ ...base, authors: [] }).success).toBe(false)
    expect(CreateWorkInput.safeParse({ ...base, editions: [] }).success).toBe(false)
  })
  it('rejects names without any letter or digit', () => {
    expect(CreateWorkInput.safeParse({ ...base, authors: ['!!!'] }).success).toBe(false)
  })
  it('accepts series positions like 2.5 and unknown positions', () => {
    const w = CreateWorkInput.parse({ ...base, series: [{ name: 'Mistborn', position: 2.5 }, { name: 'Cosmere', position: null }] })
    expect(w.series.map((s) => s.position)).toEqual([2.5, null])
  })
})

describe('patches', () => {
  it('rejects empty patches', () => {
    expect(WorkPatch.safeParse({}).success).toBe(false)
    expect(EditionPatch.safeParse({}).success).toBe(false)
  })
  it('keeps only provided fields', () => {
    expect(WorkPatch.parse({ subtitle: null })).toEqual({ subtitle: null })
  })
})

describe('EditionInput volumes', () => {
  it('accepts a volume with or without a count', () => {
    expect(EditionInput.parse({ format: 'physical', volume: 1, volumeCount: 2 })).toMatchObject({ volume: 1, volumeCount: 2 })
    expect(EditionInput.parse({ format: 'physical' })).toMatchObject({ volume: null, volumeCount: null })
  })

  it('rejects a count without a volume, and a volume above the count', () => {
    const noVolume = EditionInput.safeParse({ format: 'physical', volumeCount: 2 })
    expect(noVolume.success).toBe(false)
    expect(noVolume.error?.issues[0]?.path).toEqual(['volumeCount'])
    const tooHigh = EditionInput.safeParse({ format: 'physical', volume: 3, volumeCount: 2 })
    expect(tooHigh.success).toBe(false)
    expect(tooHigh.error?.issues[0]?.path).toEqual(['volume'])
  })
})

describe('SeriesRef ranges (#122)', () => {
  it('defaults positionEnd to null and accepts a range that goes up', () => {
    expect(SeriesRef.parse({ name: 'Mage Errant', position: 1 })).toEqual({ name: 'Mage Errant', position: 1, positionEnd: null })
    expect(SeriesRef.parse({ name: 'Mage Errant', position: 1, positionEnd: 2 }).positionEnd).toBe(2)
  })
  it('rejects an end with no start, or not above it', () => {
    expect(SeriesRef.safeParse({ name: 'S', position: null, positionEnd: 2 }).success).toBe(false)
    expect(SeriesRef.safeParse({ name: 'S', position: 2, positionEnd: 2 }).success).toBe(false)
    expect(SeriesRef.safeParse({ name: 'S', position: 2, positionEnd: 1 }).success).toBe(false)
  })
  it('says how to write a position when it is not a number', () => {
    const r = SeriesRef.safeParse({ name: 'S', position: Number.NaN })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.message).toBe('Use a number like 3 or a range like 1-2')
  })
})

describe('AddWorkTitleInput', () => {
  it('lowercases a title language so it compares equal to the stored one', () => {
    const parse = (language: string | null) => AddWorkTitleInput.parse({ workId: '8c1f3a5e-0b3c-4d6e-9a1b-2c3d4e5f6a7b', language, title: 'x' }).language
    expect(parse('FR')).toBe('fr')
    expect(parse(' Fr ')).toBe('fr')
    expect(parse('Hebrew')).toBe('he')
    expect(parse('')).toBeNull()
  })
})
