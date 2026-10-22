import { describe, expect, it } from 'vitest'
import { shelfProgress } from './shelf-progress'

const WORK = '71111111-1111-4111-8111-000000000001'
const SESSION = '71111111-1111-4111-8111-000000000002'

describe("Home's Currently reading progress row", () => {
  it('is absent (no bar, no reserved row: the cards are exactly as before) for a reader without progress points', () => {
    expect(shelfProgress([])).toBeUndefined()
  })

  it('is absent while progress loads, so a reader who never uses progress never sees a blank row', () => {
    expect(shelfProgress(undefined)).toBeUndefined()
  })

  it('maps each work to its fraction once there is at least one current point', () => {
    const map = shelfProgress([{ workId: WORK, sessionId: SESSION, on: '2026-10-06', fraction: 0.4 }])
    expect(map).toEqual(new Map([[WORK, 0.4]]))
  })
})
