import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useState } from 'react'
import { newVolumeLabel, volumeLabel, type CsvResolution, type EditionInput } from '@mylib/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fieldsFromVolume, VolumeFields, volumeFromFields, type VolumeText } from '@/features/shelf/volume-fields'
import { WorkCover } from '@/components/work-cover'
import { todayLocal } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { CandidateList } from './candidate-list'
import { detailsHolding } from './edition-details'
import { EditionDetailsDialog } from './edition-details-dialog'
import { ProposalCover } from './proposal-cover'
import { basisLabel, csvCandidateResolutions, csvCreateLabel, csvReadSummary, presetFirst } from './resolution'
import { CsvLinkPanel, linkableOf, OriginalTitle, ShelfLinkPanel } from './shelf-link-panel'

type Entry = RouterOutputs['inbox']['mine']['items'][number]

/** The imported item's volume, and a way to correct it: the guess from the title can be wrong, and the person has the last word (#66). */
function VolumeLine({ entry }: { entry: Entry }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState<VolumeText>({ volume: '', count: '' })
  const set = useMutation(
    trpc.shelf.setVolume.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
        setEditing(false)
      },
    }),
  )
  const parsed = volumeFromFields(text)
  const label = volumeLabel(entry.item.volume?.number ?? null, entry.item.volume?.count ?? null)
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {label !== null ? <span dir="auto">{label}</span> : null}
        {editing ? null : (
          <Button
            size="xs"
            variant="outline"
            className="pointer-coarse:min-h-11"
            onClick={() => {
              setText(fieldsFromVolume(entry.item.volume))
              setEditing(true)
            }}
          >
            Volume
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <VolumeFields idPrefix={`vol-${entry.id}`} value={text} onChange={setText} />
          <Button size="sm" disabled={parsed === 'invalid' || set.isPending} onClick={() => set.mutate({ proposalId: entry.id, volume: parsed === 'invalid' ? null : parsed })}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** `highlight`: the book a link pointed at (the shelf review's "Already in your Inbox"). */
export function MyProposalCard({ entry, highlight = false }: { entry: Entry; highlight?: boolean }) {
  const queryClient = useQueryClient()
  const resolve = useMutation(
    trpc.inbox.resolveMine.mutationOptions({
      onSuccess: (_r, variables) => {
        for (const key of [trpc.inbox.pathKey(), trpc.library.pathKey(), trpc.catalog.pathKey(), trpc.sessions.pathKey(), trpc.stats.pathKey()]) void queryClient.invalidateQueries({ queryKey: key })
        toast.success(variables.resolution.action === 'ignore' ? 'Ignored' : 'Saved')
      },
      onError: () => void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() }),
    }),
  )
  // the holding history is dated by the person's own day, never the server's (checklist)
  const act = (resolution: CsvResolution) => resolve.mutate({ proposalId: entry.id, resolution, today: todayLocal() })
  const addWith = (workId: string) => (edition: EditionInput) => resolve.mutateAsync({ proposalId: entry.id, resolution: { action: 'link_new_edition', workId, edition }, today: todayLocal() })
  const headingId = `mine-${entry.id}`
  const summary = csvReadSummary(entry)
  const photo = entry.sourceKind === 'shelf' ? entry.photo : null
  const candidates = presetFirst(entry.candidates, photo?.preset ?? null)
  // linking a borrowed book to a copy already in the library leaves that copy's holding untouched
  const holding = detailsHolding(entry.ownership, photo?.borrowedFrom ?? null)
  const borrowedNote = photo !== null && entry.ownership === 'borrowed'

  return (
    <section
      aria-labelledby={headingId}
      aria-current={highlight ? 'true' : undefined}
      className={`grid grid-cols-1 gap-4 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]${highlight ? ' ring-2 ring-primary' : ''}`}
    >
      {/* grid-cols-1 here and below (minmax(0,1fr)): an auto track grows to a long title's or file name's width */}
      <div className="grid min-w-0 grid-cols-1 content-start gap-2">
        <h3 id={headingId} className="text-lg font-semibold break-words text-match-parent" dir="auto">
          {entry.item.title}
        </h3>
        <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
          {entry.item.authors.join(', ')}
        </p>
        <VolumeLine entry={entry} />
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {/* Badge is inline-flex, so the ellipsis needs an inner block to truncate */}
          <Badge variant="outline" className="max-w-full">
            <span className="truncate" dir="auto">
              {entry.fileName}
            </span>
          </Badge>
          {photo !== null && photo.link === null ? <Badge variant="outline">Not linked</Badge> : null}
          {summary !== '' ? <span>{summary}</span> : null}
        </p>
        {photo !== null ? (
          <>
            <OriginalTitle photo={photo} />
            <ShelfLinkPanel entry={entry} linkable={linkableOf(entry)} />
          </>
        ) : (
          <CsvLinkPanel entry={entry} />
        )}
        {/* a book only wanted gets no copy, so no cover of its own */}
        {entry.shelf === 'want' ? null : <ProposalCover entry={entry} />}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => act({ action: 'create_work' })}>
            {csvCreateLabel(entry.shelf)}
          </Button>
          <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => act({ action: 'ignore' })}>
            Ignore
          </Button>
        </div>
      </div>
      {/* stacked (below md): a rule separates the matches from the row's own actions; with no match it is a quiet note, not a heading */}
      <div className="grid min-w-0 grid-cols-1 content-start gap-2 max-md:border-t max-md:pt-4">
        <p className={candidates.length > 0 ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}>
          {candidates.length > 0 ? 'Already in the library?' : 'Not in the library yet'}
        </p>
        <CandidateList count={candidates.length}>
          {candidates.map((c) => {
            const options = csvCandidateResolutions(c, entry.item.format, entry.shelf, entry.photo !== null)
            return (
              <li key={`${c.workId}-${c.editionId ?? ''}`} className="flex gap-3 py-3 first:pt-0 sm:rounded-md sm:border sm:p-3 sm:first:pt-3">
                <WorkCover title={c.card.title} coverAssetId={c.card.coverAssetId} label={false} className="w-10 shrink-0" />
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-medium break-words" dir="auto">
                      {c.card.title}
                    </span>
                    <Badge variant={c.basis === 'title_author' ? 'outline' : 'secondary'}>{basisLabel[c.basis]}</Badge>
                  </p>
                  <p className="truncate text-sm text-muted-foreground" dir="auto">
                    {c.card.authors.join(', ')}
                  </p>
                  {c.volume !== null ? <p className="text-sm text-muted-foreground">{newVolumeLabel(c.volume, null)}</p> : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {options.map((o, i) => (
                      <Button key={o.label} size="sm" variant={i === 0 ? 'default' : 'outline'} disabled={resolve.isPending} onClick={() => act(o.resolution)}>
                        {o.label}
                      </Button>
                    ))}
                    {entry.shelf === 'want' ? null : <EditionDetailsDialog bookTitle={c.card.title} item={entry.item} holding={holding} busy={resolve.isPending} onAdd={addWith(c.workId)} />}
                  </div>
                  {borrowedNote && options.some((o) => o.resolution.action === 'link_edition') ? (
                    <p className="text-xs text-muted-foreground" dir="auto">
                      “It’s my copy” keeps that copy as it is — the borrowing{photo.borrowedFrom ? <> from <bdi>{photo.borrowedFrom}</bdi></> : null} isn’t recorded.
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </CandidateList>
      </div>
    </section>
  )
}
