import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { isAllowedCoverUrl, sourceLabel, type ExternalItem, type PhotoLink } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { BookLinker, type HardcoverPick } from '@/features/shelf/book-linker'
import { trpc, trpcClient, type RouterOutputs } from '@/lib/trpc'

type Entry = RouterOutputs['inbox']['mine']['items'][number]
type Photo = NonNullable<Entry['photo']>

/** The line of the review's own reading, shown above the link controls. */
export function OriginalTitle({ photo }: { photo: Photo }) {
  if (photo.ai.originalTitle === null) return null
  return (
    <p className="text-xs text-muted-foreground">
      Original:{' '}
      <span dir="auto" className="break-words">
        {photo.ai.originalTitle}
      </span>
    </p>
  )
}

/** What a pending import knows about its book page: a shelf book's (with the AI's reading), or a CSV row's. */
export interface Linkable {
  link: PhotoLink | null
  /** the book as the import read it, before any page was linked */
  original: ExternalItem
  ai: Photo['ai'] | null
}

export function linkableOf(entry: Entry): Linkable {
  if (entry.sourceKind === 'shelf' && entry.photo !== null) return { link: entry.photo.link, original: entry.photo.original, ai: entry.photo.ai }
  return { link: entry.linked?.link ?? null, original: entry.linked?.original ?? entry.item, ai: null }
}

/** A CSV row's lookup starts folded: a file can hold hundreds of books, and most need no page. */
export function CsvLinkPanel({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)
  const linkable = linkableOf(entry)
  if (linkable.link === null && !open)
    return (
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Look it up
        </Button>
      </div>
    )
  return <ShelfLinkPanel entry={entry} linkable={linkable} />
}

/** Links an imported book to its page on Simania or Open Library, or shows the link and undoes it. */
export function ShelfLinkPanel({ entry, linkable }: { entry: Entry; linkable: Linkable }) {
  const { link, original, ai } = linkable
  const queryClient = useQueryClient()
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
  const unlink = useMutation(trpc.shelf.unlinkPage.mutationOptions({ onSettled: invalidate }))
  const available = useQuery(trpc.hardcover.available.queryOptions())
  const hardcoverAvailable = available.data?.enabled === true

  if (link !== null) {
    const l = link
    const label = sourceLabel(l.provider)
    const facts = [entry.item.publisher, l.year, entry.item.pageCount === null ? null : `${entry.item.pageCount} pages`].filter((x): x is string => x !== null && x !== '')
    return (
      <div className="grid grid-cols-1 gap-2 rounded-md border p-3">
        <div className="flex gap-3">
          {entry.item.coverUrl !== null && isAllowedCoverUrl(entry.item.coverUrl) ? <img src={entry.item.coverUrl} referrerPolicy="no-referrer" className="w-16 shrink-0 self-start rounded" alt="" /> : null}
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-1 text-sm">
            <p className="break-words">
              From {label}:{' '}
              <span dir="auto" className="font-medium">
                {entry.item.title}
              </span>
              {facts.map((f) => (
                <span key={f}>
                  {' · '}
                  <span dir="auto">{f}</span>
                </span>
              ))}
              {entry.item.translators.length > 0 ? (
                <span>
                  {' · translated by '}
                  <span dir="auto">{entry.item.translators.join(', ')}</span>
                </span>
              ) : null}
            </p>
            {ai?.originalTitle != null ? (
              <p className="text-xs text-muted-foreground break-words">
                <span className="font-medium">Same book?</span> Original:{' '}
                <span dir="auto">{ai.originalTitle}</span> · {label}: <span dir="auto">{l.title}</span>
              </p>
            ) : ai === null && original.title !== l.title ? (
              <p className="text-xs text-muted-foreground break-words">
                <span className="font-medium">Same book?</span> In your file:{' '}
                <span dir="auto">{original.title}</span>
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={l.url} target="_blank" rel="noreferrer">
              Open on {label}
            </a>
          </Button>
          <Button size="sm" variant="ghost" disabled={unlink.isPending} onClick={() => unlink.mutate({ proposalId: entry.id })}>
            Unlink
          </Button>
        </div>
      </div>
    )
  }

  // a Hardcover hit by ISBN carries its page; the link is made by id either way (the ISBN path costs one more page read)
  const attachHardcover = async (pick: HardcoverPick) => {
    try {
      const hardcoverId = 'page' in pick ? Number(pick.page.providerId) : pick.hardcoverId
      const r = await trpcClient.shelf.attachHardcover.mutate({ proposalId: entry.id, hardcoverId, editionId: pick.editionId })
      toast.success(<span dir="auto">Linked: {r.title}</span>)
    } finally {
      invalidate()
    }
  }

  // BookLinker picks its first tab once, when it mounts: wait for the answer, or the Hardcover tab would arrive unselected
  if (available.isPending) return null

  return (
    <BookLinker
      idPrefix={`link-${entry.id}`}
      seed={{ title: original.title, subtitle: entry.item.subtitle, series: original.series[0]?.name ?? null, authors: entry.item.authors, spineText: ai?.spineText ?? null, language: original.language }}
      target={{ kind: 'proposal', id: entry.id }}
      {...(hardcoverAvailable ? { hardcover: { onPick: attachHardcover } } : {})}
      onCapture={async (capture) => {
        try {
          const r = await trpcClient.shelf.attachPage.mutate({ proposalId: entry.id, capture })
          toast.success(<span dir="auto">Linked: {r.title}</span>)
        } finally {
          invalidate()
        }
      }}
    />
  )
}
