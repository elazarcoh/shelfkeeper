import { describe, expect, it } from 'vitest'
import { fieldsFromVolume, volumeFromFields } from './volume-fields'

describe('volumeFromFields', () => {
  it('a blank volume is "not a volume"', () => {
    expect(volumeFromFields({ volume: '', count: '' })).toBeNull()
    expect(volumeFromFields({ volume: '  ', count: '3' })).toBeNull()
  })
  it('reads the number and the count', () => {
    expect(volumeFromFields({ volume: '2', count: '3' })).toEqual({ number: 2, count: 3 })
    expect(volumeFromFields({ volume: '2', count: '' })).toEqual({ number: 2, count: null })
  })
  it('rejects a count below the volume, and anything outside 1..999', () => {
    expect(volumeFromFields({ volume: '3', count: '2' })).toBe('invalid')
    expect(volumeFromFields({ volume: '0', count: '' })).toBe('invalid')
    expect(volumeFromFields({ volume: '1000', count: '' })).toBe('invalid')
    expect(volumeFromFields({ volume: '1.5', count: '' })).toBe('invalid')
    expect(volumeFromFields({ volume: 'x', count: '' })).toBe('invalid')
    expect(volumeFromFields({ volume: '2', count: '1000' })).toBe('invalid')
  })
  it('seeds the fields from a volume', () => {
    expect(fieldsFromVolume({ number: 2, count: 3 })).toEqual({ volume: '2', count: '3' })
    expect(fieldsFromVolume({ number: 2, count: null })).toEqual({ volume: '2', count: '' })
    expect(fieldsFromVolume(null)).toEqual({ volume: '', count: '' })
  })
})
