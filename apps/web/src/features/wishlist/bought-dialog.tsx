import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ShoppingBag } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { editionFormats, type EditionFormat, type WishRow } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatLabel, todayLocal } from '@/lib/format'
import { trpc, trpcClient } from '@/lib/trpc'
import { boughtVolumeChoices } from './bought-state'
import { invalidateWishes } from './wish-dialog'

const initialFormat = (w: WishRow): EditionFormat => (w.formats.length === 1 && w.formats[0] !== undefined ? w.formats[0] : 'physical')

/** "Bought": the wish becomes an owned copy in the chosen format (the page's details pre-fill it), then you land on the book. */
export function BoughtDialog({ wish }: { wish: WishRow }) {
  const id = useId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<EditionFormat>(initialFormat(wish))
  const [on, setOn] = useState(todayLocal())
  const choices = boughtVolumeChoices(wish, format)
  /** a missing volume number, or null for "Not a volume" */
  const [volume, setVolume] = useState<number | null>(choices[0] ?? null)

  const bought = useMutation(
    trpc.wishlist.bought.mutationOptions({
      onSuccess: async (res) => {
        // the one cover download, once per press; a failed cover is silent
        if (res.coverUrl !== null) await trpcClient.catalog.setCoverFromPage.mutate({ editionId: res.editionId, coverUrl: res.coverUrl }).catch(() => undefined)
        invalidateWishes(queryClient)
        setOpen(false)
        toast.success('Added to your library')
        void navigate({ to: '/books/$workId', params: { workId: res.workId } })
      },
      meta: { inlineError: true },
    }),
  )

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFormat(initialFormat(wish))
      setOn(todayLocal())
      setVolume(boughtVolumeChoices(wish, initialFormat(wish))[0] ?? null)
      bought.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="pointer-coarse:min-h-11">
          <ShoppingBag className="size-4" /> Bought
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-sm">
        <DialogPanel
          title="Bought it"
          description={
            <span className="block break-words text-match-parent" dir="auto">
              {wish.title}
            </span>
          }
          onSubmit={(e) => {
            e.preventDefault()
            if (!bought.isPending) bought.mutate({ workId: wish.workId, format, on, volume: choices.length > 0 ? volume : null })
          }}
          footer={
            <Button type="submit" disabled={bought.isPending || on === ''}>
              Bought
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-4">
            <div role="radiogroup" aria-label="Format" className="flex flex-wrap gap-2">
              {editionFormats.map((f) => (
                <Button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  variant={format === f ? 'default' : 'outline'}
                  className="pointer-coarse:min-h-11"
                  onClick={() => {
                    setFormat(f)
                    setVolume(boughtVolumeChoices(wish, f)[0] ?? null)
                  }}
                >
                  {formatLabel[f]}
                </Button>
              ))}
            </div>
            {choices.length > 0 ? (
              <div className="grid gap-1.5">
                <span id={`${id}-volume`} className="text-sm font-medium">
                  Which volume?
                </span>
                <div role="radiogroup" aria-labelledby={`${id}-volume`} className="flex flex-wrap gap-2">
                  {choices.map((n) => (
                    <Button key={n} type="button" role="radio" aria-checked={volume === n} variant={volume === n ? 'default' : 'outline'} className="pointer-coarse:min-h-11" onClick={() => setVolume(n)}>
                      Vol {n}
                    </Button>
                  ))}
                  <Button type="button" role="radio" aria-checked={volume === null} variant={volume === null ? 'default' : 'outline'} className="pointer-coarse:min-h-11" onClick={() => setVolume(null)}>
                    Not a volume
                  </Button>
                </div>
              </div>
            ) : null}
            <Field label="Date" htmlFor={`${id}-on`}>
              <Input id={`${id}-on`} type="date" value={on} max={todayLocal()} onChange={(e) => setOn(e.target.value)} />
            </Field>
            {bought.error ? (
              <p role="alert" className="text-sm text-destructive">
                {bought.error.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
