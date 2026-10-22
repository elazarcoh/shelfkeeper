import { useMutation } from '@tanstack/react-query'
import { useId, useState, type ReactNode, type SubmitEvent } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import type { ProgressPointView, SessionProgressInfo } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { NativeSelect } from '@/components/native-select'
import { Input } from '@/components/ui/input'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import {
  draftErrorsFor,
  draftFromPoint,
  infoForVolume,
  initialDraft,
  initialVolume,
  progressDayBounds,
  readDraft,
  type DraftErrors,
  type ProgressDraft,
  type SessionDates,
  type VolumeChoice,
} from './progress-draft'
import { ProgressField } from './progress-field'
import { useInvalidateProgress } from './use-invalidate-progress'

interface ProgressDialogProps {
  sessionId: string
  info: SessionProgressInfo
  /** the date field allows the start's earliest day through today (and not after a finished read ended) */
  dates: SessionDates
  /** given: edit this point; otherwise add one */
  point?: ProgressPointView | undefined
  /** the session's volume set, when it has two or more volumes in the catalog: shows the Volume field (#69) */
  volumes?: VolumeChoice | null | undefined
  trigger: ReactNode
}

/** "Update progress" (date defaults to today, editable) and "Edit progress" — reading progress spec §5, book page. */
export function ProgressDialog({ sessionId, info, dates, point, volumes = null, trigger }: ProgressDialogProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [on, setOn] = useState(todayLocal)
  const [draft, setDraft] = useState<ProgressDraft>(() => (point ? draftFromPoint(point) : initialDraft(info)))
  const startVolume = () => (volumes === null ? '' : initialVolume(volumes.options, volumes.sessionEditionId, point))
  const [volume, setVolume] = useState(startVolume)
  const [errors, setErrors] = useState<DraftErrors>({})
  const invalidate = useInvalidateProgress()
  const done = {
    onSuccess: () => {
      invalidate()
      setOpen(false)
      toast.success('Progress saved')
    },
    // the server's message shows in the sheet, under the fields (no second, global toast behind it)
    meta: { inlineError: true },
  }
  const add = useMutation(trpc.progress.add.mutationOptions(done))
  const update = useMutation(trpc.progress.update.mutationOptions(done))

  // reset as it opens, during render, so the old draft never paints (NameDialog's pattern)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setOn(point?.on ?? todayLocal())
      setDraft(point ? draftFromPoint(point) : initialDraft(info))
      setVolume(startVolume())
      setErrors({})
    }
  }
  // a mutation is an outside store: its last error is cleared in the event, not during render
  function changeOpen(next: boolean) {
    if (next) {
      add.reset()
      update.reset()
    }
    setOpen(next)
  }

  // the checks and the length prompt follow the chosen volume
  const readInfo = volumes === null ? info : infoForVolume(info, volumes.options, volume)
  const today = todayLocal()
  const bounds = progressDayBounds(dates, today)

  function fail(next: DraftErrors, field: 'value' | 'length') {
    flushSync(() => setErrors(next))
    document.getElementById(`${id}-${field}`)?.focus()
  }

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = readDraft(draft, readInfo, point === undefined)
    if (!parsed.ok) return fail(draftErrorsFor(parsed), parsed.field)
    if (parsed.point === null) return fail({ value: 'Enter where you are' }, 'value')
    // a cleared date falls back to the point's own day, else today (or a finished read's last day)
    const date = on === '' ? (point?.on ?? bounds.max) : on
    const editionId = volume === '' ? {} : { editionId: volume }
    if (point) update.mutate({ pointId: point.id, today, on: date, kind: parsed.point.kind, value: parsed.point.value, ...editionId })
    else add.mutate({ sessionId, today, on: date, ...parsed.point, ...editionId })
  }

  const serverError = add.error ?? update.error
  const pending = add.isPending || update.isPending
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent bare className="sm:max-w-sm">
        <DialogPanel
          title={point ? 'Edit progress' : 'Update progress'}
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-4">
            <Field label="Date" htmlFor={`${id}-on`}>
              <Input
                id={`${id}-on`}
                type="date"
                value={on}
                min={bounds.min}
                max={bounds.max}
                onChange={(e) => {
                  setOn(e.target.value)
                  add.reset()
                  update.reset()
                }}
              />
            </Field>
            {volumes !== null ? (
              <Field label="Volume" htmlFor={`${id}-volume`}>
                <NativeSelect
                  id={`${id}-volume`}
                  value={volume}
                  onChange={(e) => {
                    setVolume(e.target.value)
                    setDraft({ ...draft, length: '' })
                    setErrors({})
                    add.reset()
                    update.reset()
                  }}
                >
                  {volume === '' ? <option value="">Keep as is</option> : null}
                  {volumes.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <ProgressField
              id={id}
              info={readInfo}
              draft={draft}
              errors={errors}
              askLength={point === undefined}
              ownKind={point?.kind}
              onChange={(next) => {
                setDraft(next)
                setErrors({})
                add.reset()
                update.reset()
              }}
            />
            {serverError ? (
              <p role="alert" className="text-sm text-destructive">
                {serverError.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
