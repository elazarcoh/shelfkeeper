import { Link } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { FormatLegend, formatMeta } from './format-meta'
import {
  dayOfYear,
  daysInYear,
  MONTH_SHORT,
  packTimeline,
  readDatesLabel,
  timelineRows,
  timelineSpans,
  type FinishedBookLike,
  type TimelineBar,
} from './stats-view'

const LANE_HEIGHT = 24
const LABEL_MAX_CHARS = 26
const CHAR_PX = 6.6 // ~12px Geist
const labelText = (title: string) => (title.length > LABEL_MAX_CHARS ? `${title.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : title)

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function describe(bar: Pick<TimelineBar, 'book' | 'continued' | 'estimated'>): string {
  const b = bar.book
  const range = readDatesLabel(b, bar.continued)
  return `${b.title} · ${formatMeta[b.format].name} · ${range}${bar.estimated ? ' (approximate dates)' : ''}${b.isReread ? ' · reread' : ''}`
}

/** Phones: one row per book (title, dates, and its span across the year), latest finish first. */
function TimelineRows({ books, year }: { books: FinishedBookLike[]; year: number }) {
  const rows = useMemo(() => timelineRows(books, year), [books, year])
  return (
    // grid-cols-1 (minmax(0,1fr)), not the implicit auto column: an auto track grows to a title's full
    // one-line width, so a long title would push every row past the card instead of truncating
    <div className="grid grid-cols-1 gap-3">
      <ul className="grid grid-cols-1 gap-1" aria-label={`Books finished in ${year}, by reading dates`}>
        {rows.map((row) => {
          const meta = formatMeta[row.book.format]
          return (
            <li key={row.book.sessionId} className="min-w-0">
              <Link
                to="/books/$workId"
                params={{ workId: row.book.workId }}
                aria-label={describe(row)}
                className="grid min-h-11 grid-cols-1 content-center gap-1.5 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium" dir="auto">
                    {row.book.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {readDatesLabel(row.book, row.continued)}
                  </span>
                </span>
                <span aria-hidden className="relative h-2 rounded-full bg-viz-grid">
                  <span
                    className={cn('absolute inset-y-0 rounded-full', row.estimated && 'viz-hatch')}
                    style={{
                      left: `${row.start * 100}%`,
                      width: `max(6px, ${(row.end - row.start) * 100}%)`,
                      backgroundColor: row.estimated ? `color-mix(in oklab, ${meta.color} 40%, transparent)` : meta.color,
                      ['--hatch' as string]: meta.color,
                    }}
                  />
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <FormatLegend formats={[...new Set(books.map((b) => b.format))]} />
    </div>
  )
}

/** Each book finished this year as a bar across the days it was being read, coloured by format, overlapping reads stacked. */
export function ReadingTimeline({ books, year, today }: { books: FinishedBookLike[]; year: number; today: string }) {
  return (
    <>
      <div className="sm:hidden">
        <TimelineRows books={books} year={year} />
      </div>
      <div className="hidden sm:block">
        <TimelineChart books={books} year={year} today={today} />
      </div>
    </>
  )
}

function TimelineChart({ books, year, today }: { books: FinishedBookLike[]; year: number; today: string }) {
  const [plot, width] = useWidth<HTMLDivElement>()
  const scroller = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<TimelineBar | null>(null)
  const total = daysInYear(year)

  const { bars, lanes } = useMemo(() => {
    const spans = timelineSpans(books, year)
    if (width === 0) return { bars: [], lanes: 0 }
    return packTimeline(spans, (s) => (labelText(s.book.title).length * CHAR_PX + 4) / width, 6 / width)
  }, [books, year, width])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth // newest end visible
  }, [width])

  const todayFrac = today.startsWith(`${year}-`) ? (dayOfYear(today) + 0.5) / total : null
  const anyEstimated = bars.some((b) => b.estimated)

  return (
    // grid-cols-1 (minmax(0,1fr)): an auto track grows to a long hovered title in the caption below
    <div className="grid grid-cols-1 gap-3">
      <div ref={scroller} className="overflow-x-auto py-1 [scrollbar-width:thin]">
        <div ref={plot} className="relative min-w-[30rem]" onPointerLeave={() => setHovered(null)}>
          {/* month labels + gridlines */}
          <div className="relative h-5" aria-hidden>
            {MONTH_SHORT.map((m, i) => (
              <span
                key={m}
                className="absolute top-0 ps-1 text-xs text-muted-foreground"
                style={{ left: `${(dayOfYear(`${year}-${String(i + 1).padStart(2, '0')}-01`) / total) * 100}%` }}
              >
                {m}
              </span>
            ))}
          </div>
          <div className="relative" style={{ height: Math.max(1, lanes) * LANE_HEIGHT + 4 }}>
            {MONTH_SHORT.map((m, i) => (
              <span
                key={m}
                aria-hidden
                className={cn('absolute inset-y-0 border-s', i === 0 ? 'border-border' : 'border-viz-grid')}
                style={{ left: `${(dayOfYear(`${year}-${String(i + 1).padStart(2, '0')}-01`) / total) * 100}%` }}
              />
            ))}
            {todayFrac !== null ? (
              <span aria-hidden className="absolute inset-y-0 border-s border-foreground/40" style={{ left: `${todayFrac * 100}%` }} />
            ) : null}
            <ul aria-label={`Books finished in ${year}, by reading dates`}>
              {bars.map((bar, i) => {
                const meta = formatMeta[bar.book.format]
                const top = bar.lane * LANE_HEIGHT + 4
                return (
                  <li key={bar.book.sessionId}>
                    <Link
                      to="/books/$workId"
                      params={{ workId: bar.book.workId }}
                      aria-label={describe(bar)}
                      className="group absolute flex items-center outline-none"
                      style={{ top, height: LANE_HEIGHT - 4, left: `${bar.start * 100}%`, width: `${(bar.end - bar.start) * 100}%`, minWidth: 6 }}
                      onPointerEnter={() => setHovered(bar)}
                      onFocus={() => setHovered(bar)}
                      onBlur={() => setHovered(null)}
                    >
                      <span
                        className={cn(
                          'viz-grow-x h-2.5 w-full rounded-[4px] transition-[filter,box-shadow] group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-ring',
                          bar.continued && 'rounded-s-none',
                          bar.estimated && 'viz-hatch',
                          hovered && hovered !== bar && 'opacity-50',
                        )}
                        style={{
                          backgroundColor: bar.estimated ? `color-mix(in oklab, ${meta.color} 40%, transparent)` : meta.color,
                          ['--hatch' as string]: meta.color,
                          animationDelay: `${Math.min(i, 20) * 25}ms`,
                        }}
                      />
                    </Link>
                    <span
                      aria-hidden
                      dir="auto"
                      className={cn(
                        'pointer-events-none absolute text-xs leading-none whitespace-nowrap text-muted-foreground',
                        hovered === bar && 'text-foreground',
                      )}
                      style={{
                        top: top + (LANE_HEIGHT - 4) / 2,
                        transform: 'translateY(-50%)',
                        ...(bar.labelSide === 'end'
                          ? { left: `calc(${bar.end * 100}% + 6px)` }
                          : { right: `calc(${(1 - bar.start) * 100}% + 6px)` }),
                      }}
                    >
                      {labelText(bar.book.title)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <p aria-live="polite" className="min-h-4 min-w-0 break-words" dir="auto">
          {hovered ? describe(hovered) : 'Each bar spans the days a book was being read. Tap one to open it.'}
        </p>
        <FormatLegend formats={[...new Set(books.map((b) => b.format))]} />
        {anyEstimated ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="viz-hatch inline-block h-2.5 w-4 rounded-[3px]"
              style={{ backgroundColor: 'color-mix(in oklab, var(--viz-ink) 25%, transparent)', ['--hatch' as string]: 'var(--viz-ink)' }}
            />
            Striped: approximate dates
          </span>
        ) : null}
      </div>
    </div>
  )
}
