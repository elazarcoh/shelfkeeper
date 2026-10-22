import { describe, expect, it } from 'vitest'
import { planSessionFusion, type FusionSession } from './session-fusion'

let n = 0
function s(over: Partial<FusionSession> & { volume: number | null }): FusionSession {
  n += 1
  return {
    id: `s${String(n).padStart(2, '0')}`,
    userId: 'u1',
    mode: 'read',
    editionId: null,
    outcome: 'finished',
    startedOn: '2026-01-01',
    startedPrecision: 'day',
    finishedOn: '2026-01-01',
    finishedPrecision: 'day',
    fractionCompleted: null,
    origin: `o${n}`,
    setKey: null,
    ...over,
  }
}

describe('planSessionFusion', () => {
  it('fuses finished past reads whatever their dates say', () => {
    const a = s({ id: 'a', volume: 1, startedOn: '2026-01-01', finishedOn: '2026-01-01' })
    const b = s({ id: 'b', volume: 2, startedOn: '2025-12-01', finishedOn: '2025-12-01' })
    const reads = planSessionFusion([b, a], 2)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({
      keepId: 'a',
      mergeIds: ['b'],
      volumes: [1, 2],
      startedOn: '2025-12-01',
      finishedOn: '2026-01-01',
      outcome: 'finished',
      fractionCompleted: 1,
    })
  })

  it('chains day reads and ends in progress with the last volume edition', () => {
    const a = s({ id: 'a', volume: 1, editionId: 'e1', startedOn: '2026-01-01', finishedOn: '2026-01-10' })
    const b = s({ id: 'b', volume: 2, editionId: 'e2', outcome: 'in_progress', startedOn: '2026-01-11', finishedOn: null, finishedPrecision: null })
    expect(planSessionFusion([a, b], 2)).toEqual([
      {
        userId: 'u1',
        keepId: 'a',
        mergeIds: ['b'],
        volumes: [1, 2],
        editionId: 'e2',
        startedOn: '2026-01-01',
        startedPrecision: 'day',
        finishedOn: null,
        finishedPrecision: null,
        outcome: 'in_progress',
        fractionCompleted: null,
      },
    ])
  })

  it('does not chain a volume started before the previous one finished', () => {
    const a = s({ volume: 1, startedOn: '2026-01-20', finishedOn: '2026-02-10' })
    const b = s({ volume: 2, outcome: 'abandoned', startedOn: '2026-02-01', finishedOn: '2026-02-05', fractionCompleted: 0.3 })
    expect(planSessionFusion([a, b], 2)).toEqual([])
  })

  it('fuses the reread that follows, not the older read', () => {
    const old = s({ id: 'old', volume: 1, startedOn: '2024-01-01', finishedOn: '2024-02-01' })
    const v1 = s({ id: 'v1', volume: 1, startedOn: '2026-01-01', finishedOn: '2026-02-01' })
    const v2 = s({ id: 'v2', volume: 2, startedOn: '2026-02-05', finishedOn: '2026-03-01' })
    const reads = planSessionFusion([old, v1, v2], 2)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ keepId: 'v1', mergeIds: ['v2'], finishedOn: '2026-03-01' })
  })

  it('never fuses across modes or users', () => {
    const a = s({ volume: 1 })
    expect(planSessionFusion([a, s({ volume: 2, mode: 'listen' })], 2)).toEqual([])
    expect(planSessionFusion([a, s({ volume: 2, userId: 'u2' })], 2)).toEqual([])
  })

  it('scales an abandoned last volume by the volume count', () => {
    const a = s({ volume: 1, finishedOn: '2026-01-10' })
    const b = s({ volume: 2, outcome: 'abandoned', startedOn: '2026-01-11', finishedOn: '2026-01-15', fractionCompleted: 0.4 })
    expect(planSessionFusion([a, b], 3)[0]?.fractionCompleted).toBeCloseTo(1.4 / 3)
  })

  it('lets overlapping month precision follow', () => {
    const a = s({ volume: 1, startedOn: '2026-01-01', finishedOn: '2026-03-01', finishedPrecision: 'month' })
    const b = s({ volume: 2, startedOn: '2026-03-10', startedPrecision: 'month', outcome: 'in_progress', finishedOn: null, finishedPrecision: null })
    expect(planSessionFusion([a, b], 2)).toHaveLength(1)
  })

  it('ignores sessions without a volume', () => {
    expect(planSessionFusion([s({ volume: null }), s({ volume: null })], null)).toEqual([])
  })

  it('lets an unknown-precision finish be followed', () => {
    const a = s({ volume: 1, startedOn: '2026-05-01', finishedOn: '2026-05-01', finishedPrecision: 'unknown' })
    const b = s({ volume: 2, startedOn: '2020-01-01', outcome: 'in_progress', finishedOn: null, finishedPrecision: null })
    expect(planSessionFusion([a, b], 2)).toHaveLength(1)
  })

  it('never fuses two reads of the same book, whatever their volumes', () => {
    const a = s({ volume: 1, editionId: 'e1', origin: 'survivor', setKey: 'physical|he' })
    const b = s({ volume: 2, editionId: 'e2', origin: 'survivor', setKey: 'physical|he' })
    expect(planSessionFusion([a, b], 2)).toEqual([])
  })

  it('fuses a survivor read of volume 1 with a stray book’s read of volume 2', () => {
    const a = s({ id: 'a', volume: 1, origin: 'survivor', setKey: 'physical|he' })
    const b = s({ id: 'b', volume: 2, origin: 'stray', setKey: 'physical|he' })
    expect(planSessionFusion([a, b], 2)).toMatchObject([{ keepId: 'a', mergeIds: ['b'] }])
  })

  it('never fuses reads of different volume sets', () => {
    const a = s({ volume: 1, setKey: 'physical|he' })
    const b = s({ volume: 2, setKey: 'ebook|he' })
    expect(planSessionFusion([a, b], 2)).toEqual([])
  })

  it('ends a chain at a volume it cannot take instead of skipping it', () => {
    const v1 = s({ id: 'v1', volume: 1, origin: 'survivor', startedOn: '2026-01-01', finishedOn: '2026-01-10' })
    const v2 = s({ id: 'v2', volume: 2, origin: 'survivor', startedOn: '2026-01-11', finishedOn: '2026-01-20' })
    const v3 = s({ id: 'v3', volume: 3, origin: 'stray', startedOn: '2026-01-21', finishedOn: '2026-01-30' })
    const reads = planSessionFusion([v1, v2, v3], 3)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ keepId: 'v2', mergeIds: ['v3'], volumes: [2, 3] })
    expect(reads.some((r) => r.volumes.join() === '1,3')).toBe(false)
  })
})
