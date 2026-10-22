import { Link } from '@tanstack/react-router'
import { isAllowedCoverUrl, type EditionFormat, type ExtractedPage, type PageCapture, type ShelfStatus } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { WishFieldsEditor } from '@/features/wishlist/wish-fields'
import { draftFromFields, type WishDraft } from '@/features/wishlist/wish-form-state'
import { OwnershipPicker, type SingleOwnership } from './ownership-picker'
import { shownTitle } from './shelf-state'
import { StatusChip } from './status-chip'
import { VolumeFields, volumeFromFields, type VolumeText } from './volume-fields'

export type SingleBook = { page: ExtractedPage; capture: PageCapture; status: ShelfStatus | null; batchId: string }

/** What the add button says, and what it does: a copy of a book you have, or a new book. */
export function addLabel(status: ShelfStatus | null, ownership: SingleOwnership, alreadyWished = false): string {
  if (ownership === 'wishlist') return alreadyWished ? 'Update my wish' : 'Add to my wishlist'
  if (status?.kind === 'have') return `Add a second copy of ${status.title}`
  if (status?.kind === 'copy_of') return `Add as physical copy of ${status.title}`
  if (status?.kind === 'new_volume') return `Add as volume ${status.volume.number} of ${status.title}`
  // not picked: the maybe stays a separate book
  if (status?.kind === 'maybe') return 'Add as a new book'
  // the waiting Inbox proposal would become a duplicate if it were later accepted as a new book
  if (status?.kind === 'in_inbox') return 'Add anyway'
  return 'Add to library'
}

/** A wish goes on the matched book (have, or picked from a maybe), else it makes a new one. */
export function wishTarget(status: ShelfStatus | null): { action: 'wish_work'; workId: string } | { action: 'create_work' } {
  return status?.kind === 'copy_of' || status?.kind === 'new_volume' || status?.kind === 'have' ? { action: 'wish_work', workId: status.workId } : { action: 'create_work' }
}

/** A copy, another volume or a second copy goes on the matched book as a new edition, else it makes a new book. */
export function addTarget(status: ShelfStatus | null): { action: 'link_new_edition'; workId: string } | { action: 'create_work' } {
  return status?.kind === 'copy_of' || status?.kind === 'have' || status?.kind === 'new_volume' ? { action: 'link_new_edition', workId: status.workId } : { action: 'create_work' }
}

/** A page already waiting in the Inbox must not also become a wanted book: accepting that proposal later would duplicate it. */
export const wishlistBlocked = (status: ShelfStatus | null): boolean => status?.kind === 'in_inbox'

/** My existing wish on the matched book, to seed the form with so updating never blanks it; null when there is none or the list is loading. */
export function existingWishDraft(wishes: { workId: string; formats: EditionFormat[]; language: string | null; note: string | null }[] | undefined, workId: string | null): WishDraft | null {
  const mine = workId === null ? undefined : wishes?.find((w) => w.workId === workId)
  return mine === undefined ? null : draftFromFields(mine)
}

/** The add button waits for the status, and in Wishlist mode for my wishes (else it could overwrite one with blanks). */
export function addDisabled({ adding, status, ownership, wishesLoaded, volumeInvalid = false }: { adding: boolean; status: ShelfStatus | null; ownership: SingleOwnership; wishesLoaded: boolean; volumeInvalid?: boolean }): boolean {
  return adding || volumeInvalid || status === null || (ownership === 'wishlist' && (!wishesLoaded || wishlistBlocked(status)))
}

/** "It's this book" on a maybe: the add then files the copy on that book. */
export const pickMaybe = (status: ShelfStatus | null): ShelfStatus | null => (status?.kind === 'maybe' ? { ...status, kind: 'copy_of' } : status)

export function SingleBookReview({
  book,
  ownership,
  onOwnership,
  borrowedFrom,
  onBorrowedFrom,
  wishDraft,
  onWishDraft,
  alreadyWished,
  wishesLoaded,
  adding,
  onAdd,
  onCancel,
  onPickMaybe,
  volume,
  onVolume,
}: {
  book: SingleBook
  ownership: SingleOwnership
  onOwnership: (value: SingleOwnership) => void
  borrowedFrom: string
  onBorrowedFrom: (value: string) => void
  wishDraft: WishDraft
  onWishDraft: (value: WishDraft) => void
  /** the matched book is already on my wishlist */
  alreadyWished: boolean
  /** my wishes have loaded (the Wishlist add waits for them) */
  wishesLoaded: boolean
  adding: boolean
  onAdd: () => void
  onCancel: () => void
  onPickMaybe: () => void
  /** the volume as the person has it in the form (seeded from the page); editing it overrides the page's */
  volume: VolumeText
  onVolume: (value: VolumeText) => void
}) {
  const p = book.page
  const typed = volumeFromFields(volume)
  const shownVolume = typed === 'invalid' ? p.volume : typed
  const facts = [p.translators.length > 0 ? `Translated by ${p.translators.join(', ')}` : '', p.publisher ?? '', p.year ?? '', p.pageCount !== null ? `${p.pageCount} pages` : ''].filter((f) => f !== '')
  return (
    <Card>
      <CardHeader>
        <CardTitle>This book</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex min-w-0 gap-3">
          {p.coverUrl !== null && isAllowedCoverUrl(p.coverUrl) ? <img src={p.coverUrl} alt="" referrerPolicy="no-referrer" className="h-28 w-[4.5rem] shrink-0 rounded-sm object-cover" /> : null}
          <div className="grid min-w-0 content-start gap-1 text-sm">
            <p className="font-medium wrap-anywhere text-match-parent" dir="auto">
              {shownTitle(p, shownVolume)}
            </p>
            {p.authors.length > 0 ? (
              <p className="text-muted-foreground wrap-anywhere text-match-parent" dir="auto">
                {p.authors.join(', ')}
              </p>
            ) : null}
            {facts.map((f, i) => (
              <p key={i} className="text-muted-foreground wrap-anywhere text-match-parent" dir="auto">
                {f}
              </p>
            ))}
          </div>
        </div>
        <VolumeFields idPrefix="single" value={volume} onChange={onVolume} />
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={book.status} onPickMaybe={book.status?.kind === 'maybe' ? onPickMaybe : undefined} />
          {alreadyWished ? (
            <span role="note" className="text-sm text-muted-foreground">
              On your wishlist
            </span>
          ) : null}
        </div>
        {book.status?.kind === 'in_inbox' ? (
          <p role="note" className="text-sm text-muted-foreground">
            It’s already waiting in your Inbox. Adding it here leaves that one there, so ignore it in the Inbox afterwards — or{' '}
            <Link to="/inbox" search={{ item: book.status.proposalId }} className="font-medium text-foreground underline underline-offset-2">
              file it from the Inbox
            </Link>{' '}
            instead.
          </p>
        ) : null}
        <OwnershipPicker ownership={ownership} onOwnership={onOwnership} borrowedFrom={borrowedFrom} onBorrowedFrom={onBorrowedFrom} wishlist wishlistDisabled={wishlistBlocked(book.status)} />
        {wishlistBlocked(book.status) ? (
          <p role="note" className="text-sm text-muted-foreground">
            Already waiting in your Inbox
          </p>
        ) : null}
        {ownership === 'wishlist' ? <WishFieldsEditor draft={wishDraft} onChange={onWishDraft} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={book.status?.kind === 'in_inbox' ? 'outline' : 'default'} disabled={addDisabled({ adding, status: book.status, ownership, wishesLoaded, volumeInvalid: volumeFromFields(volume) === 'invalid' })} onClick={onAdd} dir="auto">
            {addLabel(book.status, ownership, alreadyWished)}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
