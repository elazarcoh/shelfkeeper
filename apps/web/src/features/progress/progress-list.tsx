import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionProgressInfo } from '@mylib/domain'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useRemovalFocus } from '@/components/removal-focus'
import { Button } from '@/components/ui/button'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { ProgressDialog } from './progress-dialog'
import { dayLabel, percentText, pointLabel, pointName, type SessionDates, type VolumeChoice } from './progress-draft'
import { invalidateProgressQueries } from './use-invalidate-progress'

// While its removal is pending the trigger is aria-disabled, not disabled, so focus can still land on it (as in My sessions).
function RemoveProgressButton({ name, fallbackHeadingId, pending, onRemove }: { name: string; fallbackHeadingId: string; pending: boolean; onRemove: (onError: () => void) => void }) {
  const focus = useRemovalFocus()
  return (
    <ConfirmDialog
      trigger={
        <Button
          ref={focus.triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove progress ${name}`}
          aria-disabled={pending ? 'true' : undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-remove-progress
          onClick={(e) => {
            if (pending) e.preventDefault()
          }}
        >
          Remove
        </Button>
      }
      title="Remove this progress update?"
      description="Your stats are recalculated without it."
      confirmLabel="Remove update"
      destructive
      returnFocusRef={focus.closeFocus}
      onOpenChange={focus.onOpenChange}
      onConfirm={() => {
        if (pending) return
        focus.retarget('[data-remove-progress]', fallbackHeadingId)
        onRemove(focus.restore)
      }}
    />
  )
}

/**
 * A session's progress points, newest first, each with Edit and Remove (corrections allowed after finishing too).
 * The list is named by the element `labelId`: its own muted "Progress updates" caption when `caption` is set, else
 * one outside it (a past session's summary).
 */
export function ProgressList({
  sessionId,
  info,
  dates,
  fallbackHeadingId,
  labelId,
  caption = false,
  volumes = null,
}: {
  sessionId: string
  info: SessionProgressInfo
  dates: SessionDates
  fallbackHeadingId: string
  labelId: string
  caption?: boolean | undefined
  volumes?: VolumeChoice | null | undefined
}) {
  const queryClient = useQueryClient()
  const points = useQuery(trpc.progress.list.queryOptions({ sessionId }))
  const remove = useMutation(
    trpc.progress.remove.mutationOptions({
      // stays pending until the list no longer has the row, so its Remove stays blocked until it is gone
      onSuccess: () => invalidateProgressQueries(queryClient),
    }),
  )
  // the points whose removal is in flight (several rows can be removed at once)
  const removing = new Set(
    useMutationState({
      filters: { mutationKey: trpc.progress.remove.mutationKey(), status: 'pending' },
      select: (m) => {
        const vars = m.state.variables
        return typeof vars === 'object' && vars !== null && 'pointId' in vars && typeof vars.pointId === 'string' ? vars.pointId : null
      },
    }),
  )
  const today = todayLocal()
  if (!points.data || points.data.length === 0) return null
  const list = (
    <ul className="grid grid-cols-1 gap-1 text-sm" aria-labelledby={labelId}>
      {points.data.map((p) => {
        const name = pointName(p, today)
        return (
          <li key={p.id} className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tabular-nums">
                {p.volume !== null ? `Vol ${p.volume} · ` : ''}
                {pointLabel(p.kind, p.value)}
              </span>
              <span className="text-muted-foreground tabular-nums">{p.fraction === null ? 'no length yet' : percentText(p.fraction)}</span>
              <span className="text-muted-foreground">{dayLabel(p.on, today)}</span>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              <ProgressDialog
                sessionId={sessionId}
                info={info}
                dates={dates}
                point={p}
                volumes={volumes}
                trigger={
                  <Button type="button" variant="ghost" size="sm" aria-label={`Edit progress ${name}`}>
                    Edit
                  </Button>
                }
              />
              <RemoveProgressButton
                name={name}
                fallbackHeadingId={fallbackHeadingId}
                pending={removing.has(p.id)}
                onRemove={(onError) => remove.mutate({ pointId: p.id }, { onError })}
              />
            </span>
          </li>
        )
      })}
    </ul>
  )
  if (!caption) return list
  return (
    <div className="grid grid-cols-1 gap-1">
      <p id={labelId} className="text-xs text-muted-foreground">
        Progress updates
      </p>
      {list}
    </div>
  )
}
