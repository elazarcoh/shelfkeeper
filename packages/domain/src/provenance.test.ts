import { describe, expect, it } from 'vitest'
import { isLocked, markManual, markSource } from './provenance'

describe('provenance', () => {
  it('marks edited fields manual and locked, keeping others', () => {
    const at = new Date('2026-01-02T03:04:05Z')
    const before = {
      title: { origin: 'source' as const, at: '2025-01-01T00:00:00.000Z', locked: false },
      tags: { origin: 'ai' as const, at: '2025-01-01T00:00:00.000Z', locked: false },
    }
    const after = markManual(before, ['title', 'authors'], at)
    expect(after.title).toEqual({ origin: 'manual', at: at.toISOString(), locked: true })
    expect(isLocked(after, 'authors')).toBe(true)
    expect(isLocked(after, 'tags')).toBe(false)
    expect(isLocked(before, 'title')).toBe(false)
  })
  it('marks fields as coming from a source, unlocked', () => {
    const at = new Date('2026-09-27T10:00:00Z')
    expect(markSource({}, ['title'], '11111111-1111-4111-8111-111111111111', at)).toEqual({
      title: { origin: 'source', sourceId: '11111111-1111-4111-8111-111111111111', at: '2026-09-27T10:00:00.000Z', locked: false },
    })
  })
})
