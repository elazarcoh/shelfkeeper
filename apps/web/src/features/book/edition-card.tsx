import { Fragment } from 'react'
import { availableHoldingActions, volumeLabel } from '@mylib/domain'
import { FormatIcon } from '@/components/format-icon'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDuration, formatLabel, holdingEventLabel, holdingStateLabel, languageName, sourceKindLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'
import { CopyMoreMenu } from './copy-more-menu'
import { EditEditionDialog } from './edition-dialogs'
import type { EditionDetail } from './edition-form-state'
import { HoldingActionDialog } from './holding-dialog'
import { LoanCard } from './loan-card'

function details(e: EditionDetail): [string, string][] {
  const rows: [string, string | null][] = [
    ['ISBN-13', e.isbn13],
    ['ISBN-10', e.isbn10],
    ['ASIN', e.asin],
    ['Publisher', e.publisher],
    ['Published', e.publishedOn],
    ['Pages', e.pageCount === null ? null : e.pageCount.toLocaleString()],
    ['Words', e.wordCount === null ? null : e.wordCount.toLocaleString()],
    ['Length', e.durationSec === null ? null : formatDuration(e.durationSec)],
    ['Narrated by', e.narrators.length > 0 ? e.narrators.map((n) => n.name).join(', ') : null],
    ['Translated by', e.translators.length > 0 ? e.translators.map((n) => n.name).join(', ') : null],
    ['Language', e.language === null ? null : languageName(e.language)],
    ['Shelf', e.shelfLocation],
  ]
  return rows.flatMap(([k, v]) => (v === null ? [] : [[k, v] as [string, string]]))
}

interface EditionCardProps {
  /** the book the copy belongs to (its Fetch metadata compares against it) */
  work: RouterOutputs['catalog']['get']
  edition: EditionDetail
  /** the book has other editions, so this one can be split off */
  canSplit: boolean
  /** admin "entered by mistake" delete (never for lost copies — use the holding actions) */
  canDelete: boolean
}

export function EditionCard({ work, edition, canSplit, canDelete }: EditionCardProps) {
  const stateLabel = holdingStateLabel(edition)

  return (
    <Card className={edition.inPossession ? undefined : 'opacity-80'}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <FormatIcon format={edition.format} />
        <CardTitle className="text-base">{formatLabel[edition.format]}</CardTitle>
        {volumeLabel(edition.volume, edition.volumeCount) !== null ? (
          <Badge variant="secondary">{volumeLabel(edition.volume, edition.volumeCount)}</Badge>
        ) : null}
        {stateLabel !== null ? <Badge variant={edition.inPossession ? 'secondary' : 'outline'}>{stateLabel}</Badge> : null}
        {/* a long source name (an ABS library, a URL-like name) truncates (full name in the tooltip) instead of widening the card */}
        {edition.sources.map((source, i) => (
          <Badge key={`${i}:${source.kind}:${source.name}`} variant="outline" className="max-w-full" title={`${sourceKindLabel[source.kind]} · ${source.name}`}>
            <span className="min-w-0 truncate" dir="auto">
              {sourceKindLabel[source.kind]} · {source.name}
            </span>
          </Badge>
        ))}
      </CardHeader>
      {/* minmax(0,1fr) tracks (grid-cols-1, the dl's value column): an auto or 1fr track grows to a long name */}
      <CardContent className="grid grid-cols-1 gap-3 text-sm">
        {/* what this copy is called, when that differs from the book's title above (its own title, or the title in its language) */}
        {edition.displayTitle !== work.title ? (
          <p className="font-medium break-words text-match-parent" dir="auto">
            {edition.displayTitle}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {details(edition).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words" dir="auto">
                {v}
              </dd>
            </Fragment>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          {availableHoldingActions(edition).map((action) => (
            <HoldingActionDialog key={action} editionId={edition.id} action={action} />
          ))}
          <EditEditionDialog edition={edition} />
          <CopyMoreMenu work={work} edition={edition} canSplit={canSplit} canDelete={canDelete} />
        </div>
        {edition.format === 'physical' && edition.ownership === 'owned' && edition.inPossession ? <LoanCard editionId={edition.id} /> : null}
        {edition.history.length > 0 ? (
          // the list is display:none while closed: Chromium otherwise lays out the hidden list below the card,
          // which overflows it and can push the page's last content under the bottom bar
          <details className="group/history text-xs text-muted-foreground">
            {/* coarse pointers: a 44px row (16px text + 2 × 14px), pulled up so the card's spacing stays the same */}
            <summary className="cursor-pointer select-none pointer-coarse:-my-3.5 pointer-coarse:py-3.5">History</summary>
            <ol className="mt-2 hidden grid-cols-1 gap-1 group-open/history:grid">
              {edition.history.map((h) => (
                <li key={h.id} className="break-words" dir="auto">
                  <span className="tabular-nums">{h.occurredOn}</span> · {holdingEventLabel[h.type]}
                  {h.note !== null ? ` — ${h.note}` : ''}
                  {h.origin === 'sync' ? ' (source sync)' : h.actorName !== null ? ` (${h.actorName})` : ''}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </CardContent>
    </Card>
  )
}
