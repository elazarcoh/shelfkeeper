import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode, type SubmitEvent } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { SessionMode } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { StarRating } from '@/components/star-rating'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { QuotedTitle } from '@/features/checkin/checkin-card'
import { recentYears, undatedFinishNote } from '@/features/checkin/date-options'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'
import { pastFinish, type PastFinishChoice, type PastFinishFields } from './mark-finished'

const CHOICES: { choice: PastFinishChoice; label: string }[] = [
  { choice: 'unknown', label: 'Long ago / don’t remember' },
  { choice: 'year', label: 'In a year…' },
  { choice: 'month', label: 'In a month…' },
  { choice: 'day', label: 'Exact date' },
]

const freshFields = (today: string): PastFinishFields => ({ year: String(Number(today.slice(0, 4)) - 1), month: today.slice(0, 7), day: today })

interface MarkFinishedDialogProps {
  workId: string
  title: string
  mode: SessionMode
  /** the edition the Start flow would use (resolveStartEdition) */
  editionId: string | null
  trigger: ReactNode
}

/**
 * "Mark as read… / listened…" on the book page: a finished read the user remembers only roughly, or not at all, saved
 * as one finished session. "Long ago / don't remember" counts as read but stays out of every dated stat.
 */
export function MarkFinishedDialog({ workId, title, mode, editionId, trigger }: MarkFinishedDialogProps) {
  const id = useId()
  const queryClient = useQueryClient()
  const invalidateBook = useInvalidateBook()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<PastFinishChoice>('unknown')
  const [fields, setFields] = useState<PastFinishFields>(() => freshFields(todayLocal()))
  const [rating, setRating] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const mark = useMutation(
    trpc.sessions.markFinished.mutationOptions({
      onSuccess: () => {
        // a finished read (and its rating) changes the status, series progress, stats, goals and the activity feed
        invalidateBook()
        for (const key of [trpc.stats.pathKey(), trpc.goals.pathKey(), trpc.activity.pathKey()]) {
          void queryClient.invalidateQueries({ queryKey: key })
        }
        setOpen(false)
        toast.success(mode === 'listen' ? 'Marked as listened' : 'Marked as read', { action: { label: 'What next?', onClick: () => void navigate({ to: '/next' }) } })
      },
      // the server's message shows in the sheet (no second, global toast behind it)
      meta: { inlineError: true },
    }),
  )

  // reset as it opens, during render, so the last answer never paints (ProgressDialog's pattern)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setChoice('unknown')
      setFields(freshFields(todayLocal()))
      setRating(null)
      setProblem(null)
    }
  }
  // a mutation is an outside store: its last error is cleared in the event, not during render
  function changeOpen(next: boolean) {
    if (next) mark.reset()
    setOpen(next)
  }

  const today = todayLocal()
  const pickerId = `${id}-${choice}`

  function change(next: Partial<PastFinishFields>) {
    setFields((f) => ({ ...f, ...next }))
    setProblem(null)
    mark.reset()
  }

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const finish = pastFinish(choice, fields, today)
    if (!finish.ok) {
      flushSync(() => setProblem(finish.message))
      document.getElementById(pickerId)?.focus()
      return
    }
    // a second Enter before the re-render, or a retry: the server returns the session it already made
    if (mark.isPending) return
    // the rating saves with the read, in one transaction
    mark.mutate({ workId, editionId, mode, finishedOn: finish.finishedOn, finishedPrecision: finish.finishedPrecision, rating })
  }

  const fieldError = problem ?? undefined
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent bare className="sm:max-w-sm">
        <DialogPanel
          title="When did you finish?"
          description={
            <span className="block break-words text-match-parent" dir="auto">
              Mark <QuotedTitle title={title} /> as {mode === 'listen' ? 'listened' : 'read'}
            </span>
          }
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={mark.isPending}>
              Save
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-4">
            <div role="group" aria-label="When did you finish?" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CHOICES.map((c) => (
                <Button
                  key={c.choice}
                  type="button"
                  variant={choice === c.choice ? 'default' : 'outline'}
                  aria-pressed={choice === c.choice}
                  className="h-auto min-h-9 justify-start py-2 text-start whitespace-normal"
                  onClick={() => {
                    setChoice(c.choice)
                    setProblem(null)
                    mark.reset()
                  }}
                >
                  {c.label}
                </Button>
              ))}
            </div>
            {choice === 'unknown' ? (
              <p className="text-sm text-muted-foreground">{undatedFinishNote(mode)}</p>
            ) : null}
            {choice === 'year' ? (
              <Field label="Year" htmlFor={pickerId} error={fieldError}>
                <NativeSelect id={pickerId} value={fields.year} onChange={(e) => change({ year: e.target.value })}>
                  {recentYears(today).map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {choice === 'month' ? (
              <Field label="Month" htmlFor={pickerId} error={fieldError}>
                <Input id={pickerId} type="month" value={fields.month} max={today.slice(0, 7)} onChange={(e) => change({ month: e.target.value })} />
              </Field>
            ) : null}
            {choice === 'day' ? (
              <Field label="Date" htmlFor={pickerId} error={fieldError}>
                <Input id={pickerId} type="date" value={fields.day} max={today} onChange={(e) => change({ day: e.target.value })} />
              </Field>
            ) : null}
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Rate it (optional)</span>
              <StarRating value={rating} onChange={setRating} />
            </div>
            {mark.error ? (
              <p role="alert" className="text-sm text-destructive">
                {mark.error.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
