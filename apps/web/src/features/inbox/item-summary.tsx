import { FormatIcon } from '@/components/format-icon'
import { formatDuration, formatLabel, seriesLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'

type Item = RouterOutputs['inbox']['list']['items'][number]['item']

export function ItemSummary({ item, sourceName }: { item: Item; sourceName: string }) {
  const ids = [
    item.identifiers.isbn13 !== null ? `ISBN ${item.identifiers.isbn13}` : null,
    item.identifiers.isbn10 !== null ? `ISBN ${item.identifiers.isbn10}` : null,
    item.identifiers.asin !== null ? `ASIN ${item.identifiers.asin}` : null,
  ].filter((v) => v !== null)
  const details = [
    item.narrators.length > 0 ? `Read by ${item.narrators.join(', ')}` : null,
    ...item.series.map(seriesLabel),
    item.durationSec !== null ? formatDuration(item.durationSec) : null,
  ].filter((v) => v !== null)
  return (
    // grid-cols-1 (minmax(0,1fr)) and break-words (inherited by every line): a long name wraps instead of widening the card
    <div className="grid grid-cols-1 content-start gap-1 text-sm break-words">
      <p className="flex items-center gap-2 text-muted-foreground">
        <FormatIcon format={item.format} /> {formatLabel[item.format]} · from{' '}
        <span className="min-w-0" dir="auto">
          {sourceName}
        </span>
      </p>
      {item.subtitle !== null ? (
        <p className="text-muted-foreground" dir="auto">
          {item.subtitle}
        </p>
      ) : null}
      <p dir="auto">{item.authors.length > 0 ? `by ${item.authors.join(', ')}` : 'No author listed'}</p>
      {/* narrator, series and length share one line, so a phone card stays short (#13) */}
      {/* each part is its own dir="auto" span: a bidi-isolated Hebrew name cannot reorder the duration's digits around it */}
      {details.length > 0 ? (
        <p>
          {details.map((d, i) => (
            <span key={i}>
              {i > 0 ? ' · ' : null}
              <span dir="auto">{d}</span>
            </span>
          ))}
        </p>
      ) : null}
      {/* identifiers matter to the matcher, not to a decision on a phone */}
      {ids.length > 0 ? <p className="text-xs text-muted-foreground max-sm:hidden">{ids.join(' · ')}</p> : null}
    </div>
  )
}
