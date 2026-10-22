import { useId, type ReactNode } from 'react'
import { DialogPanel } from '@/components/dialog-panel'
import { StarRating } from '@/components/star-rating'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import type { QuickAction, SetAction } from './quick-action-model'
import type { QuickActions } from './use-quick-actions'
import type { SeriesQuickActions } from './use-series-quick-actions'

interface Props {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: QuickActions
}

/** The bottom sheet's frame, shared by work, series and Series continuation cards. */
export function SheetFrame({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-md">
        <DialogPanel
          title={title}
          footer={
            <DialogClose asChild>
              <Button variant="outline">Done</Button>
            </DialogClose>
          }
        >
          {children}
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}

/** The sheet's "Sets" section: checkboxes that keep the sheet open. */
function SheetSets({ sets, pending, run }: { sets: SetAction[] | 'loading' | null; pending: (id: string) => boolean; run: (action: SetAction) => void }) {
  const setsId = useId()
  if (sets === null) return null
  return (
    <section aria-labelledby={setsId} className="grid gap-1">
      <h3 id={setsId} className="text-sm font-medium">
        Sets
      </h3>
      {sets === 'loading' ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        sets.map((a) => (
          <label key={a.id} className="flex min-h-11 min-w-0 items-center gap-3">
            <Checkbox checked={a.checked} disabled={pending(a.id)} onCheckedChange={() => run(a)} />
            <span className="min-w-0 truncate" dir="auto">
              {a.label}
            </span>
          </label>
        ))
      )}
    </section>
  )
}

/** Touch: the quick actions in a bottom sheet. Reading and Up next close it; rating and sets keep it open. */
export function QuickActionsSheet({ title, open, onOpenChange, actions }: Props) {
  const { model, run, rate, pending } = actions
  const ratingId = useId()
  const button = (a: QuickAction, closes: boolean) => (
    <Button
      key={a.id}
      variant="ghost"
      className="justify-start"
      disabled={a.kind === 'loading' || pending(a.id)}
      onClick={() => {
        run(a)
        if (closes) onOpenChange(false)
      }}
    >
      {a.label}
    </Button>
  )
  return (
    <SheetFrame title={title} open={open} onOpenChange={onOpenChange}>
      <div className="grid gap-5">
        <div className="grid">
          {model.reading.map((a) => button(a, true))}
          {button(model.queue, true)}
        </div>
        <section aria-labelledby={ratingId} className="grid gap-1.5">
          <h3 id={ratingId} className="text-sm font-medium">
            My rating
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <StarRating value={model.rating.value} onChange={rate} />
            {model.rating.clear !== null ? button(model.rating.clear, false) : null}
          </div>
        </section>
        <SheetSets sets={model.sets} pending={pending} run={run} />
        {model.merge !== null ? <div className="grid">{button(model.merge, true)}</div> : null}
      </div>
    </SheetFrame>
  )
}

/** Touch: a series card's quick actions. Up next and Mark all as read close the sheet; the sets keep it open. */
export function SeriesQuickActionsSheet({ title, open, onOpenChange, actions }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; actions: SeriesQuickActions }) {
  const { model, run, pending } = actions
  const kindId = useId()
  return (
    <SheetFrame title={title} open={open} onOpenChange={onOpenChange}>
      <div className="grid gap-5">
        <div className="grid">
          {model.main.map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              className="justify-start"
              disabled={a.kind === 'loading' || a.kind === 'info' || pending(a.id)}
              onClick={() => {
                run(a)
                onOpenChange(false)
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
        <section aria-labelledby={kindId} className="grid gap-1">
          <h3 id={kindId} className="text-sm font-medium">
            {model.markAs.label}
          </h3>
          <div className="grid">
            {model.markAs.options.map((o) => (
              <Button
                key={o.id}
                variant="ghost"
                className="justify-start"
                disabled={pending(o.id)}
                onClick={() => {
                  run(o)
                  onOpenChange(false)
                }}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </section>
        <SheetSets sets={model.sets} pending={pending} run={run} />
      </div>
    </SheetFrame>
  )
}
