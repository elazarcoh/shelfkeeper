import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SessionMode } from '@mylib/domain'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageSection } from '@/components/page'
import { useRemovalFocus } from '@/components/removal-focus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateChoice, type DateChoiceValue } from '@/features/checkin/date-choice'
import { EditionPicker } from '@/features/checkin/edition-picker'
import { CheckinSessionCard } from '@/features/checkin/session-card'
import { resolveStartEdition } from '@/features/checkin/start-edition'
import { ProgressBar } from '@/features/progress/progress-bar'
import { ProgressDialog } from '@/features/progress/progress-dialog'
import { volumeOptions, type VolumeChoice } from '@/features/progress/progress-draft'
import { ProgressList } from '@/features/progress/progress-list'
import { todayLocal } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'
import { describePastSession, markableModes, markLabel } from './mark-finished'
import { MarkFinishedDialog } from './mark-finished-dialog'

type Work = RouterOutputs['catalog']['get']

const startToday = (): DateChoiceValue => ({ date: todayLocal(), precision: 'day' })

function describeStart(when: DateChoiceValue): string {
  switch (when.precision) {
    case 'day':
      return when.date === todayLocal() ? 'today' : `on ${when.date}`
    case 'month':
      return `sometime in ${when.date.slice(0, 7)}`
    case 'year':
      return `sometime in ${when.date.slice(0, 4)}`
    case 'unknown':
      return 'on an unknown date'
  }
}

const SESSIONS_HEADING_ID = 'my-sessions'

// While this row's removal is pending the trigger is aria-disabled, not disabled: focus moves to the next row's
// Remove after a confirm, and a disabled button could not take it. Its click is swallowed, so the dialog cannot
// reopen and the same row cannot be confirmed twice.
function RemoveSessionButton({ onRemove, pending }: { onRemove: (onError: () => void) => void; pending: boolean }) {
  const focus = useRemovalFocus()
  return (
    <ConfirmDialog
      trigger={
        <Button
          ref={focus.triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Remove session"
          aria-disabled={pending ? 'true' : undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-remove-session
          // preventDefault stops the dialog trigger from opening (Radix skips its toggle for a prevented click)
          onClick={(e) => {
            if (pending) e.preventDefault()
          }}
        >
          Remove
        </Button>
      }
      title="Remove this session?"
      description="This cannot be undone."
      confirmLabel="Remove session"
      destructive
      returnFocusRef={focus.closeFocus}
      onOpenChange={focus.onOpenChange}
      onConfirm={() => {
        if (pending) return
        focus.retarget('[data-remove-session]', SESSIONS_HEADING_ID)
        onRemove(focus.restore)
      }}
    />
  )
}

type Session = RouterOutputs['sessions']['listForWork'][number]

/**
 * A past session's points, collapsed: they are only for corrections after the read ended. The list mounts (and
 * fetches) only once the section is opened.
 */
function PastProgress({ session, volumes }: { session: Session; volumes: VolumeChoice | null }) {
  const [open, setOpen] = useState(false)
  const labelId = `progress-updates-${session.id}`
  return (
    <details className="ps-1 text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary id={labelId} className="cursor-pointer text-muted-foreground pointer-coarse:py-3">
        Progress updates ({session.progress.pointCount})
      </summary>
      {open ? <ProgressList sessionId={session.id} info={session.progress} dates={session} fallbackHeadingId={SESSIONS_HEADING_ID} labelId={labelId} volumes={volumes} /> : null}
    </details>
  )
}

export function MySessions({ work, userId }: { work: Work; userId: string }) {
  const invalidate = useInvalidateBook()
  const queryClient = useQueryClient()
  const sessions = useQuery(trpc.sessions.listForWork.queryOptions({ workId: work.id }))
  // the Volume field of a progress update, for a session in a volume set (#69)
  const volumesOf = (s: Session): VolumeChoice | null => {
    const options = s.editionId === null ? null : volumeOptions(work.editions, s.editionId)
    return options === null || s.editionId === null ? null : { options, sessionEditionId: s.editionId }
  }
  const [when, setWhen] = useState<DateChoiceValue>(startToday)
  const [editingWhen, setEditingWhen] = useState(false)
  const [editionPick, setEditionPick] = useState<Record<SessionMode, string | null>>({ read: null, listen: null })
  const start = useMutation(
    trpc.sessions.start.mutationOptions({
      onSuccess: () => {
        invalidate()
        setWhen(startToday())
        setEditingWhen(false)
      },
    }),
  )
  const remove = useMutation(
    trpc.sessions.delete.mutationOptions({
      onSuccess: async () => {
        // a removed session can change the book's status, stats, goals and the activity feed
        invalidate()
        for (const key of [trpc.stats.pathKey(), trpc.goals.pathKey(), trpc.activity.pathKey()]) {
          void queryClient.invalidateQueries({ queryKey: key })
        }
        // stay pending until the list no longer has the row, so its Remove stays blocked until it is gone
        await queryClient.invalidateQueries({ queryKey: trpc.sessions.listForWork.queryKey({ workId: work.id }) })
      },
    }),
  )
  // the sessions whose removal is in flight (several rows can be removed at once)
  const removing = new Set(
    useMutationState({
      filters: { mutationKey: trpc.sessions.delete.mutationKey(), status: 'pending' },
      select: (m) => {
        const vars = m.state.variables
        return typeof vars === 'object' && vars !== null && 'sessionId' in vars && typeof vars.sessionId === 'string' ? vars.sessionId : null
      },
    }),
  )

  // the same latest fraction as Home's bar: the newest point that has one (RP2), not merely the newest point
  const current = useQuery(trpc.progress.current.queryOptions())
  const fractions = new Map((current.data ?? []).map((c) => [c.sessionId, c.fraction]))

  const data = sessions.data ?? []
  const inProgress = data.filter((s) => s.outcome === 'in_progress')
  const inProgressModes = new Set(inProgress.map((s) => s.mode))
  const startable = (['read', 'listen'] as const).filter((mode) => !inProgressModes.has(mode))
  const markable = markableModes(work.editions, inProgressModes)

  return (
    <PageSection id={SESSIONS_HEADING_ID} title="My sessions">
      <div className="grid grid-cols-1 gap-4">
        {startable.length > 0 ? (
          <div className="grid gap-3">
            {/* collapsed by default: starting today needs no extra clicks, and it keeps a second "Today" control away from the finish card */}
            {editingWhen ? (
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Started</span>
                <DateChoice value={when} onChange={setWhen} />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Starting {describeStart(when)}</span>
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setEditingWhen(true)}>
                  Started earlier?
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              {startable.map((mode) => (
                <div key={mode} className="grid gap-2">
                  <EditionPicker
                    id={`start-edition-${mode}`}
                    editions={work.editions}
                    mode={mode}
                    value={editionPick[mode]}
                    onChange={(editionId) => setEditionPick((picks) => ({ ...picks, [mode]: editionId }))}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={start.isPending}
                      onClick={() =>
                        start.mutate({
                          workId: work.id,
                          editionId: resolveStartEdition(work.editions, mode, editionPick[mode]),
                          mode,
                          startedOn: when.date,
                          startedPrecision: when.precision,
                        })
                      }
                    >
                      Start {mode === 'read' ? 'reading' : 'listening'}
                    </Button>
                    {/* a read finished in the past, remembered roughly or not at all: one finished session, no start */}
                    {markable.includes(mode) ? (
                      <MarkFinishedDialog
                        workId={work.id}
                        title={work.title}
                        mode={mode}
                        editionId={resolveStartEdition(work.editions, mode, editionPick[mode])}
                        trigger={
                          <Button type="button" variant="ghost" size="sm">
                            {markLabel(mode)}
                          </Button>
                        }
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {inProgress.map((s) => (
          <div key={s.id} className="grid grid-cols-1 gap-2">
            <CheckinSessionCard sessionId={s.id} workId={work.id} title={work.title} editionId={s.editionId} language={work.editions.find((e) => e.id === s.editionId)?.language ?? null} progress={s.progress} mode={s.mode} started={s} onDone={invalidate} checkinActions={false} userId={userId} />
            {fractions.has(s.id) ? <ProgressBar fraction={fractions.get(s.id) ?? 0} label={`Progress in ${work.title}`} /> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="tabular-nums">
                {s.mode === 'read' ? 'Reading' : 'Listening'} since {s.startedOn}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                <ProgressDialog
                  sessionId={s.id}
                  info={s.progress}
                  dates={s}
                  volumes={volumesOf(s)}
                  trigger={
                    <Button type="button" variant="outline" size="sm">
                      Update progress
                    </Button>
                  }
                />
                <RemoveSessionButton pending={removing.has(s.id)} onRemove={(onError) => remove.mutate({ sessionId: s.id }, { onError })} />
              </span>
            </div>
            {s.progress.pointCount > 0 ? (
              <ProgressList sessionId={s.id} info={s.progress} dates={s} fallbackHeadingId={SESSIONS_HEADING_ID} labelId={`progress-updates-${s.id}`} caption volumes={volumesOf(s)} />
            ) : null}
          </div>
        ))}

        <ul className="grid grid-cols-1 gap-2 text-sm">
          {data
            .filter((s) => s.outcome !== 'in_progress')
            .map((s) => {
              // a finish on an unknown date shows no dates: "Finished, date unknown"
              const described = describePastSession(s)
              return (
                // the details wrap inside their own column, so Remove stays at the row's end instead of dropping to a line of its own
                <li key={s.id} className="grid grid-cols-1 gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge variant="outline">{s.mode === 'read' ? 'Read' : 'Listened'}</Badge>
                      {described.dates !== null ? <span className="tabular-nums text-muted-foreground">{described.dates}</span> : null}
                      <span>{described.outcome}</span>
                      {s.isReread ? <Badge variant="secondary">Reread</Badge> : null}
                    </div>
                    <span className="shrink-0">
                      <RemoveSessionButton pending={removing.has(s.id)} onRemove={(onError) => remove.mutate({ sessionId: s.id }, { onError })} />
                    </span>
                  </div>
                  {s.progress.pointCount > 0 ? <PastProgress session={s} volumes={volumesOf(s)} /> : null}
                </li>
              )
            })}
          {data.length === 0 ? <li className="text-muted-foreground">No sessions yet.</li> : null}
        </ul>
      </div>
    </PageSection>
  )
}
