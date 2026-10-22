import { describe, expect, it } from 'vitest'
import type { AbsPushField } from '@mylib/domain'
import { isRunning, listedResults, resultLine, sendable, watchedRun, type PushRow } from './abs-push-state'

const diff = (field: AbsPushField) => ({ field, from: 'a', to: 'b', hash: field.padEnd(64, '0') })
const rows: PushRow[] = [
  { sourceItemId: 'b1', workId: 'w1', title: 'One', diffs: [diff('title'), diff('authors')] },
  { sourceItemId: 'b2', workId: 'w2', title: 'Two', diffs: [diff('series')] },
]
const none = new Map<string, Set<AbsPushField>>()

describe('sendable', () => {
  it('sends the ticked fields that differ, with their hashes', () => {
    expect(sendable(rows, ['title', 'series'], new Set(), none)).toEqual([
      { sourceItemId: 'b1', fields: [{ field: 'title', hash: diff('title').hash }] },
      { sourceItemId: 'b2', fields: [{ field: 'series', hash: diff('series').hash }] },
    ])
  })
  it('a global untick removes the field everywhere', () => {
    expect(sendable(rows, ['authors'], new Set(), none).map((b) => b.sourceItemId)).toEqual(['b1'])
  })
  it('a per-book untick removes it for that book only', () => {
    const books = sendable(rows, ['title', 'authors', 'series'], new Set(), new Map([['b1', new Set<AbsPushField>(['title'])]]))
    expect(books[0]?.fields.map((f) => f.field)).toEqual(['authors'])
    expect(books[1]?.fields.map((f) => f.field)).toEqual(['series'])
  })
  it('drops an excluded book and a book left with no fields', () => {
    expect(sendable(rows, ['title', 'series'], new Set(['b1']), none).map((b) => b.sourceItemId)).toEqual(['b2'])
    expect(sendable(rows, ['title'], new Set(), new Map([['b1', new Set<AbsPushField>(['title'])]]))).toEqual([])
  })
})

describe('resultLine', () => {
  it('counts failed, skipped and not sent as failed', () => {
    const r = (outcome: 'sent' | 'failed' | 'skipped' | 'not_sent') => ({ sourceItemId: 'x', title: 'T', outcome, message: null })
    expect(resultLine([r('sent'), r('sent'), r('failed'), r('skipped')])).toBe('Sent 2 · 2 failed')
    expect(resultLine([r('sent'), r('not_sent')])).toBe('Sent 1 · 1 failed')
  })
})

describe('watchedRun and isRunning', () => {
  it('keeps a run found running after a reload once it finishes', () => {
    const first = watchedRun(null, { id: 'r1', status: 'running' })
    expect(first).toBe('r1')
    expect(watchedRun(first, { id: 'r1', status: 'succeeded' })).toBe('r1')
    expect(watchedRun(null, { id: 'r1', status: 'succeeded' })).toBeNull()
    expect(watchedRun(null, null)).toBeNull()
  })
  it('is running until finished, and not when the query failed', () => {
    expect(isRunning(null, undefined, false)).toBe(false)
    expect(isRunning('r', undefined, false)).toBe(true)
    expect(isRunning('r', { status: 'running' }, false)).toBe(true)
    expect(isRunning('r', { status: 'stopped' }, false)).toBe(false)
    expect(isRunning('r', undefined, true)).toBe(false)
  })
})

describe('listedResults', () => {
  it('lists failures and sent books that carry a note, not clean sends', () => {
    const r = (sourceItemId: string, outcome: 'sent' | 'failed' | 'skipped' | 'not_sent', message: string | null) => ({ sourceItemId, title: 'T', outcome, message })
    const listed = listedResults([r('a', 'sent', null), r('b', 'sent', 'sent, but Audiobookshelf stored Title differently'), r('c', 'failed', 'x'), r('d', 'not_sent', null)])
    expect(listed.map((x) => x.sourceItemId)).toEqual(['b', 'c', 'd'])
  })
})
