import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** The batch import takes only these; a single book can also go on the wishlist. */
export type Ownership = 'owned' | 'borrowed'
export type SingleOwnership = Ownership | 'wishlist'

/** Owned | Borrowed (| Wishlist, for a single book), and who lent it. */
export function OwnershipPicker({
  ownership,
  onOwnership,
  borrowedFrom,
  onBorrowedFrom,
  wishlist = false,
  wishlistDisabled = false,
}: {
  ownership: SingleOwnership
  onOwnership: (value: SingleOwnership) => void
  borrowedFrom: string
  onBorrowedFrom: (value: string) => void
  /** offer the third choice (single book only) */
  wishlist?: boolean
  /** the Wishlist choice cannot be picked (the book is already waiting in the Inbox) */
  wishlistDisabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label={wishlist ? 'This book is' : 'These books are'} className="flex gap-1">
        <Button type="button" size="sm" variant={ownership === 'owned' ? 'default' : 'outline'} aria-pressed={ownership === 'owned'} onClick={() => onOwnership('owned')}>
          Owned
        </Button>
        <Button type="button" size="sm" variant={ownership === 'borrowed' ? 'default' : 'outline'} aria-pressed={ownership === 'borrowed'} onClick={() => onOwnership('borrowed')}>
          Borrowed
        </Button>
        {wishlist ? (
          <Button type="button" size="sm" variant={ownership === 'wishlist' ? 'default' : 'outline'} aria-pressed={ownership === 'wishlist'} disabled={wishlistDisabled} onClick={() => onOwnership('wishlist')}>
            Wishlist
          </Button>
        ) : null}
      </div>
      {ownership === 'borrowed' ? (
        <Input aria-label="From whom (optional)" placeholder="From whom (optional)" dir="auto" maxLength={200} className="w-48" value={borrowedFrom} onChange={(e) => onBorrowedFrom(e.target.value)} />
      ) : null}
    </div>
  )
}
