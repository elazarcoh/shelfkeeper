import type { EditionFormat, EditionInput, ExternalItem, InboxResolution } from '@mylib/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { WorkCover } from '@/components/work-cover'
import { availabilityLabel, formatLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'
import { EditionDetailsDialog } from './edition-details-dialog'
import { basisLabel, sameCopyResolution } from './resolution'

type Candidate = RouterOutputs['inbox']['list']['items'][number]['candidates'][number]

export function CandidateCard({
  candidate,
  item,
  itemFormat,
  busy,
  mode,
  onResolve,
  onAddWith,
}: {
  candidate: Candidate
  item: ExternalItem
  itemFormat: EditionFormat
  busy: boolean
  mode: 'copy' | 'wanted'
  onResolve: (resolution: InboxResolution) => void
  onAddWith: (workId: string) => (edition: EditionInput) => Promise<unknown>
}) {
  const sameCopy = sameCopyResolution(candidate, itemFormat)
  return (
    <li className="flex gap-3 py-3 first:pt-0 sm:rounded-md sm:border sm:p-3 sm:first:pt-3">
      <WorkCover title={candidate.card.title} coverAssetId={candidate.card.coverAssetId} label={false} className="w-10 shrink-0" />
      {/* grid-cols-1 (minmax(0,1fr)) and a shrinkable title: an auto track grows to a long title's one-line width */}
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium break-words" dir="auto">
            {candidate.card.title}
          </span>
          <Badge variant={candidate.basis === 'title_author' ? 'outline' : 'secondary'}>{basisLabel[candidate.basis]}</Badge>
          <span className="text-xs text-muted-foreground">{Math.round(candidate.score * 100)}%</span>
        </p>
        <p className="truncate text-sm text-muted-foreground" dir="auto">
          {candidate.card.authors.join(', ')}
          {candidate.card.formats.length > 0 ? ` · has ${candidate.card.formats.map((f) => formatLabel[f]).join(', ')}` : ''}
          {candidate.card.availability === 'wanted' ? ` · ${availabilityLabel.wanted}` : ''}
        </p>
        {/* one line of reasons rather than one line each (#13) */}
        {candidate.reasons.length > 0 ? <p className="text-xs text-muted-foreground">{candidate.reasons.join(' · ')}</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {mode === 'wanted' ? (
            <Button size="sm" disabled={busy} onClick={() => onResolve({ action: 'attach_wanted', workId: candidate.workId })}>
              It’s this book
            </Button>
          ) : (
            <>
              {sameCopy !== null ? (
                <Button size="sm" disabled={busy} onClick={() => onResolve(sameCopy)}>
                  {candidate.basis === 'restore' ? 'Restore this copy' : 'It’s this copy'}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve({ action: 'link_new_edition', workId: candidate.workId })}>
                Add as new edition
              </Button>
              <EditionDetailsDialog bookTitle={candidate.card.title} item={item} holding={null} busy={busy} onAdd={onAddWith(candidate.workId)} />
            </>
          )}
        </div>
      </div>
    </li>
  )
}
