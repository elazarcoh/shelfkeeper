import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { isAllowedCoverUrl, wishVolumesLabel, type WishRow } from '@mylib/domain'
import { KindBadge } from '@/components/kind-badge'
import { EmptyState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { WorkCover } from '@/components/work-cover'
import { formatLabel } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { BoughtDialog } from './bought-dialog'
import { WishDialog, invalidateWishes } from './wish-dialog'
import { criteriaLabel } from './wish-form-state'

function WishCover({ wish }: { wish: WishRow }) {
  const cls = 'w-14 shrink-0'
  const url = wish.page?.coverUrl ?? null
  if (wish.coverAssetId === null && url !== null && isAllowedCoverUrl(url)) {
    return <img src={url} referrerPolicy="no-referrer" alt="" loading="lazy" className={`${cls} aspect-[2/3] rounded-md object-cover shadow-sm`} />
  }
  return <WorkCover title={wish.title} coverAssetId={wish.coverAssetId} className={cls} label={false} />
}

function WishItem({ wish, mine, userId }: { wish: WishRow; mine: boolean; userId: string }) {
  const queryClient = useQueryClient()
  const remove = useMutation(
    trpc.wishlist.remove.mutationOptions({
      onSuccess: () => {
        invalidateWishes(queryClient)
        toast.success('Removed from your wishlist')
      },
    }),
  )
  return (
    <li className="flex gap-3 py-3">
      <WishCover wish={wish} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Link to="/books/$workId" params={{ workId: wish.workId }} className="min-w-0 font-medium break-words text-match-parent hover:underline" dir="auto">
            {wish.title}
          </Link>
          <KindBadge kind={wish.kind} compact />
        </div>
        {wish.authors.length > 0 ? (
          <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
            {wish.authors.join(', ')}
          </p>
        ) : null}
        <p className="text-sm break-words text-match-parent" dir="auto">{criteriaLabel(wish)}</p>
        {wish.volumes !== null ? <p className="text-sm text-muted-foreground">{wishVolumesLabel(wish.volumes)}</p> : null}
        {wish.note !== null ? (
          <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
            {wish.note}
          </p>
        ) : null}
        {wish.haveFormats.length > 0 ? <p className="text-sm text-muted-foreground">You have: {wish.haveFormats.map((f) => formatLabel[f].toLowerCase()).join(', ')}</p> : null}
        {mine ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <BoughtDialog wish={wish} />
            <WishDialog workId={wish.workId} title={wish.title} userId={userId} wish={wish} trigger="edit" />
            <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={remove.isPending} onClick={() => remove.mutate({ workId: wish.workId })}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function WishList({ rows, mine, userId, name }: { rows: WishRow[]; mine: boolean; userId: string; name?: string }) {
  if (rows.length === 0) {
    return mine ? (
      <EmptyState title="Nothing here yet" hint="Add books from a Simania or Open Library page (＋ → Add one book), or with Want it on a book’s page." />
    ) : (
      <EmptyState title="Nothing here yet" hint={`${name ?? 'They'} hasn’t wished for anything yet.`} />
    )
  }
  return (
    <ul className="divide-y rounded-lg border px-3">
      {rows.map((w) => (
        <WishItem key={w.workId} wish={w} mine={mine} userId={userId} />
      ))}
    </ul>
  )
}
