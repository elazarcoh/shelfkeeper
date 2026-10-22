import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CSV_MAX_CELL, csvFields, type CsvDateOrder } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { csvShelfLabel } from '@/features/inbox/resolution'
import { trpc } from '@/lib/trpc'
import {
  CSV_MAX_FILE_BYTES,
  csvFieldLabel,
  draftFromText,
  importPayloadTooLarge,
  mappingFormFrom,
  newImportId,
  previewRows,
  summarize,
  toMapping,
  type CsvDraft,
  type MappingForm,
} from './csv-import-state'

const PREVIEW = 5
const INVALID_SHOWN = 20

type PreviewValue = Extract<ReturnType<typeof previewRows>[number]['result'], { ok: true }>['value']

/** "Read 2024-03-12 · ★ 5", in the Inbox's words; a "read" shelf is left out when the read date already says it. */
function previewDetails(v: PreviewValue): string {
  const parts: string[] = []
  if (v.read) parts.push(`Read ${v.read.finishedOn}`)
  if (v.shelf !== null && !(v.shelf === 'read' && v.read)) parts.push(csvShelfLabel[v.shelf])
  if (v.rating !== null) parts.push(`★ ${v.rating}`)
  return parts.join(' · ')
}

export function CsvImport() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<CsvDraft | null>(null)
  const [form, setForm] = useState<MappingForm | null>(null)
  /** one per file pick (made in the pick handler, never at render): a retry of the same pick reuses it */
  const [importId, setImportId] = useState<string | null>(null)
  const mapping = useMemo(() => (form === null ? null : toMapping(form)), [form])
  const computed = useMemo(() => {
    if (draft === null || !mapping?.ok) return null
    return { preview: previewRows(draft, mapping.value, PREVIEW), summary: summarize(draft, mapping.value) }
  }, [draft, mapping])
  const importCsv = useMutation(
    trpc.csv.import.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
        if (result.alreadyImported) {
          toast.success('Already imported')
          return
        }
        toast.success(`${result.proposals} ${result.proposals === 1 ? 'book' : 'books'} sent to your Inbox${result.invalid.length > 0 ? ` (${result.invalid.length} rows skipped)` : ''}`)
      },
    }),
  )

  async function pick(file: File | undefined) {
    if (!file) return
    if (file.size > CSV_MAX_FILE_BYTES) {
      toast.error('The file is larger than 4 MB — split it into smaller files')
      return
    }
    const result = draftFromText(file.name, await file.text())
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    setDraft(result.value)
    setForm(mappingFormFrom(result.value.header))
    setImportId(newImportId())
    importCsv.reset()
  }

  const setColumn = (field: (typeof csvFields)[number], value: string) =>
    setForm((f) => (f === null ? f : { ...f, columns: { ...f.columns, [field]: value } }))

  function submit() {
    if (draft === null || form === null || importId === null || !mapping?.ok) return
    const input = { fileName: draft.fileName, header: draft.header, rows: draft.rows, lines: draft.lines, mapping: mapping.value, ownership: form.ownership, importId }
    if (importPayloadTooLarge(input)) {
      toast.error('This file is too large to send in one go — try removing large columns (like a review or notes column) and import again')
      return
    }
    importCsv.mutate(input)
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <Field label="CSV file" htmlFor="csv-file" hint="A Goodreads export works as is. The first row must name the columns.">
        <Input id="csv-file" type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </Field>

      {draft !== null && form !== null ? (
        <>
          {draft.truncatedCells > 0 ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {draft.truncatedCells} {draft.truncatedCells === 1 ? 'cell was' : 'cells were'} longer than {CSV_MAX_CELL} characters and will be shortened
            </p>
          ) : null}
          <section aria-labelledby="csv-mapping" className="grid gap-3">
            <h2 id="csv-mapping" className="text-lg font-semibold">
              Which column is which?
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {csvFields.map((field) => (
                <Field key={field} label={csvFieldLabel[field]} htmlFor={`csv-col-${field}`}>
                  <NativeSelect id={`csv-col-${field}`} value={form.columns[field]} onChange={(e) => setColumn(field, e.target.value)}>
                    <option value="">{field === 'title' ? 'Choose…' : 'Not in this file'}</option>
                    {draft.header.map((name, i) => (
                      <option key={`${name}-${i}`} value={String(i)} dir="auto">
                        {name === '' ? `Column ${i + 1}` : name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
              <Field label="Dates like 04/05/2023 are" htmlFor="csv-date-order">
                <NativeSelect id="csv-date-order" value={form.dateOrder} onChange={(e) => setForm({ ...form, dateOrder: e.target.value as CsvDateOrder })}>
                  <option value="ymd">Only read when unambiguous</option>
                  <option value="dmy">Day / month / year</option>
                  <option value="mdy">Month / day / year</option>
                </NativeSelect>
              </Field>
              <Field label="Ratings are out of" htmlFor="csv-scale">
                <NativeSelect id="csv-scale" value={form.ratingScale} onChange={(e) => setForm({ ...form, ratingScale: e.target.value === '10' ? '10' : '5' })}>
                  <option value="5">5 stars</option>
                  <option value="10">10 points</option>
                </NativeSelect>
              </Field>
              <Field label="These books" htmlFor="csv-ownership">
                <NativeSelect id="csv-ownership" value={form.ownership} onChange={(e) => setForm({ ...form, ownership: e.target.value === 'read_not_owned' ? 'read_not_owned' : 'owned' })}>
                  <option value="owned">Are on my shelf (I own them)</option>
                  <option value="read_not_owned">I read, but don't own</option>
                </NativeSelect>
              </Field>
            </div>
          </section>

          {computed !== null ? (
            <section aria-labelledby="csv-preview" className="grid gap-3">
              <h2 id="csv-preview" className="text-lg font-semibold">
                Preview
              </h2>
              <ul className="divide-y rounded-lg border text-sm">
                {computed.preview.map(({ row, result }) => (
                  // one layout for every row: title, authors, then what the row says (wrap-anywhere: an unbroken
                  // title wraps instead of running under the details beside it)
                  <li key={row} className="grid min-w-0 gap-0.5 p-3">
                    {result.ok ? (
                      <>
                        <span className="font-medium wrap-anywhere text-match-parent" dir="auto">
                          {result.value.item.title}
                        </span>
                        {result.value.item.authors.length > 0 ? (
                          <span className="text-muted-foreground wrap-anywhere text-match-parent" dir="auto">
                            {result.value.item.authors.join(', ')}
                          </span>
                        ) : null}
                        {previewDetails(result.value) !== '' ? <span className="text-muted-foreground tabular-nums">{previewDetails(result.value)}</span> : null}
                      </>
                    ) : (
                      <span className="min-w-0 wrap-anywhere text-destructive" dir="auto">
                        {result.error}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                {computed.summary.valid} books to review ({computed.summary.withRead} with a read date, {computed.summary.withRating} with a rating)
                {computed.summary.invalid > 0 ? ` · ${computed.summary.invalid} rows without a title will be skipped` : ''}
              </p>
              <div>
                {/* disabled once sent so a second click can't re-import the same file; picking a new file (importCsv.reset() in pick) re-enables it */}
                <Button disabled={importCsv.isPending || importCsv.data !== undefined} onClick={submit}>
                  {importCsv.data !== undefined ? 'Sent' : 'Send to my Inbox'}
                </Button>
              </div>
            </section>
          ) : mapping !== null && !mapping.ok ? (
            <p className="text-sm text-destructive">{mapping.message}</p>
          ) : null}

          {importCsv.data ? (
            <section aria-labelledby="csv-result" className="grid gap-3 rounded-lg border p-4">
              <h2 id="csv-result" className="text-lg font-semibold">
                {importCsv.data.alreadyImported ? 'Already imported' : 'Import complete'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {importCsv.data.proposals} {importCsv.data.proposals === 1 ? 'book' : 'books'} sent to your Inbox
                {importCsv.data.invalid.length > 0 ? ` · ${importCsv.data.invalid.length} rows were skipped` : ''}
              </p>
              {importCsv.data.invalid.length > 0 ? (
                <ul className="grid gap-1 text-sm">
                  {importCsv.data.invalid.slice(0, INVALID_SHOWN).map((row) => (
                    <li key={row.row} className="min-w-0 break-words text-destructive" dir="auto">
                      Row {row.row}: {row.message}
                    </li>
                  ))}
                  {importCsv.data.invalid.length > INVALID_SHOWN ? (
                    <li className="text-muted-foreground">and {importCsv.data.invalid.length - INVALID_SHOWN} more</li>
                  ) : null}
                </ul>
              ) : null}
              <div>
                <Button asChild variant="outline">
                  <Link to="/inbox">Go to my Inbox</Link>
                </Button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
