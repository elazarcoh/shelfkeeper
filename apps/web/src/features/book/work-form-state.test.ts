import { describe, expect, it } from 'vitest'
import { WorkPatch } from '@mylib/domain'
import { changedFields } from '@/lib/form'
import { emptyWorkForm, withTitlesFrom, workFormFromDetail, workFormToInput, workPatchFromForm } from './work-form-state'

const detail = {
  title: 'The Final Empire',
  subtitle: null,
  titleId: 'ttt',
  titles: [{ id: 'ttt', language: 'en', title: 'The Final Empire', subtitle: null, primary: true }],
  description: null,
  originalYear: 2006,
  authors: [{ id: 'a', name: 'Brandon Sanderson', creditedName: 'Brandon Sanderson' }],
  tags: [{ id: 't', name: 'Fantasy' }],
  series: [{ id: 's', name: 'Mistborn', position: 1, positionEnd: null }],
  kind: 'book' as const,
}

describe('work form state', () => {
  it('has no language field (#124)', () => {
    expect('language' in emptyWorkForm()).toBe(false)
    expect('language' in workFormToInput(emptyWorkForm())).toBe(false)
  })
  it('round-trips a work detail', () => {
    const form = workFormFromDetail(detail)
    expect(form.authors).toBe('Brandon Sanderson')
    expect(workFormToInput(form)).toEqual({
      title: 'The Final Empire',
      subtitle: null,
      description: null,
      originalYear: 2006,
      authors: ['Brandon Sanderson'],
      tags: ['Fantasy'],
      series: [{ name: 'Mistborn', position: 1, positionEnd: null }],
      kind: 'book',
    })
  })
  it('edits the shown row: a non-primary title is patched by its id, never the primary (#145)', () => {
    // an English reader of a Hebrew-primary book, whose author is credited in Hebrew
    const initial = workFormFromDetail({
      ...detail,
      title: 'Rhythm of War',
      subtitle: 'Book 4',
      titleId: 'en-row',
      titles: [
        { id: 'he-row', language: 'he', title: 'קצב המלחמה', subtitle: 'ספר 4', primary: true },
        { id: 'en-row', language: 'en', title: 'Rhythm of War', subtitle: 'Book 4', primary: false },
      ],
      authors: [{ id: 'a', name: 'Brandon Sanderson', creditedName: 'ברנדון סנדרסון' }],
    })
    expect(initial).toMatchObject({ title: 'Rhythm of War', subtitle: 'Book 4', titleId: 'en-row', authors: 'ברנדון סנדרסון' })
    expect(workPatchFromForm(initial, { ...initial, description: 'New blurb' })).toEqual({ description: 'New blurb' })
    expect(workPatchFromForm(initial, { ...initial, title: 'Rhythm of War!' })).toEqual({ title: 'Rhythm of War!', titleId: 'en-row' })
    expect(workPatchFromForm(initial, { ...initial, subtitle: '' })).toEqual({ subtitle: null, titleId: 'en-row' })
  })
  it('leaves titleId out when the shown row is the primary', () => {
    const initial = workFormFromDetail(detail)
    expect(workPatchFromForm(initial, { ...initial, title: 'Mistborn' })).toEqual({ title: 'Mistborn' })
  })
  it('carries the kind, and a title-only edit does not change it (#133)', () => {
    const initial = workFormFromDetail({ ...detail, kind: 'fanfiction' })
    expect(initial.kind).toBe('fanfiction')
    expect(workFormToInput(initial).kind).toBe('fanfiction')
    const changed = changedFields(workFormToInput(initial), workFormToInput({ ...initial, title: 'New' }))
    expect(changed).toEqual({ title: 'New' })
  })
  it('sends the kind when the person touched the select, even back to the same value, so Book can be locked (#133)', () => {
    const initial = workFormFromDetail(detail)
    expect(workPatchFromForm(initial, { ...initial, title: 'New' })).toEqual({ title: 'New' })
    expect(workPatchFromForm(initial, { ...initial, kindTouched: true })).toEqual({ kind: 'book' })
    expect(workPatchFromForm(initial, { ...initial, kind: 'web_serial', kindTouched: true })).toEqual({ kind: 'web_serial' })
  })
  it('drops blank series rows and keeps unknown positions', () => {
    const form = { ...emptyWorkForm(), series: [{ name: 'Cosmere', position: '' }, { name: ' ', position: '3' }] }
    expect(workFormToInput(form).series).toEqual([{ name: 'Cosmere', position: null, positionEnd: null }])
  })
  it('shows and reads a range; unreadable or backwards text fails validation (#122)', () => {
    const form = workFormFromDetail({ ...detail, series: [{ id: 's', name: 'Mage Errant', position: 1, positionEnd: 2 }] })
    expect(form.series).toEqual([{ name: 'Mage Errant', position: '1–2' }])
    expect(workFormToInput(form).series).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(workFormToInput({ ...form, series: [{ name: 'S', position: '1 - 3' }] }).series).toEqual([{ name: 'S', position: 1, positionEnd: 3 }])
    for (const position of ['2-1', 'abc']) {
      const r = WorkPatch.safeParse({ series: workFormToInput({ ...form, series: [{ name: 'S', position }] }).series })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]?.message).toBe('Use a number like 3 or a range like 1-2')
    }
  })
  it('a backwards range typed where there was no position is a change Edit book validates (#122)', () => {
    const before = workFormFromDetail({ ...detail, series: [{ id: 's', name: 'S', position: null, positionEnd: null }] })
    const changed = changedFields(workFormToInput(before), workFormToInput({ ...before, series: [{ name: 'S', position: '2-1' }] }))
    expect(Object.keys(changed)).toEqual(['series'])
    expect(WorkPatch.safeParse(changed).success).toBe(false)
  })
  it('patches only what changed', () => {
    const before = workFormFromDetail(detail)
    const after = { ...before, authors: 'Brandon Sanderson\nIsaac Stewart' }
    expect(changedFields(workFormToInput(before), workFormToInput(after))).toEqual({
      authors: ['Brandon Sanderson', 'Isaac Stewart'],
    })
  })
})

describe('withTitlesFrom (#145)', () => {
  it('takes the title fields from the new initial and keeps the other edits', () => {
    const old = workFormFromDetail({ ...detail, title: 'Rhythm of War', subtitle: null, titleId: 'en-row', titles: [{ id: 'he-row', language: 'he', title: 'קצב', subtitle: null, primary: true }, { id: 'en-row', language: 'en', title: 'Rhythm of War', subtitle: null, primary: false }] })
    const typed = { ...old, description: 'My blurb', tags: 'Fantasy, Epic', title: 'stale typing' }
    // the list renamed the shown row, then the book reloaded
    const fresh = workFormFromDetail({ ...detail, title: 'Rhythm of War 4', titleId: 'en-row', titles: [{ id: 'he-row', language: 'he', title: 'קצב', subtitle: null, primary: true }, { id: 'en-row', language: 'en', title: 'Rhythm of War 4', subtitle: null, primary: false }] })
    const reseeded = withTitlesFrom(typed, fresh)
    expect(reseeded).toMatchObject({ title: 'Rhythm of War 4', subtitle: '', titleId: 'en-row', description: 'My blurb', tags: 'Fantasy, Epic' })
    expect(workPatchFromForm(fresh, reseeded)).toEqual({ description: 'My blurb', tags: ['Fantasy', 'Epic'] })
  })
  it('drops a titleId that became the primary', () => {
    const fresh = workFormFromDetail(detail)
    const stale = { ...fresh, titleId: 'gone-row' }
    const reseeded = withTitlesFrom(stale, fresh)
    expect(reseeded.titleId).toBeUndefined()
    expect(workPatchFromForm(fresh, reseeded)).toEqual({})
  })
})
