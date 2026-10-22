import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CSV_MAX_CELL, CSV_MAX_ROWS } from '@mylib/domain'
import {
  CSV_MAX_FILE_BYTES,
  CSV_MAX_IMPORT_BYTES,
  draftFromText,
  importPayloadTooLarge,
  mappingFormFrom,
  newImportId,
  previewRows,
  summarize,
  toMapping,
} from './csv-import-state'

const text = 'Title,Author,My Rating,Date Read\nProject Hail Mary,Andy Weir,5,2023/05/14\n,Nobody,,\nThe Martian,Andy Weir,0,\n'

describe('csv import state', () => {
  it('splits the file into a header and rows, refusing empty and oversized files', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(draftFromText('gr.csv', text)).toMatchObject({ ok: true, value: { fileName: 'gr.csv', header: ['Title', 'Author', 'My Rating', 'Date Read'], rows: [[], [], []].map(() => expect.any(Array)) } })
    expect(draftFromText('empty.csv', 'Title\n')).toEqual({ ok: false, message: 'The file needs a header row and at least one book' })
    const big = `Title\n${Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `Book ${i}`).join('\n')}`
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(draftFromText('big.csv', big)).toMatchObject({ ok: false, message: expect.stringContaining(`${CSV_MAX_ROWS}`) })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(draftFromText('huge.csv', `Title\n${'x'.repeat(CSV_MAX_FILE_BYTES)}`)).toMatchObject({ ok: false, message: expect.stringContaining('4 MB') })
  })

  it('pre-fills the mapping from the header and requires a title column', () => {
    const draft = draftFromText('gr.csv', text)
    if (!draft.ok) throw new Error(draft.message)
    const form = mappingFormFrom(draft.value.header)
    expect(form.columns).toMatchObject({ title: '0', authors: '1', rating: '2', finishedOn: '3', isbn: '' })
    expect(toMapping({ ...form, columns: { ...form.columns, title: '' } })).toEqual({ ok: false, message: 'Choose the column that holds the title' })
  })

  it('previews mapped rows and summarises what the import will create', () => {
    const draft = draftFromText('gr.csv', text)
    if (!draft.ok) throw new Error(draft.message)
    const mapping = toMapping(mappingFormFrom(draft.value.header))
    if (!mapping.ok) throw new Error(mapping.message)
    expect(previewRows(draft.value, mapping.value, 2).map((p) => [p.row, p.result.ok])).toEqual([
      [2, true],
      [3, false],
    ])
    expect(summarize(draft.value, mapping.value)).toEqual({ valid: 2, invalid: 1, withRead: 1, withRating: 1 })
  })

  it('numbers preview rows by their real file line, past a blank line and a multi-line cell', () => {
    const draft = draftFromText('gr.csv', 'Title,Notes\nDune,"two\nlines"\n\n,no title\nEmma,x\n')
    if (!draft.ok) throw new Error(draft.message)
    expect(draft.value.lines).toEqual([2, 5, 6])
    const mapping = toMapping(mappingFormFrom(draft.value.header))
    if (!mapping.ok) throw new Error(mapping.message)
    expect(previewRows(draft.value, mapping.value, 5).map((p) => [p.row, p.result.ok ? p.result.value.item.externalId : p.result.error])).toEqual([
      [2, 'row:2'],
      [5, 'Row 5: no title'],
      [6, 'row:6'],
    ])
    expect(summarize(draft.value, mapping.value)).toMatchObject({ valid: 2, invalid: 1 })
  })

  it('counts cells that get shortened, so the page can warn about it before import', () => {
    const long = 'x'.repeat(CSV_MAX_CELL + 10)
    expect(draftFromText('t.csv', `Title,Notes\nBook One,${long}\nBook Two,short\n`)).toMatchObject({ ok: true, value: { truncatedCells: 1 } })
    expect(draftFromText('gr.csv', text)).toMatchObject({ ok: true, value: { truncatedCells: 0 } })
  })

  it('names each file pick with a fresh, valid uuid — also where crypto.randomUUID is missing (plain http)', () => {
    const a = newImportId()
    expect(z.uuid().safeParse(a).success).toBe(true)
    expect(newImportId()).not.toBe(a)
    // plain http on the home network is not a secure context: no randomUUID, but getRandomValues works
    const b = newImportId({ getRandomValues: (bytes) => crypto.getRandomValues(bytes) })
    expect(z.uuid().safeParse(b).success).toBe(true)
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('flags import payloads that would trip the server\'s 8 MB body limit, with room to spare', () => {
    expect(CSV_MAX_IMPORT_BYTES).toBe(7.5 * 1024 * 1024)
    expect(importPayloadTooLarge({ rows: [['x'.repeat(7.6 * 1024 * 1024)]] })).toBe(true)
    expect(importPayloadTooLarge({ rows: [['a', 'b']] })).toBe(false)
    const huge = { rows: Array.from({ length: 100_000 }, () => ['x'.repeat(200)]) }
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(CSV_MAX_IMPORT_BYTES)
    expect(importPayloadTooLarge(huge)).toBe(true)
  })
})
