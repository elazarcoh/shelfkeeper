import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatCompact, formatHours, MONTH_SHORT, weekdayDate, type HeatmapDay } from './stats-view'

const LEVEL_NAMES = ['no reading', 'a little reading', 'some reading', 'a lot of reading', 'the most reading'] as const
const heat = (level: number) => `var(--heat-${level})`

function dayAmount(d: HeatmapDay): string {
  const bits: string[] = []
  if (d.minutes > 0) bits.push(`${formatHours(d.minutes / 60)} h listened`)
  if (d.words > 0) bits.push(`${formatCompact(d.words)} words read`)
  return bits.length > 0 ? bits.join(' · ') : 'No reading'
}

/**
 * A calendar heatmap: one column per week (Sunday first), one cell per day. It fills its card when there is
 * room and scrolls sideways inside the card when there isn't, opening on the newest weeks.
 */
export function ActivityHeatmap({
  days,
  selected,
  onSelect,
}: {
  days: HeatmapDay[]
  selected: string | null
  onSelect: (date: string) => void
}) {
  const [hovered, setHovered] = useState<HeatmapDay | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const first = days[0]
  const leadingBlanks = first ? new Date(`${first.date}T00:00:00Z`).getUTCDay() : 0
  const weekCount = Math.ceil((leadingBlanks + days.length) / 7)
  const position = (i: number) => ({ week: Math.floor((i + leadingBlanks) / 7), weekday: (i + leadingBlanks) % 7 })
  const lastPast = days.findLastIndex((d) => !d.future)
  const anchorWeek = lastPast === -1 ? 0 : position(lastPast).week

  const months = MONTH_SHORT.map((name, m) => {
    const index = days.findIndex((d) => Number(d.date.slice(5, 7)) === m + 1)
    return { name, week: index === -1 ? -1 : position(index).week }
  }).filter((m) => m.week !== -1)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    // newest end visible: put today's week (or the year's end) at the right edge
    const columnWidth = el.scrollWidth / (weekCount + 1.5)
    el.scrollLeft = Math.max(0, (anchorWeek + 2.5) * columnWidth - el.clientWidth)
  }, [anchorWeek, weekCount])

  const readout = hovered ?? days.find((d) => d.date === selected) ?? null

  return (
    <div className="grid gap-3">
      {/* scroll-ps: a cell focused by keyboard scrolls clear of the sticky weekday column */}
      <div ref={scroller} className="scroll-ps-[calc(2rem+3px)] overflow-x-auto py-1 [scrollbar-width:thin]">
        <div
          // under a touch pointer the cells grow to ~24px (an approved exception to the 44px rule); the grid scrolls sideways
          className="grid min-w-[44rem] gap-[3px] pointer-coarse:min-w-[92rem]"
          style={{ gridTemplateColumns: `2rem repeat(${weekCount}, minmax(0, 1fr))` }}
          role="group"
          aria-label="Reading activity by day"
          onPointerLeave={() => setHovered(null)}
        >
          {months.map((m) => (
            <span
              key={m.name}
              aria-hidden
              className="pb-0.5 text-xs leading-none whitespace-nowrap text-muted-foreground"
              style={{ gridRow: 1, gridColumn: `${m.week + 2} / span 3` }}
            >
              {m.name}
            </span>
          ))}
          <span aria-hidden className="sticky start-0 z-[1] bg-card shadow-[0_0_0_3px_var(--color-card)]" style={{ gridRow: 1, gridColumn: 1 }} />
          {/* every weekday row gets an opaque sticky label cell, so scrolled-under weeks never show through */}
          {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((name, i) => (
            <span
              key={i}
              aria-hidden
              className="sticky start-0 z-[1] flex items-center bg-card pe-1 shadow-[0_0_0_3px_var(--color-card)] text-xs leading-none text-muted-foreground"
              style={{ gridRow: i + 2, gridColumn: 1 }}
            >
              {name}
            </span>
          ))}
          {days.map((d, i) => {
            const { week, weekday } = position(i)
            const style = { gridRow: weekday + 2, gridColumn: week + 2 }
            if (d.future) {
              return <span key={d.date} aria-hidden className="aspect-square rounded-[3px] border border-dashed border-border" style={style} />
            }
            return (
              <button
                key={d.date}
                type="button"
                aria-label={`${weekdayDate(d.date)}: ${dayAmount(d)}`}
                aria-pressed={selected === d.date}
                className={cn(
                  // relative + z-[2]: the ring draws over the sticky weekday column's 3px shadow
                  'aspect-square rounded-[3px] outline-none transition-[filter] hover:brightness-90 focus-visible:relative focus-visible:z-[2] focus-visible:ring-2 focus-visible:ring-ring dark:hover:brightness-125',
                  selected === d.date && 'relative z-[2] ring-2 ring-foreground ring-offset-1 ring-offset-card',
                )}
                style={{ ...style, backgroundColor: heat(d.level) }}
                onPointerEnter={() => setHovered(d)}
                onFocus={() => setHovered(d)}
                onBlur={() => setHovered(null)}
                onClick={() => onSelect(d.date)}
              />
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <p aria-live="polite" className="min-h-4">
          {readout ? (
            <>
              <span className="font-medium text-foreground">{weekdayDate(readout.date)}</span> · {dayAmount(readout)}
            </>
          ) : (
            'Hover or tap a day for details.'
          )}
        </p>
        <div className="flex items-center gap-1.5" aria-label="Legend: lighter cells mean less reading, darker more">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} title={LEVEL_NAMES[level]} className="size-2.5 rounded-[3px]" style={{ backgroundColor: heat(level) }} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  )
}
