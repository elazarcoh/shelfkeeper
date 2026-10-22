import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactNode } from 'react'
import { PageBody, PageHeader } from '@/components/page'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GoalProgressBar } from '@/features/goals/goal-progress-bar'
import { ActivityHeatmap } from '@/features/stats/activity-heatmap'
import { FormatLegend, formatMeta, Swatch } from '@/features/stats/format-meta'
import { MonthChart, type Column } from '@/features/stats/month-chart'
import { ReadingTimeline } from '@/features/stats/reading-timeline'
import { Delta, FormatBar, HighlightTiles, Shelf, Stat, YearSwitcher } from '@/features/stats/stats-cards'
import {
  biggestMonth,
  booksByMonth,
  bucketByMonth,
  buildHeatmap,
  comparisonRange,
  computeHighlights,
  formatCompact,
  formatHours,
  MONTH_LONG,
  MONTH_SHORT,
  shortDate,
  statFormats,
  weekdayDate,
  yearNav,
} from '@/features/stats/stats-view'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/stats/')({ component: StatsPage })

type Metric = 'books' | 'hours' | 'words'

const metricInfo: Record<Metric, { unit: string; format: (n: number) => string; title: string }> = {
  books: { unit: 'books', format: (n) => String(Math.round(n * 10) / 10), title: 'Books finished' },
  hours: { unit: 'hours listened', format: formatHours, title: 'Hours listened' },
  words: { unit: 'words read', format: formatCompact, title: 'Words read' },
}

/** A card that fades up into place (skipped under prefers-reduced-motion). */
function Section({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <Card
      className={cn('min-w-0 gap-4 py-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500', className)}
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both' }}
    >
      {children}
    </Card>
  )
}

function StatsPage() {
  const today = todayLocal()
  const currentYear = Number(today.slice(0, 4))
  const [year, setYear] = useState(currentYear)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [metricChoice, setMetricChoice] = useState<Metric | null>(null)
  const range = { from: `${year}-01-01`, to: `${year}-12-31` }
  const compare = comparisonRange(year, today)
  const nav = yearNav(year, currentYear)

  const keep = { placeholderData: keepPreviousData }
  const summary = useQuery({ ...trpc.stats.summary.queryOptions(range), ...keep })
  const previous = useQuery({ ...trpc.stats.summary.queryOptions({ from: compare.from, to: compare.to }), ...keep })
  const daily = useQuery({ ...trpc.stats.daily.queryOptions(range), ...keep })
  const books = useQuery({ ...trpc.stats.books.queryOptions(range), ...keep })
  const goals = useQuery(trpc.goals.mine.queryOptions())
  const onDate = useQuery({ ...trpc.stats.onDate.queryOptions({ date: selectedDate ?? '' }), enabled: selectedDate !== null })

  const finished = useMemo(() => books.data ?? [], [books.data])
  const months = useMemo(() => (daily.data ? bucketByMonth(daily.data, year) : []), [daily.data, year])
  const monthBooks = useMemo(() => booksByMonth(finished, year), [finished, year])
  const heatmapDays = useMemo(() => (daily.data ? buildHeatmap(daily.data, year, today) : []), [daily.data, year, today])
  const highlights = useMemo(() => computeHighlights(finished), [finished])
  const peakMonth = months.length > 0 ? biggestMonth(months, monthBooks) : null

  const s = summary.data
  const p = previous.data
  const hours = (s?.totalMinutes ?? 0) / 60
  const hasReading = s !== undefined && (s.booksFinished > 0 || s.totalMinutes > 0 || s.totalWords > 0)
  const stale = summary.isPlaceholderData || daily.isPlaceholderData || books.isPlaceholderData
  const against = compare.partial ? `this time in ${year - 1}` : String(year - 1)
  const hasPrevious = p !== undefined && (p.booksFinished > 0 || p.totalMinutes > 0 || p.totalWords > 0)

  const autoMetric: Metric = (s?.booksFinished ?? 0) > 0 ? 'books' : (s?.totalMinutes ?? 0) > 0 ? 'hours' : 'words'
  const metric = metricChoice ?? autoMetric
  const columns: Column[] = months.map((m, i) => {
    const base = { key: m.month, short: MONTH_SHORT[i] ?? '', long: `${MONTH_LONG[i]} ${year}` }
    if (metric === 'books') {
      const counts = monthBooks[i] ?? { physical: 0, ebook: 0, audiobook: 0, unspecified: 0 }
      return { ...base, parts: statFormats.map((f) => ({ id: f, name: formatMeta[f].name, value: counts[f], color: formatMeta[f].color })) }
    }
    const [value, estimated] = metric === 'hours' ? [m.hours, m.estimatedHours] : [m.words, m.estimatedWords]
    return {
      ...base,
      parts: [
        { id: 'exact', name: 'Exact', value: value - estimated, color: 'var(--viz-ink)' },
        { id: 'estimated', name: 'Estimated', value: estimated, color: 'var(--viz-soft)', hatched: true },
      ],
    }
  })
  const showsEstimated = metric !== 'books' && columns.some((c) => (c.parts[1]?.value ?? 0) > 0)
  const formatsShown = statFormats.filter((f) => monthBooks.some((m) => m[f] > 0))

  const peak = peakMonth === null ? null : { name: MONTH_LONG[peakMonth], books: monthBooks[peakMonth], m: months[peakMonth] }
  const peakBooks = peak?.books ? statFormats.reduce((sum, f) => sum + (peak.books?.[f] ?? 0), 0) : 0
  const peakFacts = peak
    ? [
        peakBooks > 0 ? `${peakBooks} ${peakBooks === 1 ? 'book' : 'books'}` : null,
        (peak.m?.hours ?? 0) >= 0.05 ? `${formatHours(peak.m?.hours ?? 0)} h listened` : null,
        (peak.m?.words ?? 0) > 0 ? `${formatCompact(peak.m?.words ?? 0)} words` : null,
      ].filter(Boolean)
    : []

  const yearGoals = (goals.data ?? []).filter((g) => g.periodStart <= range.to && g.periodEnd >= range.from)

  return (
    <PageBody>
      <PageHeader
        title="Stats"
        description={year === currentYear ? `Your ${year} in reading, so far.` : `Your ${year} in reading.`}
        actions={<YearSwitcher year={year} prev={nav.prev} next={nav.next} onChange={(y) => (setYear(y), setSelectedDate(null))} />}
      />

      <div className={cn('grid min-w-0 gap-4 transition-opacity md:gap-5', stale && 'opacity-60')}>
        {/* Goals sits beside the headline only from 2xl, in a fixed 400px column */}
        <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-5 2xl:grid-cols-[minmax(0,1fr)_25rem]">
          {/* the headline: books finished, with hours, words and the format split */}
          <Section>
            <CardContent className="grid gap-5">
              {s ? (
                <>
                  <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                    <div className="grid gap-0.5">
                      <span className="text-xs text-muted-foreground">Books finished</span>
                      <span className="flex items-baseline gap-2">
                        <span className="text-5xl leading-none font-semibold tracking-tight">{s.booksFinished}</span>
                        <span className="text-sm text-muted-foreground">{s.booksFinished === 1 ? 'book' : 'books'}</span>
                      </span>
                      {hasPrevious ? <Delta current={s.booksFinished} previous={p.booksFinished} format={String} against={against} /> : null}
                    </div>
                    <div className="grid basis-full grid-cols-2 gap-4 sm:max-w-sm sm:flex-1 sm:basis-auto">
                      <Stat label="Hours listened" value={formatHours(hours)}>
                        {hasPrevious ? <Delta current={hours} previous={p.totalMinutes / 60} format={formatHours} against={against} /> : null}
                      </Stat>
                      <Stat label="Words read" value={formatCompact(s.totalWords)}>
                        {hasPrevious ? <Delta current={s.totalWords} previous={p.totalWords} format={formatCompact} against={against} /> : null}
                      </Stat>
                    </div>
                  </div>
                  {s.booksFinished > 0 ? <FormatBar counts={s.byFormat} /> : null}
                  {!hasReading ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing logged for {year}. Finish a book (or tell check-in when you did) and it shows up here.
                    </p>
                  ) : null}
                  {hasPrevious && compare.partial ? (
                    <p className="text-xs text-muted-foreground">
                      Changes compare with {shortDate(compare.from)} – {shortDate(compare.to, true)}.
                    </p>
                  ) : null}
                </>
              ) : (
                <Skeleton className="h-32" />
              )}
            </CardContent>
          </Section>

          <Section delay={60}>
            <CardHeader>
              <CardTitle>Goals</CardTitle>
            </CardHeader>
            <CardContent>
              {yearGoals.length > 0 ? (
                <ul className="grid gap-4">
                  {yearGoals.map((g) => (
                    <li key={g.id}>
                      <GoalProgressBar goal={g} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No goals for {year}.{' '}
                  <Link to="/account" className="font-medium text-foreground underline-offset-4 hover:underline">
                    Add one in Account
                  </Link>
                  .
                </p>
              )}
            </CardContent>
          </Section>
        </div>

        <HighlightTiles h={highlights} />

        {finished.length > 0 ? (
          <Section delay={120}>
            <CardHeader>
              <CardTitle>Finished in {year}</CardTitle>
              <CardDescription>Newest first.</CardDescription>
            </CardHeader>
            <CardContent>
              <Shelf books={finished} />
            </CardContent>
          </Section>
        ) : null}

        {hasReading ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 md:gap-5 xl:grid-cols-2">
            <Section delay={160}>
              <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1.5">
                  <CardTitle>By month</CardTitle>
                  <CardDescription>
                    {peak && peakFacts.length > 0 ? (
                      <>
                        <span className="font-medium text-foreground">{peak.name}</span> was your biggest month: {peakFacts.join(', ')}.
                      </>
                    ) : (
                      'Month by month.'
                    )}
                  </CardDescription>
                </div>
                <Tabs value={metric} onValueChange={(v) => setMetricChoice(v as Metric)}>
                  <TabsList aria-label="Measure">
                    <TabsTrigger value="books">Books</TabsTrigger>
                    <TabsTrigger value="hours">Hours</TabsTrigger>
                    <TabsTrigger value="words">Words</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent className="grid min-w-0 gap-3">
                <MonthChart
                  columns={columns}
                  format={metricInfo[metric].format}
                  unit={metricInfo[metric].unit}
                  label={`${metricInfo[metric].title} by month, ${year}`}
                  integer={metric === 'books'}
                />
                {metric === 'books' && formatsShown.length > 0 ? <FormatLegend formats={formatsShown} /> : null}
                {showsEstimated ? (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <li className="flex items-center gap-1.5">
                      <Swatch color="var(--viz-ink)" /> Exact
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Swatch color="var(--viz-soft)" hatched /> Estimated — imprecise dates or page-count word estimates
                    </li>
                  </ul>
                ) : null}
              </CardContent>
            </Section>

            <Section delay={200}>
              <CardHeader>
                <CardTitle>Reading timeline</CardTitle>
                <CardDescription>When each finished book was on the go.</CardDescription>
              </CardHeader>
              <CardContent>
                {finished.length > 0 ? (
                  <ReadingTimeline books={finished} year={year} today={today} />
                ) : (
                  <p className="text-sm text-muted-foreground">No books finished in {year} yet.</p>
                )}
              </CardContent>
            </Section>
          </div>
        ) : null}

        <Section delay={240}>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Reading and listening, day by day. Amounts are spread evenly across each book&rsquo;s dates.</CardDescription>
          </CardHeader>
          <CardContent className="grid min-w-0 gap-4">
            <ActivityHeatmap days={heatmapDays} selected={selectedDate} onSelect={setSelectedDate} />
            {selectedDate && onDate.data ? (
              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <p className="mb-1 font-medium">{weekdayDate(selectedDate)}</p>
                {onDate.data.length === 0 ? (
                  <p className="text-muted-foreground">No sessions that day.</p>
                ) : (
                  <ul className="grid gap-1">
                    {onDate.data.map((x) => (
                      <li key={`${x.workId}-${x.mode}`} className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground">{x.mode === 'listen' ? 'Listened' : 'Read'}</span>
                        <Link to="/books/$workId" params={{ workId: x.workId }} className="truncate font-medium hover:underline" dir="auto">
                          {x.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </CardContent>
        </Section>
      </div>
    </PageBody>
  )
}
