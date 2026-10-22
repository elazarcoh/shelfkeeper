import { describe, expect, it } from 'vitest'
import translated from '../../../../../packages/domain/src/providers/fixtures/simania-translated-series.json'
import { captureFromHash, rememberReceived, rememberTarget, takeTarget, wasJustReceived } from './capture-target'

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } }

describe('capture target', () => {
  it('is taken once, and expires after ten minutes', () => {
    const s = memory()
    rememberTarget({ kind: 'row', key: 'k1' }, s, 0)
    expect(takeTarget(s, 60_000)).toEqual({ kind: 'row', key: 'k1' })
    expect(takeTarget(s, 60_000)).toBeNull()
    rememberTarget({ kind: 'proposal', id: 'p' }, s, 0)
    expect(takeTarget(s, 11 * 60_000)).toBeNull()
  })
  it('only takes a target of an accepted kind, and leaves the others for their page', () => {
    const s = memory()
    rememberTarget({ kind: 'proposal', id: 'p' }, s, 0)
    expect(takeTarget(s, 1000, ['row', 'search'])).toBeNull()
    expect(takeTarget(s, 2000)).toEqual({ kind: 'proposal', id: 'p' })
  })
  it("remembers a book's own Fetch details, and drops a work target without an id", () => {
    const s = memory()
    rememberTarget({ kind: 'work', id: 'w1' }, s, 0)
    expect(takeTarget(s, 1000, ['proposal'])).toBeNull()
    expect(takeTarget(s, 1000, ['work'])).toEqual({ kind: 'work', id: 'w1' })
    s.setItem('mylib.shelf.target', JSON.stringify({ target: { kind: 'work' }, at: 0 }))
    expect(takeTarget(s, 1000)).toBeNull()
  })
  it("remembers one copy's Fetch metadata, and drops an edition target without an id", () => {
    const s = memory()
    rememberTarget({ kind: 'edition', id: 'e1' }, s, 0)
    expect(takeTarget(s, 1000, ['work', 'edition'])).toEqual({ kind: 'edition', id: 'e1' })
    s.setItem('mylib.shelf.target', JSON.stringify({ target: { kind: 'edition' }, at: 0 }))
    expect(takeTarget(s, 1000)).toBeNull()
  })
  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } }
    expect(() => rememberTarget({ kind: 'search' }, broken, 0)).not.toThrow()
    expect(takeTarget(broken, 0)).toBeNull()
  })
  it('reads a capture from the hash, and nothing else', () => {
    expect(captureFromHash(`#capture=${encodeURIComponent(JSON.stringify(translated))}`)?.url).toBe(translated.url)
    expect(captureFromHash('#capture=%7Bbad')).toBeNull()
    expect(captureFromHash('#other')).toBeNull()
  })
  it('knows a page that just came by message, for a minute', () => {
    const s = memory()
    expect(wasJustReceived('https://a', s, 0)).toBe(false)
    rememberReceived('https://a', s, 0)
    expect(wasJustReceived('https://a', s, 30_000)).toBe(true)
    expect(wasJustReceived('https://b', s, 30_000)).toBe(false)
    expect(wasJustReceived('https://a', s, 61_000)).toBe(false)
    s.setItem('mylib.shelf.received', '{bad')
    expect(wasJustReceived('https://a', s, 0)).toBe(false)
  })
})
