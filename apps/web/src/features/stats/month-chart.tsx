import { useState } from 'react'
import { cn } from '@/lib/utils'
import { niceTicks } from './stats-view'

export interface ColumnPart {
  id: string
  name: string
  value: number
  color: string
  hatched?: boolean
}

export interface Column {
  key: string
  short: string
  long: string
  parts: ColumnPart[]
}

const total = (c: Column) => c.parts.reduce((s, p) => s + p.value, 0)

/**
 * Twelve stacked columns on one light value axis. Each column is a button (hover, focus or tap shows its
 * exact values); the peak is labelled directly. Text never wears the data colour.
 */
export function MonthChart({
  columns,
  format,
  unit,
  label,
  integer = false,
}: {
  integer?: boolean
  columns: Column[]
  format: (n: number) => string
  unit: string
  label: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const totals = columns.map(total)
  const max = Math.max(0, ...totals)
  const ticks = niceTicks(max, 3, integer)
  const top = ticks.at(-1) ?? 1
  const peak = max > 0 ? totals.indexOf(max) : -1
  const shown = active === null ? null : columns[active]

  return (
    <div className="relative select-none" role="group" aria-label={label} onPointerLeave={() => setActive(null)}>
      <div className="flex">
        {/* value axis */}
        <div className="relative h-40 w-9 shrink-0 text-xs text-muted-foreground tabular-nums" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute end-2 translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative h-40 flex-1">
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className={cn('absolute inset-x-0 border-t', t === 0 ? 'border-border' : 'border-viz-grid')}
              style={{ bottom: `${(t / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 grid grid-cols-12">
            {columns.map((c, i) => {
              const sum = totals[i] ?? 0
              const visible = c.parts.filter((p) => p.value > 0)
              return (
                <button
                  key={c.key}
                  type="button"
                  className="group relative flex h-full items-end justify-center rounded-sm outline-none focus-visible:bg-muted/60"
                  aria-label={`${c.long}: ${describe(c, format, unit)}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onClick={() => setActive(i)}
                >
                  {i === peak ? (
                    <span
                      aria-hidden
                      className="absolute z-[1] -translate-y-1 text-xs font-medium text-foreground tabular-nums"
                      style={{ bottom: `${(sum / top) * 100}%` }}
                    >
                      {format(sum)}
                    </span>
                  ) : null}
                  <span
                    aria-hidden
                    className={cn(
                      'viz-grow flex w-[58%] max-w-6 flex-col-reverse gap-[2px] transition-[height,opacity] duration-500 ease-out',
                      active !== null && active !== i && 'opacity-55',
                    )}
                    style={{ height: `${(sum / top) * 100}%`, animationDelay: `${i * 35}ms` }}
                  >
                    {visible.map((p, pi) => (
                      <span
                        key={p.id}
                        className={cn('min-h-[2px] w-full', pi === visible.length - 1 && 'rounded-t-[4px]', p.hatched && 'viz-hatch')}
                        style={{
                          flexGrow: p.value,
                          flexBasis: 0,
                          backgroundColor: p.color,
                          ...(p.hatched ? { ['--hatch' as string]: 'var(--viz-ink)' } : {}),
                        }}
                      />
                    ))}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {/* month axis */}
      <div className="ms-9 grid grid-cols-12 pt-1.5 text-center text-xs text-muted-foreground" aria-hidden>
        {columns.map((c, i) => (
          <span key={c.key} className={cn(i === active && 'font-medium text-foreground')}>
            {/* phones: one letter, so twelve labels fit without running together */}
            <span className="sm:hidden">{c.short.slice(0, 1)}</span>
            <span className="hidden sm:inline">{c.short}</span>
          </span>
        ))}
      </div>
      {shown && active !== null ? <Tooltip column={shown} index={active} format={format} unit={unit} /> : null}
    </div>
  )
}

/** "1 book", not "1 books" (the other units, "hours listened" and "words read", are only singular at exactly 1 too). */
function unitFor(shown: string, unit: string): string {
  return shown === '1' ? unit.replace(/^books\b/, 'book').replace(/^hours\b/, 'hour').replace(/^words\b/, 'word') : unit
}

function describe(c: Column, format: (n: number) => string, unit: string): string {
  const sum = total(c)
  if (sum === 0) return `no ${unit}`
  const nonZero = c.parts.filter((p) => p.value > 0)
  const breakdown =
    nonZero.length > 1
      ? ` (${nonZero.map((p) => `${format(p.value)} ${p.name.toLowerCase()}`).join(', ')})`
      : nonZero[0]?.hatched
        ? ' (estimated)'
        : ''
  return `${format(sum)} ${unitFor(format(sum), unit)}${breakdown}`
}

function Tooltip({ column, index, format, unit }: { column: Column; index: number; format: (n: number) => string; unit: string }) {
  const sum = total(column)
  const nonZero = column.parts.filter((p) => p.value > 0)
  // beside the column (never over it): to its right in the first half of the year, to its left after
  const before = index >= 6
  const edge = (before ? index : index + 1) / 12
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border bg-popover px-2.5 py-2 text-xs whitespace-nowrap text-popover-foreground shadow-md"
      style={{
        left: `calc(2.25rem + (100% - 2.25rem) * ${edge} ${before ? '- 0.25rem' : '+ 0.25rem'})`,
        transform: before ? 'translateX(-100%)' : undefined,
      }}
    >
      <p className="text-sm font-semibold tabular-nums">
        {format(sum)} <span className="font-normal text-muted-foreground">{unitFor(format(sum), unit)}</span>
      </p>
      <p className="text-muted-foreground">
        {column.long}
        {nonZero.length === 1 && nonZero[0]?.hatched ? ' · estimated' : ''}
      </p>
      {nonZero.length > 1 ? (
        <ul className="mt-1.5 grid gap-0.5">
          {nonZero.map((p) => (
            <li key={p.id} className="flex items-center gap-1.5">
              <span className={cn('h-0.5 w-3 rounded-full', p.hatched && 'opacity-60')} style={{ backgroundColor: p.hatched ? 'var(--viz-ink)' : p.color }} />
              <span className="tabular-nums font-medium">{format(p.value)}</span>
              <span className="text-muted-foreground">{p.name.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
