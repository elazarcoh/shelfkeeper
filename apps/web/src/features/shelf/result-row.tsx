import type { ReactNode } from 'react'
import { isAllowedCoverUrl } from '@mylib/domain'

/**
 * One look-up result: a small cover, the title and a "author · year · series #n" line. The whole row is the pick
 * button; `below` (e.g. a Versions toggle) sits under it, outside the button.
 */
export function ResultRow({
  coverUrl,
  title,
  details,
  label,
  disabled,
  onPick,
  below,
}: {
  coverUrl: string | null
  title: string
  details: string
  /** the pick button's accessible name */
  label: string
  disabled?: boolean
  onPick: () => void
  below?: ReactNode
}) {
  return (
    <li className="min-w-0 rounded-md border">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onPick}
        className="flex w-full min-w-0 items-center gap-3 rounded-md p-2 text-start outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 pointer-coarse:min-h-14"
      >
        {coverUrl !== null && isAllowedCoverUrl(coverUrl) ? (
          <img src={coverUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-14 w-10 shrink-0 rounded-sm object-cover" />
        ) : (
          <div className="h-14 w-10 shrink-0 rounded-sm bg-muted" />
        )}
        <span className="grid min-w-0 flex-1 text-sm">
          <span dir="auto" className="font-medium wrap-anywhere">
            {title}
          </span>
          {details !== '' ? (
            <span dir="auto" className="text-xs text-muted-foreground wrap-anywhere">
              {details}
            </span>
          ) : null}
        </span>
      </button>
      {below}
    </li>
  )
}

export const detailsLine = (parts: Array<string | number | null | undefined>): string => parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ')
