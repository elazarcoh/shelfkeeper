import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { resolveDateRange, type DatePrecision, type SessionMode, type SessionProgressInfo } from '@mylib/domain'
import { StarRating } from '@/components/star-rating'
import { Button } from '@/components/ui/button'
import {
  abandonChoiceAllowed,
  abandonNote,
  describeLatest,
  draftErrorsFor,
  initialDraft,
  pointLabel,
  readDraft,
  resolveAbandon,
  selectedAbandonChoice,
  stillGoingLabel,
  whereIStopped,
  type AbandonChoice,
  type DraftErrors,
  type ProgressDraft,
} from '@/features/progress/progress-draft'
import { ProgressField } from '@/features/progress/progress-field'
import { useInvalidateProgress } from '@/features/progress/use-invalidate-progress'
import { addDaysLocal, todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { CheckinCard, QuotedTitle } from './checkin-card'
import { DateChoice, type DateChoiceValue } from './date-choice'
import { undatedFinishNote } from './date-options'
import { volumeActions } from './volume-actions'

interface Props {
  sessionId: string
  workId: string
  title: string
  /** the session's edition (null: none picked) and its language, for the volume actions */
  editionId?: string | null
  language?: string | null
  /** the session's edition length and latest point (SessionView.progress) */
  progress: SessionProgressInfo
  mode: SessionMode
  /** the session's start: the finish's date pickers offer nothing before it */
  started: { startedOn: string; startedPrecision: DatePrecision }
  onDone: () => void
  /** "Still going" / "Snooze a week" only make sense from the check-in flow; the book page hides them. */
  checkinActions?: boolean
  /** the signed-in user, for the book page's "On your wishlist" */
  userId?: string | undefined
}

type Mode = 'idle' | 'finishing' | 'finishingVolume' | 'abandoning' | 'suggesting'

/** Spec §7: "On finish: suggest head of up-next queue and series continuation." */
function FinishSuggestion({ workId, onDone }: { workId: string; onDone: () => void }) {
  const continuation = useQuery(trpc.series.continuationForWork.queryOptions({ workId }))
  const queue = useQuery(trpc.library.queue.queryOptions())
  const next = continuation.data?.[0]
  const upNext = queue.data?.[0]

  return (
    <CheckinCard title="Nicely done!">
      {next ? (
        <p dir="auto">
          Continue <strong>{next.seriesName}</strong> with{' '}
          <Link
            to="/books/$workId"
            params={{ workId: next.nextWorkId }}
            className="underline-offset-4 hover:underline"
            onClick={onDone}
          >
            {next.nextTitle}
          </Link>
          .
        </p>
      ) : null}
      {upNext ? (
        <p dir="auto">
          Up next:{' '}
          <Link to="/books/$workId" params={{ workId: upNext.id }} className="underline-offset-4 hover:underline" onClick={onDone}>
            {upNext.title}
          </Link>
          .
        </p>
      ) : null}
      {!next && !upNext ? <p className="text-muted-foreground">Nothing queued yet.</p> : null}
      <Button onClick={onDone}>Done</Button>
    </CheckinCard>
  )
}

const FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
]

export function CheckinSessionCard({ sessionId, workId, title, editionId = null, language = null, progress, mode: sessionMode, started, onDone, checkinActions = true, userId }: Props) {
  const [mode, setMode] = useState<Mode>('idle')
  const [when, setWhen] = useState<DateChoiceValue>({ date: todayLocal(), precision: 'day' })
  const [rating, setRating] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const fieldId = `progress-${sessionId}`
  const [draft, setDraft] = useState<ProgressDraft>(() => initialDraft(progress))
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({})
  const parsed = readDraft(draft, progress)
  // the label and the layout follow the value alone, so a half-typed length ("9:") does not reflow the buttons
  const valueOnly = readDraft(draft, progress, false)
  const typed = draft.value.trim() !== ''
  const typedPoint = valueOnly.ok && valueOnly.point !== null
  const invalidateProgress = useInvalidateProgress()
  // its error shows inline under the field (meta.inlineError: no second, global toast)
  const addProgress = useMutation(trpc.progress.add.mutationOptions({ onSuccess: invalidateProgress, meta: { inlineError: true } }))
  // "Still going" with nothing new: check-in leaves this book alone for 12 hours (#45)
  const checkedIn = useMutation(trpc.sessions.checkedIn.mutationOptions())
  // spec §3: abandoning offers "where I stopped" as the default; ¼/½/¾ stay. It is the value typed in the field when
  // there is one, else the latest saved point, resolved from the current props at Save (RP1), so a point added after
  // this card mounted (book page) is picked up.
  const stopped = whereIStopped(parsed, progress)
  const [abandonChoice, setAbandonChoice] = useState<AbandonChoice>('default')
  const selected = selectedAbandonChoice(abandonChoice, stopped, progress.highest)
  const abandonHint = abandonNote(stopped, progress.highest, Math.min(...FRACTIONS.map(([value]) => value)))

  /** An unreadable value is not dropped silently: it is pointed out, and the action waits. */
  function draftIsReadable(): boolean {
    if (parsed.ok) return true
    flushSync(() => setDraftErrors(draftErrorsFor(parsed)))
    document.getElementById(`${fieldId}-${parsed.field}`)?.focus()
    return false
  }

  /** Empty field: noted, so check-in leaves the book alone for 12 hours. A value: save it first, then move on. */
  function stillGoing() {
    if (!draftIsReadable() || !parsed.ok) return
    if (parsed.point === null) {
      checkedIn.mutate({ sessionId }, { onSuccess: onDone })
      return
    }
    addProgress.mutate({ sessionId, today: todayLocal(), ...parsed.point }, { onSuccess: onDone })
  }

  /** Empty field: exactly as before. A typed value becomes "where I stopped" on the next card. */
  function startAbandoning() {
    if (draftIsReadable()) setMode('abandoning')
  }

  /** Finishing/abandoning a session moves it out of "currently reading" and feeds stats, goals, series and activity. */
  const refresh = () => {
    for (const key of [
      trpc.library.pathKey(),
      trpc.stats.pathKey(),
      trpc.goals.pathKey(),
      trpc.series.pathKey(),
      trpc.activity.pathKey(),
      // a finished session leaves Home's progress bar
      trpc.progress.pathKey(),
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
  // the rating shows on the book page, in library lists and in the household activity feed
  const setRatingMutation = useMutation(
    trpc.tracking.setRating.mutationOptions({
      onSuccess: () => {
        for (const key of [trpc.catalog.pathKey(), trpc.library.pathKey(), trpc.activity.pathKey()]) {
          void queryClient.invalidateQueries({ queryKey: key })
        }
      },
    }),
  )
  const complete = useMutation(trpc.sessions.complete.mutationOptions({ onSuccess: refresh }))
  const snooze = useMutation(trpc.sessions.snooze.mutationOptions())
  const va = volumeActions(progress)
  // the new volume changes the card's own props (sessions) as well as stats and Home's bar
  const nextVolume = useMutation(
    trpc.sessions.nextVolume.mutationOptions({
      onSuccess: () => {
        refresh()
        void queryClient.invalidateQueries({ queryKey: trpc.sessions.pathKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.catalog.pathKey() })
      },
      onError: (error) => toast.error(error.message),
    }),
  )
  const wish = useMutation(
    trpc.wishlist.upsert.mutationOptions({
      onSuccess: () => {
        toast.success('Added to your wishlist')
        void queryClient.invalidateQueries({ queryKey: trpc.wishlist.pathKey() })
      },
      onError: (error) => toast.error(error.message),
    }),
  )
  // the waiting line's "Add to my wishlist" must not overwrite a wish the user already has on the book
  const wishes = useQuery({ ...trpc.wishlist.forWork.queryOptions({ workId }), enabled: va.waiting !== null && !checkinActions })
  const wished = userId !== undefined && (wishes.data?.some((w) => w.userId === userId) ?? false)

  function snoozeAWeek() {
    snooze.mutate({ sessionId, until: addDaysLocal(7) }, { onSuccess: onDone })
  }

  function finish() {
    complete.mutate(
      { sessionId, completion: { outcome: 'finished', finishedOn: when.date, finishedPrecision: when.precision, fractionCompleted: null } },
      {
        onSuccess: () => {
          if (rating !== null) setRatingMutation.mutate({ workId, rating })
          toast.success('Finished', { action: { label: 'What next?', onClick: () => void navigate({ to: '/next' }) } })
          setMode('suggesting')
        },
      },
    )
  }

  function askFinished() {
    setWhen({ date: todayLocal(), precision: 'day' })
    setMode('finishing')
  }

  /** "Finished volume k" asks for the day first (default today), like Finished does. */
  function askVolumeDate() {
    if (!draftIsReadable() || editionId === null) return
    setWhen({ date: todayLocal(), precision: 'day' })
    setMode('finishingVolume')
  }

  /** The day is chosen: a typed value is saved first, then the server ends this volume on that day and moves on (or waits). */
  function finishVolume() {
    if (!draftIsReadable() || editionId === null) return
    // a cleared date means today; the typed value lands on the same day, so the end of the volume replaces it
    const day = when.date === '' ? todayLocal() : when.date
    const move = () =>
      nextVolume.mutate(
        { sessionId, editionId, today: todayLocal(), on: day },
        {
          onSuccess: (result) => {
            toast.success(result.moved ? `On to volume ${result.volume}` : `Waiting for volume ${result.waitingFor}`)
            // the book page keeps this card: it must not stay on the date step for the next volume
            setMode('idle')
            if (checkinActions) onDone()
          },
          onError: () => setMode('idle'),
        },
      )
    if (parsed.ok && parsed.point !== null) addProgress.mutate({ sessionId, today: todayLocal(), on: day, ...parsed.point }, { onSuccess: move })
    else move()
  }

  function addToWishlist() {
    wish.mutate({
      workId,
      formats: progress.editionFormat === null ? [] : [progress.editionFormat],
      language,
      note: `Volume ${(progress.volume?.volume ?? 0) + 1}`,
    })
  }

  /** "Where I stopped" from a typed value saves that point first, then abandons with its fraction. */
  function abandon() {
    const { fractionCompleted, save } = resolveAbandon(abandonChoice, stopped, progress.highest)
    const today = todayLocal()
    const completeIt = () =>
      complete.mutate(
        { sessionId, completion: { outcome: 'abandoned', finishedOn: today, finishedPrecision: 'day', fractionCompleted } },
        { onSuccess: onDone },
      )
    if (save === null) completeIt()
    else addProgress.mutate({ sessionId, today, ...save }, { onSuccess: completeIt })
  }

  const busy = addProgress.isPending || complete.isPending || snooze.isPending || nextVolume.isPending || checkedIn.isPending
  const progressError = addProgress.error ? (
    <p role="alert" className="text-xs text-destructive">
      {addProgress.error.message}
    </p>
  ) : null

  if (mode === 'finishing') {
    return (
      <CheckinCard
        title={
          <>
            Finished <QuotedTitle title={title} />?
          </>
        }
      >
        <DateChoice
          value={when}
          onChange={setWhen}
          minDate={resolveDateRange(started.startedOn, started.startedPrecision).from}
          unknownNote={undatedFinishNote(sessionMode)}
        />
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Rate it (optional)</span>
          <StarRating value={rating} onChange={setRating} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={finish} disabled={complete.isPending}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            Back
          </Button>
        </div>
      </CheckinCard>
    )
  }
  if (mode === 'finishingVolume' && va.finishVolume !== null) {
    return (
      <CheckinCard
        title={
          <>
            {va.finishVolume.label} of <QuotedTitle title={title} />?
          </>
        }
      >
        <DateChoice dayOnly value={when} onChange={setWhen} minDate={resolveDateRange(started.startedOn, started.startedPrecision).from} />
        {progressError}
        <div className="flex flex-wrap gap-2">
          <Button onClick={finishVolume} disabled={busy}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            Back
          </Button>
        </div>
      </CheckinCard>
    )
  }

  if (mode === 'abandoning') {
    return (
      <CheckinCard
        title={
          <>
            How far into <QuotedTitle title={title} /> did you get?
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap gap-2">
          {/* #8: a typed value without a fraction is not a choice (the note says why); #7: one below the high-water mark is off */}
          {stopped !== null && stopped.fraction !== null ? (
            <Button
              type="button"
              className="whitespace-normal"
              variant={selected === 'stopped' ? 'default' : 'outline'}
              disabled={!abandonChoiceAllowed('stopped', stopped, progress.highest)}
              onClick={() => setAbandonChoice('stopped')}
            >
              Where I stopped · {pointLabel(stopped.kind, stopped.value)}
            </Button>
          ) : null}
          {FRACTIONS.map(([value, label]) => (
            <Button
              key={label}
              type="button"
              variant={selected === value ? 'default' : 'outline'}
              disabled={!abandonChoiceAllowed(value, stopped, progress.highest)}
              onClick={() => setAbandonChoice(value)}
            >
              {label}
            </Button>
          ))}
          <Button type="button" variant={selected === 'unsure' ? 'default' : 'outline'} onClick={() => setAbandonChoice('unsure')}>
            Not sure
          </Button>
        </div>
        {abandonHint !== null ? <p className="text-xs text-muted-foreground">{abandonHint}</p> : null}
        {progressError}
        <div className="flex flex-wrap gap-2">
          <Button onClick={abandon} disabled={addProgress.isPending || complete.isPending}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => setMode('idle')}>
            Back
          </Button>
        </div>
      </CheckinCard>
    )
  }
  if (mode === 'suggesting') {
    return <FinishSuggestion workId={workId} onDone={onDone} />
  }
  return (
    // on the book page (no check-in actions) the book's own title is already the page heading
    <CheckinCard title={checkinActions ? title : 'In progress'} description={checkinActions ? 'Still reading this one?' : undefined}>
      {va.waiting !== null ? (
        <div className="grid grid-cols-1 gap-1.5">
          <p className="text-sm text-muted-foreground">{va.waiting}</p>
          {!checkinActions ? (
            wished ? (
              <p className="text-sm text-muted-foreground">On your wishlist</p>
            ) : (
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={addToWishlist} disabled={wish.isPending}>
                Add to my wishlist
              </Button>
            )
          ) : null}
        </div>
      ) : null}
      {/* only in the check-in: the book page has its own "Update progress" */}
      {checkinActions ? (
        <div className="grid grid-cols-1 gap-1.5">
          <ProgressField
            id={fieldId}
            info={progress}
            draft={draft}
            optional
            errors={draftErrors}
            note={progress.latest !== null ? describeLatest(progress.latest, todayLocal()) : undefined}
            onChange={(next) => {
              setDraft(next)
              setDraftErrors({})
              addProgress.reset()
            }}
          />
          {progressError}
        </div>
      ) : null}
      {/* phones: a 2 × 2 grid of equal buttons instead of a ragged wrap. A typed value makes "Still going · p. 560"
          the primary action (Finished steps down to outline); empty, Finished stays primary as before. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {va.finishVolume !== null ? (
          <Button variant={typedPoint ? 'outline' : 'default'} className="col-span-2 sm:col-span-1" onClick={askVolumeDate} disabled={busy || editionId === null}>
            {va.finishVolume.label}
          </Button>
        ) : null}
        <Button variant={typedPoint || va.finishVolume !== null ? 'outline' : 'default'} onClick={askFinished} disabled={busy}>
          {va.finishBookLabel}
        </Button>
        <Button variant="outline" onClick={startAbandoning} disabled={busy}>
          Abandoned
        </Button>
        {checkinActions ? (
          <>
            <Button
              variant={typedPoint ? 'default' : 'outline'}
              // with a value the label grows ("Still going · 12:30:45"): it takes the whole phone row instead of widening it
              className={cn(typed && 'col-span-2 whitespace-normal sm:col-span-1')}
              onClick={stillGoing}
              disabled={busy}
            >
              {stillGoingLabel(valueOnly)}
            </Button>
            {/* …and Snooze follows it onto a whole row, rather than sitting alone in a half */}
            <Button variant="outline" className={cn(typed && 'col-span-2 sm:col-span-1')} onClick={snoozeAWeek} disabled={busy}>
              Snooze a week
            </Button>
          </>
        ) : null}
      </div>
    </CheckinCard>
  )
}
