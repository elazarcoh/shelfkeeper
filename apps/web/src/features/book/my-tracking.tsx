import { useMutation, useQuery } from '@tanstack/react-query'
import { ListPlus, ListX, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { readingStatuses } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { focusAfterRemoval } from '@/components/removal-focus'
import { StarRating } from '@/components/star-rating'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { statusLabel } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'

type Work = RouterOutputs['catalog']['get']
type User = NonNullable<RouterOutputs['auth']['status']['user']>

const IN_SETS_LABEL_ID = 'my-sets-label'

export function MyTracking({ work, user }: { work: Work; user: User }) {
  const invalidate = useInvalidateBook()
  const opts = { onSuccess: invalidate }
  const pickStatus = useMutation(trpc.tracking.pickStatus.mutationOptions(opts))
  const setRating = useMutation(trpc.tracking.setRating.mutationOptions(opts))
  const queueAdd = useMutation(trpc.tracking.queueAdd.mutationOptions(opts))
  const queueRemove = useMutation(trpc.tracking.queueRemove.mutationOptions(opts))
  const addToSet = useMutation(trpc.sets.addWork.mutationOptions(opts))
  const removeFromSet = useMutation(trpc.sets.removeWork.mutationOptions(opts))
  const sets = useQuery(trpc.sets.mine.queryOptions())

  const editable = (sets.data ?? []).filter((s) => s.kind === 'manual' && (s.scope === 'personal' || user.role === 'admin'))
  const inSet = new Set(work.sets.map((s) => s.id))
  const addable = editable.filter((s) => !inSet.has(s.id))
  const canEdit = (setId: string) => editable.some((s) => s.id === setId)

  return (
    <Card className="gap-0">
      <CardContent className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Field label="Status" htmlFor="my-status">
          <NativeSelect
            id="my-status"
            value={work.me.status}
            onChange={(e) => {
              const status = readingStatuses.find((s) => s === e.target.value)
              if (status) pickStatus.mutate({ workId: work.id, status })
            }}
          >
            {readingStatuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <div className="grid gap-1.5">
          <span className="text-sm font-medium">My rating</span>
          <div className="flex flex-wrap items-center gap-2">
            <StarRating value={work.me.rating} onChange={(rating) => setRating.mutate({ workId: work.id, rating })} />
            {work.me.rating !== null ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const previous = work.me.rating
                  setRating.mutate(
                    { workId: work.id, rating: null },
                    {
                      onSuccess: () => {
                        if (previous === null) return
                        toast('Rating cleared', {
                          action: { label: 'Undo', onClick: () => setRating.mutate({ workId: work.id, rating: previous }) },
                        })
                      },
                    },
                  )
                }}
              >
                Clear rating
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center">
          {work.me.inQueue ? (
            <Button variant="secondary" onClick={() => queueRemove.mutate({ workId: work.id })}>
              <ListX className="size-4" /> Remove from Up next
            </Button>
          ) : (
            <Button variant="outline" onClick={() => queueAdd.mutate({ workId: work.id })}>
              <ListPlus className="size-4" /> Add to Up next
            </Button>
          )}
        </div>

        {/* grid-cols-1 (minmax(0,1fr)): an auto track grows to a long set name, so the chip could not truncate */}
        <div className="grid grid-cols-1 gap-1.5">
          {/* tabIndex -1: where focus lands when the last set chip's ✕ removes it */}
          <span id={IN_SETS_LABEL_ID} tabIndex={-1} className="justify-self-start rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            In sets
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {work.sets.map((s) => (
              // overflow-visible: the badge would otherwise clip the ✕'s 44px touch area; the name truncates on its own
              <Badge key={s.id} variant="secondary" className="max-w-full gap-1 overflow-visible">
                <span className="min-w-0 truncate" dir="auto">
                  {s.name}
                </span>
                {canEdit(s.id) ? (
                  <button
                    type="button"
                    aria-label={`Remove from ${s.name}`}
                    className="-me-1 rounded-full pointer-coarse:touch-hit"
                    data-set-chip-remove
                    onClick={(e) => {
                      // the chip goes: the next chip's ✕, else the "In sets" label
                      const restore = focusAfterRemoval(e.currentTarget, '[data-set-chip-remove]', IN_SETS_LABEL_ID)
                      removeFromSet.mutate({ setId: s.id, workId: work.id }, { onError: restore })
                    }}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </Badge>
            ))}
            {addable.length > 0 ? (
              <NativeSelect
                aria-label="Add to set"
                // a select is as wide as its longest option: max-w-full keeps a long set name inside the column
                className="h-8 w-auto max-w-full"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') addToSet.mutate({ setId: e.target.value, workId: work.id })
                }}
              >
                <option value="">Add to set…</option>
                {addable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </div>
        </div>

        <ReviewBox key={work.id} work={work} />
      </CardContent>
    </Card>
  )
}

function ReviewBox({ work }: { work: Work }) {
  const invalidate = useInvalidateBook()
  const [text, setText] = useState(work.me.review ?? '')
  const save = useMutation(
    trpc.tracking.setReview.mutationOptions({
      onSuccess: () => {
        invalidate()
        toast.success('Notes saved')
      },
    }),
  )
  const dirty = text !== (work.me.review ?? '')
  return (
    <div className="grid gap-1.5 sm:col-span-2">
      <Label htmlFor="my-review">My notes</Label>
      <Textarea id="my-review" rows={3} dir="auto" placeholder="What did you think?" value={text} onChange={(e) => setText(e.target.value)} />
      {dirty ? (
        <Button size="sm" className="justify-self-start" onClick={() => save.mutate({ workId: work.id, review: text.trim() === '' ? null : text })}>
          Save notes
        </Button>
      ) : null}
    </div>
  )
}
