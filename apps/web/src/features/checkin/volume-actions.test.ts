import { describe, expect, it } from 'vitest'
import type { SessionProgressInfo } from '@mylib/domain'
import { volumeActions } from './volume-actions'

const info = (volume: SessionProgressInfo['volume']): SessionProgressInfo =>
  ({ editionFormat: 'physical', pageCount: 400, durationSec: null, latest: null, pointCount: 0, highest: null, volume })
const ctx = (volume: number, size: number, waiting = false) => ({ volume, size, volumes: [], waiting })

describe('volumeActions', () => {
  it('offers finishing the volume mid-set', () => {
    expect(volumeActions(info(ctx(1, 2)))).toEqual({ finishVolume: { label: 'Finished volume 1' }, finishBookLabel: 'Finished the book', waiting: null })
  })
  it('is the plain finish on the last volume and outside a set', () => {
    expect(volumeActions(info(ctx(2, 2)))).toEqual({ finishVolume: null, finishBookLabel: 'Finished', waiting: null })
    expect(volumeActions(info(null))).toEqual({ finishVolume: null, finishBookLabel: 'Finished', waiting: null })
  })
  it('says what it is waiting for', () => {
    expect(volumeActions(info(ctx(1, 2, true)))).toEqual({ finishVolume: null, finishBookLabel: 'Finish reading anyway', waiting: 'Waiting for volume 2' })
  })
})
