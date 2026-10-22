import { describe, expect, it } from 'vitest'
import type { SessionProgressInfo } from '@mylib/domain'
import { lengthNote } from './progress-field'

const info = (more: Partial<SessionProgressInfo> = {}): SessionProgressInfo => ({ editionFormat: 'physical', pageCount: 600, durationSec: null, latest: null, pointCount: 0, highest: null, volume: null, ...more })
const volume = (v: number, size: number | null) => ({ volume: v, size: size ?? v, volumes: [], waiting: false })

describe('lengthNote', () => {
  it('is the page count of a single edition', () => {
    expect(lengthNote('page', info())).toBe('of 600 pages')
    expect(lengthNote('percent', info())).toBeUndefined()
  })

  it('names the volume the progress is typed in', () => {
    expect(lengthNote('page', info({ volume: volume(2, 2) }))).toBe('Vol 2 of 2 · of 600 pages')
    expect(lengthNote('seconds', info({ volume: volume(2, 3) }))).toBe('Vol 2 of 3')
  })
})
