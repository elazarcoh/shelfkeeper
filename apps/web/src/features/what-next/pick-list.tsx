import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import type { EditionFormat } from '@mylib/domain'
import { PageSection } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatLabel, seriesLabel } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { PickRow, type PickRowData } from './pick-row'

type View = RouterOutputs['whatNext']['get']
type Pick = View['lists'][number]['picks'][number]
type Favorite = View['favoriteAuthors'][number]
type Source = View['lists'][number]['source']

export const LIST_TITLE: Record<Source, string> = {
  shelf: 'On your shelves',
  series: 'Next in your series',
  author: 'New from your authors',
  hardcover: 'From Hardcover',
  similar: 'Like what you just finished',
}

const AUDIOBOOK_BADGE = { yes: 'Audiobook', no: 'No audiobook', unknown: 'Audiobook: unknown' } as const

function rowData(pick: Pick): PickRowData {
  const shelf = pick.workId !== null && pick.source === 'shelf'
  return {
    title: pick.title,
    authors: pick.authors,
    series: pick.seriesName === null ? null : seriesLabel({ name: pick.seriesName, position: pick.position }),
    firstUnread: pick.firstUnread,
    pages: pick.pages,
    audioSec: pick.audioSec,
    reason: pick.reason,
    coverAssetId: pick.coverAssetId,
    imageUrl: pick.imageUrl,
    workId: shelf ? pick.workId : null,
    owned: shelf && pick.formats.length > 0 ? pick.formats.map((f: EditionFormat) => formatLabel[f]).join(' · ') : null,
    audiobook: shelf ? null : AUDIOBOOK_BADGE[pick.audiobook],
    kind: pick.kind,
    note: null,
  }
}

/** The follow input for a person known by a contributor id, a Hardcover id or both (the contributor wins). */
export const authorOf = (a: { contributorId: string | null; hardcoverAuthorId: number | null; name: string }) =>
  a.contributorId !== null ? { contributorId: a.contributorId } : a.hardcoverAuthorId !== null ? { hardcoverAuthorId: a.hardcoverAuthorId, name: a.name } : null

/** The follow mutation shared by the ⋯ menus and the "Your authors" section: a refetch is all that changes. */
export function useFollow() {
  const queryClient = useQueryClient()
  return useMutation(
    trpc.whatNext.follow.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.whatNext.pathKey() }),
      onError: (e) => toast.error(e.message),
    }),
  )
}

function PickActions({ pick, favorites }: { pick: Pick; favorites: Favorite[] }) {
  const queryClient = useQueryClient()
  const refetch = () => queryClient.invalidateQueries({ queryKey: trpc.whatNext.pathKey() })
  const queueAdd = useMutation(
    trpc.tracking.queueAdd.mutationOptions({
      onSuccess: () => {
        toast.success('Added to Up next')
        for (const key of [trpc.library.pathKey(), trpc.catalog.pathKey()]) void queryClient.invalidateQueries({ queryKey: key })
      },
      onError: (e) => toast.error(e.message),
    }),
  )
  const wish = useMutation(
    trpc.whatNext.wish.mutationOptions({
      onSuccess: () => {
        toast.success('Added to your wishlist')
        void refetch()
        void queryClient.invalidateQueries({ queryKey: trpc.wishlist.pathKey() })
      },
      onError: (e) => toast.error(e.message),
    }),
  )
  const unhide = useMutation(trpc.whatNext.unhide.mutationOptions({ onSettled: refetch, onError: (e) => toast.error(e.message) }))
  const hide = useMutation(
    trpc.whatNext.hide.mutationOptions({
      onSuccess: () => {
        void refetch()
        toast(`Hid “${pick.title}” from your picks`, { action: { label: 'Undo', onClick: () => unhide.mutate({ key: pick.key }) } })
      },
      onError: (e) => toast.error(e.message),
    }),
  )
  const follow = useFollow()
  const hardcoverId = pick.hardcoverId
  const shelfWorkId = pick.source === 'shelf' ? pick.workId : null
  const onShelf = shelfWorkId !== null
  // each author of the pick: one already in "Your authors" can be stopped, any other followed
  const people = pick.authorRefs.flatMap((r) => {
    const favorite = favorites.find((f) => (r.contributorId !== null && f.contributorId === r.contributorId) || (r.hardcoverAuthorId !== null && f.hardcoverAuthorId === r.hardcoverAuthorId))
    const author = r.contributorId !== null ? { contributorId: r.contributorId } : r.hardcoverAuthorId !== null ? { hardcoverAuthorId: r.hardcoverAuthorId, name: r.name } : null
    return author === null ? [] : [{ name: r.name, author, favorite }]
  })

  return (
    <>
      {shelfWorkId !== null ? (
        <Button size="sm" variant="outline" disabled={queueAdd.isPending} className="pointer-coarse:min-h-11" onClick={() => queueAdd.mutate({ workId: shelfWorkId, where: 'bottom' })}>
          Add to Up next
        </Button>
      ) : pick.onWishlist ? (
        <Badge variant="secondary">On your Wishlist</Badge>
      ) : hardcoverId !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={wish.isPending}
          className="pointer-coarse:min-h-11"
          onClick={() => wish.mutate({ kind: 'hardcover', hardcoverId, reason: pick.reason })}
        >
          Add to Wishlist
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={`More actions for ${pick.title}`} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pick.hardcoverId !== null ? (
            <DropdownMenuItem asChild>
              <a href={`https://hardcover.app/id/book/${String(pick.hardcoverId)}`} target="_blank" rel="noopener noreferrer">
                Open on Hardcover
              </a>
            </DropdownMenuItem>
          ) : null}
          {people.map(({ name, author, favorite }, i) => (
            <DropdownMenuItem key={`${String(i)}|${name}`} disabled={follow.isPending} onSelect={() => follow.mutate({ author: favorite ? (authorOf(favorite) ?? author) : author, mode: favorite ? (favorite.why === 'auto' ? 'unfollow' : null) : 'follow' })}>
              <span dir="auto">
                {favorite ? 'Stop suggesting' : 'Follow'} {name}
              </span>
            </DropdownMenuItem>
          ))}
          {!onShelf ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={hide.isPending} onSelect={() => hide.mutate({ key: pick.key })}>
                Not interested
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export function PickList({ source, picks, favorites }: { source: Source; picks: Pick[]; favorites: Favorite[] }) {
  return (
    <PageSection id={`next-${source}`} title={LIST_TITLE[source]}>
      <ul className="divide-y rounded-lg border">
        {picks.map((pick) => (
          <PickRow key={pick.key} data={rowData(pick)}>
            <PickActions pick={pick} favorites={favorites} />
          </PickRow>
        ))}
      </ul>
    </PageSection>
  )
}
