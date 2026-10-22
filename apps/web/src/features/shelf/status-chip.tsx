import { Link } from '@tanstack/react-router'
import { volumeList, type ShelfStatus } from '@mylib/domain'
import { Button } from '@/components/ui/button'

const chip = 'inline-flex min-w-0 flex-wrap items-center gap-x-1 rounded-md bg-muted px-2 py-0.5 text-xs'
const link = 'font-medium underline underline-offset-2 wrap-anywhere'

/** What the review knows about a row: new, a copy of a book you have, already yours, in the Inbox, or a repeat. */
export function StatusChip({ status, onPickMaybe }: { status: ShelfStatus | null; onPickMaybe?: (() => void) | undefined }) {
  if (status === null) return <span className={`${chip} text-muted-foreground`}>Checking…</span>
  switch (status.kind) {
    case 'new':
      return <span className={chip}>New</span>
    case 'copy_of':
      return (
        <span className={chip}>
          Physical copy of{' '}
          <Link to="/books/$workId" params={{ workId: status.workId }} className={link} dir="auto">
            {status.title}
          </Link>
        </span>
      )
    case 'new_volume':
      return (
        <span className={chip}>
          Volume {status.volume.number} of{' '}
          <Link to="/books/$workId" params={{ workId: status.workId }} className={link} dir="auto">
            {status.title}
          </Link>{' '}
          (you have {volumeList(status.volume.have)})
        </span>
      )
    case 'have':
      return (
        <span className={chip}>
          You already have this{' '}
          <Link to="/books/$workId" params={{ workId: status.workId }} className={link} dir="auto">
            {status.title}
          </Link>
        </span>
      )
    case 'maybe':
      return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
          <span className={chip}>
            Maybe{' '}
            <Link to="/books/$workId" params={{ workId: status.workId }} className={link} dir="auto">
              {status.title}
            </Link>
            ?
          </span>
          {onPickMaybe ? (
            <Button type="button" variant="outline" size="xs" onClick={onPickMaybe}>
              It's this book
            </Button>
          ) : null}
        </span>
      )
    case 'in_inbox':
      return (
        <Link to="/inbox" search={{ item: status.proposalId }} className={`${chip} ${link}`}>
          Already in your Inbox
        </Link>
      )
    case 'repeat':
      return <span className={chip}>Repeat of row {status.of + 1}</span>
  }
}
