import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { formatSeriesPosition, type WorkKind } from '@mylib/domain'
import { KindBadge } from '@/components/kind-badge'
import { Badge } from '@/components/ui/badge'
import { WorkCover } from '@/components/work-cover'
import { formatNumber } from '@/lib/format'

/** What a row shows, whether it came from the library, from Hardcover or from the AI's pasted answer. */
export interface PickRowData {
  title: string
  authors: string[]
  /** "Cradle #9" */
  series: string | null
  /** the person's first unread book of the series, when it comes before this one */
  firstUnread: { title: string; position: number } | null
  pages: number | null
  audioSec: number | null
  reason: string
  coverAssetId: string | null
  imageUrl: string | null
  /** a library book: the title links to its page */
  workId: string | null
  /** owned formats of a library pick, "Physical · Audiobook" */
  owned: string | null
  /** the audiobook badge text, for picks from outside the library */
  audiobook: string | null
  kind: WorkKind
  note: string | null
}

export function lengthText(pages: number | null, audioSec: number | null): string | null {
  if (audioSec !== null) return `${String(Math.round(audioSec / 3600))} h`
  return pages === null ? null : `${formatNumber(pages)} pages`
}

/** A compact row: cover thumbnail, two text lines, then the actions (one button and a ⋯) on the right. */
export function PickRow({ data, children }: { data: PickRowData; children?: ReactNode }) {
  const length = lengthText(data.pages, data.audioSec)
  const facts = [data.authors.join(', '), data.series, length].filter((x): x is string => x !== null && x !== '')
  const title = (
    <span className="line-clamp-2 font-medium break-words" dir="auto">
      {data.title}
    </span>
  )
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 p-3">
      <div className="w-10 shrink-0 sm:w-12">
        {data.imageUrl !== null && data.coverAssetId === null ? (
          <img src={data.imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="aspect-[2/3] w-full rounded-md object-cover shadow-sm" />
        ) : (
          <WorkCover title={data.title} coverAssetId={data.coverAssetId} label={false} className="w-full" />
        )}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        {data.workId !== null ? (
          <Link to="/books/$workId" params={{ workId: data.workId }} className="hover:underline">
            {title}
          </Link>
        ) : (
          title
        )}
        <p className="break-words text-muted-foreground" dir="auto">
          {facts.join(' · ')}
        </p>
        {data.firstUnread !== null ? (
          <p className="truncate text-xs text-muted-foreground">
            First unread:{' '}
            <span dir="auto">{data.firstUnread.title}</span> (#{formatSeriesPosition(data.firstUnread.position, null)})
          </p>
        ) : null}
        <p className="break-words text-muted-foreground" dir="auto">
          {data.reason}
        </p>
        {data.note !== null ? (
          <p className="break-words text-muted-foreground" dir="auto">
            {data.note}
          </p>
        ) : null}
        {data.owned !== null || data.audiobook !== null || data.kind !== 'book' ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {data.owned !== null ? <Badge variant="secondary">{data.owned}</Badge> : null}
            {data.audiobook !== null ? <Badge variant="outline">{data.audiobook}</Badge> : null}
            <KindBadge kind={data.kind} />
          </div>
        ) : null}
      </div>
      {children !== undefined ? <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">{children}</div> : null}
    </li>
  )
}
