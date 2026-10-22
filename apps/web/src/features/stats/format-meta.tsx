import { BookOpen, CircleHelp, Headphones, TabletSmartphone } from 'lucide-react'
import { statFormats, type StatFormat } from './stats-view'

/** Format identity on the Stats page: the same colour, icon and name wherever a format appears. */
export const formatMeta: Record<StatFormat, { name: string; color: string; Icon: typeof BookOpen }> = {
  physical: { name: 'Physical', color: 'var(--format-physical)', Icon: BookOpen },
  ebook: { name: 'Ebook', color: 'var(--format-ebook)', Icon: TabletSmartphone },
  audiobook: { name: 'Audiobook', color: 'var(--format-audiobook)', Icon: Headphones },
  unspecified: { name: 'Unspecified', color: 'var(--format-unspecified)', Icon: CircleHelp },
}

/** A small colour key (a rounded square, mirroring the bar marks) — always next to a text label. */
export function Swatch({ color, hatched = false, className }: { color: string; hatched?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-2.5 shrink-0 rounded-[3px] ${hatched ? 'viz-hatch' : ''} ${className ?? ''}`}
      style={{ backgroundColor: color, ...(hatched ? { ['--hatch' as string]: 'var(--viz-ink)' } : {}) }}
    />
  )
}

/** Swatch + icon + name for each format shown, in the fixed format order. */
export function FormatLegend({ formats, counts }: { formats: readonly StatFormat[]; counts?: Record<StatFormat, number> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {statFormats
        .filter((f) => formats.includes(f))
        .map((f) => {
          const { name, color, Icon } = formatMeta[f]
          return (
            <li key={f} className="flex items-center gap-1.5">
              <Swatch color={color} />
              <Icon aria-hidden className="size-3.5" />
              <span>
                {name}
                {counts ? <span className="ms-1 font-medium text-foreground tabular-nums">{counts[f]}</span> : null}
              </span>
            </li>
          )
        })}
    </ul>
  )
}
