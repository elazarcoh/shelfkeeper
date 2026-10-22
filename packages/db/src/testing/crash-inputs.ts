import { CsvImportInput } from '@mylib/domain'

export const CRASH_ROWS = 300
export const CRASH_IMPORT_ID = 'c2111111-1111-4111-8111-000000000001'
/** Where the crash child's importCsv hook pauses (well short of CRASH_ROWS, so the crash test stays fast). */
export const CRASH_STOP_AFTER_ROW = 50
/** The child's marker once it has paused there, for the parent to wait on deterministically. */
export const CRASH_PAUSED_MARKER = `crash test: paused after row ${CRASH_STOP_AFTER_ROW}`

/** A mid-sized import (well past CRASH_STOP_AFTER_ROW; the product allows up to 2000 rows), always the same file pick. */
export function crashCsvInput(): CsvImportInput {
  return CsvImportInput.parse({
    fileName: 'crash-test.csv',
    header: ['Title', 'Author', 'Date Read', 'My Rating'],
    rows: Array.from({ length: CRASH_ROWS }, (_, i) => [`Crash book ${i + 1}`, `Author ${i % 40}`, '2024/05/14', String((i % 5) + 1)]),
    mapping: { columns: { title: 0, authors: 1, finishedOn: 2, rating: 3 } },
    ownership: 'owned',
    importId: CRASH_IMPORT_ID,
  })
}
