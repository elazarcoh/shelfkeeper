import { Link } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Feather, Flag, Repeat2, Ruler, Star, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { WorkCover } from '@/components/work-cover'
import { cn } from '@/lib/utils'
import { FormatLegend, formatMeta } from './format-meta'
import { finishLabel, statFormats, type FinishedBookLike, type Highlights, type StatFormat } from './stats-view'

export function YearSwitcher({ year, prev, next, onChange }: { year: number; prev: number; next: number | null; onChange: (y: number) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-card p-0.5 shadow-xs">
      <Button variant="ghost" size="icon" className="size-8" aria-label={`Previous year, ${prev}`} onClick={() => onChange(prev)}>
        <ChevronLeft />
      </Button>
      <span className="min-w-12 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {year}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={next === null ? 'No later year' : `Next year, ${next}`}
        disabled={next === null}
        onClick={() => next !== null && onChange(next)}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}

/** "▲ 3 vs 2025" — signed change against a named period; arrow + sign + words, so direction is never colour alone. */
export function Delta({ current, previous, format, against }: { current: number; previous: number; format: (n: number) => string; against: string }) {
  const diff = current - previous
  if (Math.abs(diff) < 1e-9) return <span className="text-xs text-muted-foreground">Same as {against}</span>
  const up = diff > 0
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs', up ? 'text-delta-up' : 'text-muted-foreground')}>
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      <span className="font-medium tabular-nums">{format(Math.abs(diff))}</span>
      <span className="text-muted-foreground">vs {against}</span>
    </span>
  )
}

/** A proportional bar of the format split: 2px surface gaps between segments, counts in the legend. */
export function FormatBar({ counts }: { counts: Record<StatFormat, number> }) {
  const present = statFormats.filter((f) => counts[f] > 0)
  const sum = present.reduce((s, f) => s + counts[f], 0)
  if (sum === 0) return null
  const summary = present.map((f) => `${counts[f]} ${formatMeta[f].name.toLowerCase()}`).join(', ')
  return (
    <div className="grid gap-2">
      <div className="viz-grow-x flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`Books by format: ${summary}`}>
        {present.map((f) => (
          <span key={f} style={{ flexGrow: counts[f], flexBasis: 0, backgroundColor: formatMeta[f].color }} />
        ))}
      </div>
      <FormatLegend formats={present} counts={counts} />
    </div>
  )
}

export function Stat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid content-start gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl leading-tight font-semibold sm:text-2xl">{value}</span>
      {children}
    </div>
  )
}

function Tile({ icon: Icon, label, children, className }: { icon: typeof Star; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid content-start gap-1 rounded-xl border bg-card p-3.5 shadow-xs sm:p-4', className)}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        {label}
      </span>
      {children}
    </div>
  )
}

/** dir=auto sits on the clamping element, so a Hebrew title's ellipsis lands on its own end; text-match-parent keeps it start-aligned in the tile. */
function BookLink({ book }: { book: FinishedBookLike }) {
  return (
    <span className="line-clamp-2 text-sm leading-snug font-semibold text-match-parent" dir="auto">
      <Link to="/books/$workId" params={{ workId: book.workId }} className="hover:underline">
        {book.title}
      </Link>
    </span>
  )
}

const Sub = ({ children }: { children: ReactNode }) => <span className="text-xs text-muted-foreground">{children}</span>

/** Personal facts for the year. A tile only appears when there's something true to say. */
export function HighlightTiles({ h }: { h: Highlights }) {
  const tiles: ReactNode[] = []
  if (h.longest)
    tiles.push(
      <Tile key="longest" icon={Ruler} label="Longest book">
        <BookLink book={h.longest.book} />
        <Sub>{h.longest.text}</Sub>
      </Tile>,
    )
  if (h.quickest)
    tiles.push(
      <Tile key="quickest" icon={Zap} label="Quickest finish">
        <BookLink book={h.quickest.book} />
        <Sub>{h.quickest.days === 1 ? 'Started and finished the same day' : `Read in ${h.quickest.days} days`}</Sub>
      </Tile>,
    )
  if (h.topAuthor)
    tiles.push(
      <Tile key="author" icon={Feather} label="Most-read author">
        <span className="line-clamp-2 text-sm leading-snug font-semibold text-match-parent" dir="auto">
          {h.topAuthor.name}
        </span>
        <Sub>{h.topAuthor.count} books</Sub>
      </Tile>,
    )
  if (h.rating)
    tiles.push(
      <Tile key="rating" icon={Star} label="Average rating">
        <div className="flex items-end justify-between gap-2">
          <span className="text-sm font-semibold">
            {h.rating.average.toFixed(1)} <span className="font-normal text-muted-foreground">/ 5</span>
          </span>
          <RatingBins bins={h.rating.bins} />
        </div>
        <Sub>
          {h.rating.count} {h.rating.count === 1 ? 'book' : 'books'} rated
        </Sub>
      </Tile>,
    )
  if (h.first)
    tiles.push(
      <Tile key="first" icon={Flag} label="First finish of the year">
        <BookLink book={h.first} />
        <Sub>{finishLabel(h.first.finishedOn, h.first.finishedPrecision)}</Sub>
      </Tile>,
    )
  if (h.rereads > 0)
    tiles.push(
      <Tile key="rereads" icon={Repeat2} label="Rereads">
        <span className="text-sm font-semibold">
          {h.rereads} {h.rereads === 1 ? 'book' : 'books'}
        </span>
        <Sub>returned to an old favourite</Sub>
      </Tile>,
    )
  if (tiles.length === 0) return null
  return (
    // an odd last tile spans the row on phones; wider screens fit as many columns as there are tiles
    <div className="grid grid-cols-2 gap-3 max-md:[&>*:last-child:nth-child(odd)]:col-span-2 md:[grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]">
      {tiles}
    </div>
  )
}

/** Ratings 1★–5★ as five tiny columns (one neutral series), counts in the label. */
function RatingBins({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins)
  return (
    <div
      className="flex h-7 items-end gap-[3px]"
      role="img"
      aria-label={`Ratings: ${bins.map((n, i) => `${n} at ${i + 1} star${i === 0 ? '' : 's'}`).join(', ')}`}
    >
      {bins.map((n, i) => (
        <span
          key={i}
          className="viz-grow w-2 rounded-t-[2px] bg-viz-ink"
          style={{ height: `${Math.max(n > 0 ? 18 : 6, (n / max) * 100)}%`, opacity: n > 0 ? 1 : 0.2, animationDelay: `${i * 40}ms` }}
        />
      ))}
    </div>
  )
}

/** Covers of the books finished in the year, newest first; scrolls sideways. */
export function Shelf({ books }: { books: FinishedBookLike[] }) {
  const newestFirst = [...books].reverse()
  return (
    <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
      {newestFirst.map((b, i) => {
        const meta = formatMeta[b.format]
        return (
          <li
            key={b.sessionId}
            className="w-[5.5rem] shrink-0 snap-start motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 sm:w-24"
            style={{ animationDelay: `${Math.min(i, 12) * 40}ms`, animationFillMode: 'both' }}
          >
            <Link to="/books/$workId" params={{ workId: b.workId }} className="group grid gap-1.5 outline-none">
              <span className="relative block transition-transform group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-ring rounded-md">
                <WorkCover title={b.title} coverAssetId={b.coverAssetId} className="w-full" />
                {b.isReread ? (
                  <span className="absolute top-1 end-1 rounded bg-background/90 px-1 text-xs font-medium shadow-xs">Reread</span>
                ) : null}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span aria-hidden className="h-1 w-3 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                <meta.Icon aria-label={meta.name} className="size-3 shrink-0" />
                {finishLabel(b.finishedOn, b.finishedPrecision)}
              </span>
              <span className="line-clamp-2 text-xs leading-snug font-medium group-hover:underline" dir="auto">
                {b.title}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

