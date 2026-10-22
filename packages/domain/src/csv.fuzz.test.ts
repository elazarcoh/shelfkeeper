import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CSV_MAX_CELL, CSV_MAX_COLUMNS, CSV_MAX_ROWS, CsvImportInput, CsvMapping, CsvRowPayload, mapCsvRow, parseCsv, parseCsvWithLines } from './csv'

const RUNS = 2000
/** The characters that matter to a CSV parser, plus Hebrew and a BOM. */
const csvChar = fc.constantFrom('a', 'Z', '1', ' ', '"', ',', ';', '\t', '\n', '\r', '=', '#', 'א', 'ש', '﻿', '/', '-', '.')
const csvText = fc.string({ unit: csvChar, maxLength: 400 })
const anyText = fc.string({ unit: 'binary', maxLength: 400 })
const IsoDate = z.iso.date()

describe('CSV parsing never breaks (spec §7)', () => {
  it('parses any text without throwing: every record has a non-blank cell, and line numbers only go up', () => {
    fc.assert(
      fc.property(fc.oneof(csvText, anyText), (text) => {
        const records = parseCsvWithLines(text)
        records.forEach((record, i) => {
          expect(record.cells.some((c) => c.trim() !== '')).toBe(true)
          if (i > 0) expect(record.line).toBeGreaterThan(records[i - 1]?.line ?? 0)
        })
        expect(parseCsv(text)).toEqual(records.map((r) => r.cells))
      }),
      { numRuns: RUNS },
    )
  })

  it('reads back any grid written with RFC 4180 quoting', () => {
    const cell = fc.string({ unit: csvChar, maxLength: 20 })
    const grid = fc.integer({ min: 1, max: 6 }).chain((cols) => fc.array(fc.array(cell, { minLength: cols, maxLength: cols }), { minLength: 1, maxLength: 12 }))
    fc.assert(
      fc.property(grid, (rows) => {
        const text = rows.map((row) => row.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\r\n')
        expect(parseCsv(text)).toEqual(rows.filter((row) => row.some((c) => c.trim() !== '')))
      }),
      { numRuns: RUNS },
    )
  })

  it('maps any row with any mapping without throwing, and a mapped row always fits the proposal payload', () => {
    const column = fc.option(fc.integer({ min: 0, max: CSV_MAX_COLUMNS - 1 }), { nil: null })
    const mapping = fc.record({
      columns: fc.record({
        title: fc.integer({ min: 0, max: 11 }),
        authors: column,
        isbn: column,
        series: column,
        seriesPosition: column,
        publisher: column,
        publishedOn: column,
        pageCount: column,
        language: column,
        tags: column,
        finishedOn: column,
        rating: column,
        shelf: column,
      }),
      dateOrder: fc.constantFrom('ymd' as const, 'dmy' as const, 'mdy' as const),
      ratingScale: fc.constantFrom(5 as const, 10 as const),
    })
    const realistic = fc.constantFrom('2023/05/14', '14/05/2023', '2023-02-30', '="9780593135204"', '4.5', '10', '0', '-3', 'read', 'to-read', 'currently-reading', 'Mistborn (Mistborn, #1)', '1,5', '99999999999')
    const row = fc.array(fc.oneof(fc.string({ unit: csvChar, maxLength: 60 }), realistic), { maxLength: 12 })
    fc.assert(
      fc.property(row, mapping, fc.integer({ min: 2, max: 10_000_000 }), (cells, m, line) => {
        const result = mapCsvRow(cells, line, CsvMapping.parse(m))
        if (!result.ok) {
          expect(result.error).toMatch(/^Row \d+: /)
          return
        }
        const { item, read, rating, shelf } = result.value
        expect(item.externalId).toBe(`row:${line}`)
        expect(item.title.trim()).not.toBe('')
        if (read !== null) expect(IsoDate.safeParse(read.finishedOn).success).toBe(true)
        // what importCsv stores must parse again when the proposal is read back
        const payload = { sourceId: '11111111-1111-4111-8111-111111111111', sourceItemId: '22222222-2222-4222-8222-222222222222', item, read, rating, shelf, ownership: 'owned' }
        expect(CsvRowPayload.safeParse(payload).success).toBe(true)
      }),
      { numRuns: RUNS },
    )
  })

  it('enforces the import limits and never throws on any input shape', () => {
    const base = { fileName: 'x.csv', header: ['Title'], mapping: { columns: { title: 0 } }, ownership: 'owned', importId: '11111111-1111-4111-8111-111111111111' }
    expect(CsvImportInput.safeParse({ ...base, rows: Array.from({ length: CSV_MAX_ROWS }, () => ['t']) }).success).toBe(true)
    expect(CsvImportInput.safeParse({ ...base, rows: Array.from({ length: CSV_MAX_ROWS + 1 }, () => ['t']) }).success).toBe(false)
    expect(CsvImportInput.safeParse({ ...base, rows: [Array.from({ length: CSV_MAX_COLUMNS + 1 }, () => 'x')] }).success).toBe(false)
    expect(CsvImportInput.safeParse({ ...base, rows: [['x'.repeat(CSV_MAX_CELL + 1)]] }).success).toBe(false)
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => CsvImportInput.safeParse(value)).not.toThrow()
      }),
      { numRuns: RUNS },
    )
  })

  it('does not hang on pathological input', () => {
    const started = Date.now()
    for (const text of ['"'.repeat(200_000), ','.repeat(200_000), '\n'.repeat(200_000), 'a"'.repeat(100_000), '"a'.repeat(100_000), '\r'.repeat(200_000)]) parseCsvWithLines(text)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
