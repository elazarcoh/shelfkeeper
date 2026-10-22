import { describe, expect, it } from 'vitest'
import type { ExtractedPage, ShelfRow, ShelfStatus } from '@mylib/domain'
import { applyStatuses, batchLabel, editRow, importRows, rowFromExtracted, rowsFromAnswer, rowWithVolume, settleStatuses, setPreset, shownTitle, toggle } from './shelf-state'

const r = (title: string): ShelfRow => ({ title, subtitle: null, authors: [], translators: [], publisher: null, series: null, seriesNumber: null, volume: null, volumeCount: null, volumeSet: false, language: 'he', spineText: null, originalTitle: null, confidence: null, notes: null })
const W = '66666666-6666-4666-8666-666666666666'

describe('shelf review state', () => {
  it('checks new, copy-of and maybe rows; unchecks have, in-inbox and repeats; copy-of presets the book', () => {
    let n = 0
    const rows = applyStatuses(rowsFromAnswer([r('a'), r('b'), r('c'), r('d'), r('e'), r('f')], () => `k${n++}`), [
      { kind: 'new' }, { kind: 'copy_of', workId: W, title: 'B' }, { kind: 'maybe', workId: W, title: 'C' },
      { kind: 'have', workId: W, title: 'D' }, { kind: 'in_inbox', proposalId: 'p', title: 'E' }, { kind: 'repeat', of: 0 },
    ])
    expect(rows.map((x) => x.checked)).toEqual([true, true, true, false, false, false])
    expect(rows[1]?.preset).toEqual({ workId: W, title: 'B' })
    expect(importRows(rows).map((x) => [x.row.title, x.preset])).toEqual([['a', null], ['b', { workId: W }], ['c', null]])
  })
  it('a row the person toggled keeps their choice when statuses arrive again', () => {
    let rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'have', workId: W, title: 'A' }])
    rows = toggle(rows, 'k')
    rows = applyStatuses(rows, [{ kind: 'have', workId: W, title: 'A' }])
    expect(rows[0]?.checked).toBe(true)
  })
  it('ticking a have row presets its book as a second copy; unticking removes it', () => {
    let rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'have', workId: W, title: 'A' }])
    expect(rows[0]?.preset).toBeNull()
    rows = toggle(rows, 'k')
    expect(rows[0]).toMatchObject({ checked: true, preset: { workId: W, title: 'A' } })
    rows = applyStatuses(rows, [{ kind: 'have', workId: W, title: 'A' }])
    expect(importRows(rows)[0]?.preset).toEqual({ workId: W })
    rows = toggle(rows, 'k')
    expect(rows[0]?.preset).toBeNull()
  })
  it('unticking a copy-of row keeps its preset', () => {
    let rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'copy_of', workId: W, title: 'A' }])
    rows = toggle(rows, 'k')
    expect(rows[0]).toMatchObject({ checked: false, preset: { workId: W } })
  })
  it('editing a row clears its status until it is previewed again', () => {
    const rows = editRow(applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'new' }]), 'k', { title: 'b' })
    expect(rows[0]).toMatchObject({ row: { title: 'b' }, status: null })
  })
  it('labels a batch with the client day', () => {
    expect(batchLabel('2026-10-12')).toBe('Shelf · 12 Oct')
  })
  it('reads a book page as a row', () => {
    const page: ExtractedPage = { provider: 'simania', providerId: '1', url: 'https://simania.co.il/bookdetails.php?item_id=1', title: 'T', subtitle: null, authors: ['A'], translators: [], publisher: 'P', year: null, publishedOn: null, pageCount: null, isbn13: null, isbn10: null, series: { name: 'S', position: 3 }, language: 'he', coverUrl: null, description: null, volume: null, importedTitle: null }
    expect(rowFromExtracted(page)).toMatchObject({ title: 'T', authors: ['A'], series: 'S', seriesNumber: '3', publisher: 'P' })
  })
  it('a page whose title lost a volume marker shows it again only for "not a volume"', () => {
    const page: ExtractedPage = { provider: 'simania', providerId: '1', url: 'https://simania.co.il/bookdetails.php?item_id=1', title: 'Henry IV', subtitle: null, authors: [], translators: [], publisher: null, year: null, publishedOn: null, pageCount: null, isbn13: null, isbn10: null, series: null, language: null, coverUrl: null, description: null, volume: { number: 1, count: null }, importedTitle: 'Henry IV, Part 1' }
    expect(shownTitle(page, { number: 1, count: null })).toBe('Henry IV')
    expect(shownTitle(page, null)).toBe('Henry IV, Part 1')
    expect(rowWithVolume(page, null)).toMatchObject({ title: 'Henry IV, Part 1', volume: null, volumeSet: true })
    expect(rowWithVolume(page, { number: 2, count: 3 })).toMatchObject({ title: 'Henry IV', volume: 2, volumeCount: 3, volumeSet: true })
    expect(shownTitle({ ...page, importedTitle: null }, null)).toBe('Henry IV')
  })
  it('an edit that changes nothing keeps the status and a chosen book', () => {
    let rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'maybe', workId: W, title: 'A' }])
    rows = setPreset(rows, 'k', { workId: W, title: 'A' })
    const same = editRow(rows, 'k', { title: ' a ', authors: [], seriesNumber: null })
    expect(same).toBe(rows)
    expect(same[0]).toMatchObject({ preset: { workId: W }, status: { kind: 'maybe' } })
  })
  it('rows still unchecked after a failed preview become new', () => {
    const rows = settleStatuses(rowsFromAnswer([r('a')], () => 'k'))
    expect(rows[0]?.status).toEqual({ kind: 'new' })
  })
})

describe('volumes in the review', () => {
  const nv: ShelfStatus = { kind: 'new_volume', workId: W, title: 'דרך המלכים', volume: { number: 2, have: [1], size: 2 } }
  it('a new volume is checked and presets the book', () => {
    const rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [nv])
    expect(rows[0]).toMatchObject({ checked: true, preset: { workId: W, title: 'דרך המלכים' } })
  })
  it('correcting only the volume resets the status so the preview runs again', () => {
    const rows = applyStatuses(rowsFromAnswer([r('a')], () => 'k'), [{ kind: 'new' }])
    const next = editRow(rows, 'k', { volume: 2, volumeCount: 3, volumeSet: true })
    expect(next[0]).toMatchObject({ status: null, row: { volume: 2, volumeCount: 3, volumeSet: true } })
    const same = editRow(next, 'k', { volume: 2, volumeCount: 3, volumeSet: true })
    expect(same).toBe(next)
  })
})
