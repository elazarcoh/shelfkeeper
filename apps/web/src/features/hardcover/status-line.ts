import type { HardcoverAccountStatus } from '@mylib/domain'

export function accountStatusLine(account: { status: HardcoverAccountStatus; statusDetail: string | null; username: string } | null): string {
  if (account === null) return 'Not connected'
  if (account.status === 'ok') return `Connected as @${account.username}`
  if (account.status === 'missing_scope') return `Missing permission: ${account.statusDetail ?? 'unknown'}`
  return `Needs a new token${account.statusDetail ? ` (${account.statusDetail})` : ''}`
}

export function ratingLine(rating: number | null, count: number): string | null {
  if (rating === null) return null
  return `★ ${rating.toFixed(1)} (${count.toLocaleString('en-US')} ${count === 1 ? 'rating' : 'ratings'})`
}

const books = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'book' : 'books'}`

/** The card's sends summary, its list showing only the latest few: "3 waiting · 40 sent"; null with no sends. */
export function pushSummary(counts: { waiting: number; sent: number; skipped: number }): string | null {
  const parts = (['waiting', 'sent', 'skipped'] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k].toLocaleString('en-US')} ${k}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The "Send my past reads" confirm text (#140). */
export function pastReadsLine(total: number, matched: number): string {
  const waiting = total - matched
  return [
    `${books(total)} you finished and haven’t sent yet will be marked Read on Hardcover, with your rating.`,
    waiting > 0 ? `${books(waiting)} not yet matched on Hardcover will wait until ${waiting === 1 ? 'it is' : 'they are'}.` : null,
    'Books already Read there are skipped, nothing there is changed or deleted, and they go out a batch an hour.',
  ]
    .filter((s) => s !== null)
    .join(' ')
}
