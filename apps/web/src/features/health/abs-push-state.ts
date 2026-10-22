import type { AbsPushField, AbsPushSendInput } from '@mylib/domain'

export interface PushRow {
  sourceItemId: string
  workId: string
  title: string
  diffs: { field: AbsPushField; from: string; to: string; hash: string }[]
}
export interface PushResult {
  sourceItemId: string
  title: string
  outcome: 'sent' | 'failed' | 'skipped' | 'not_sent'
  message: string | null
}

/** The fields a book would send: ticked globally, differing, and not unticked for this book. */
export function effectiveDiffs(row: PushRow, globalFields: readonly AbsPushField[], unticked: ReadonlySet<AbsPushField> | undefined): PushRow['diffs'] {
  return row.diffs.filter((d) => globalFields.includes(d.field) && !unticked?.has(d.field))
}

/** The books to send, each with its effective fields; books left with none are dropped. */
export function sendable(
  rows: readonly PushRow[],
  globalFields: readonly AbsPushField[],
  excludedBooks: ReadonlySet<string>,
  untickedPerBook: ReadonlyMap<string, ReadonlySet<AbsPushField>>,
): AbsPushSendInput['books'] {
  const books: AbsPushSendInput['books'] = []
  for (const row of rows) {
    if (excludedBooks.has(row.sourceItemId)) continue
    const diffs = effectiveDiffs(row, globalFields, untickedPerBook.get(row.sourceItemId))
    if (diffs.length > 0) books.push({ sourceItemId: row.sourceItemId, fields: diffs.map((d) => ({ field: d.field, hash: d.hash })) })
  }
  return books
}

/** What to list under the headline: every result that did not go cleanly, including a sent book with a note. */
export function listedResults(results: readonly PushResult[]): PushResult[] {
  return results.filter((r) => r.outcome !== 'sent' || r.message !== null)
}

export function resultLine(results: readonly PushResult[]): string {
  const sent = results.filter((r) => r.outcome === 'sent').length
  return `Sent ${String(sent)} · ${String(results.length - sent)} failed`
}

/** The run the page watches: the one it started, else one it found running; once seen, kept so its result stays. */
export function watchedRun(watched: string | null, listed: { id: string; status: string } | null | undefined): string | null {
  return watched ?? (listed?.status === 'running' ? listed.id : null)
}

/** Still running unless the run is finished or its query failed (else Send would stay disabled for good). */
export function isRunning(runId: string | null, run: { status: string } | undefined, failed: boolean): boolean {
  return runId !== null && !failed && (run === undefined || run.status === 'running')
}
