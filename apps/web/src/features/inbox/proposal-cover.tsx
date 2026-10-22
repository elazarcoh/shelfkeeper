import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import { useState } from 'react'
import { WorkCover } from '@/components/work-cover'
import { Button } from '@/components/ui/button'
import { CoverDialog } from '@/features/book/cover-dialog'
import { trpc, type RouterOutputs } from '@/lib/trpc'

type Entry = RouterOutputs['inbox']['mine']['items'][number]

/** #161: a cover photo for a book still in the Inbox; on Accept it becomes the new copy's cover. */
export function ProposalCover({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const remove = useMutation(trpc.shelf.setCover.mutationOptions({ onSettled: () => void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() }) }))
  const has = entry.coverAssetId !== null
  return (
    <div className="flex items-center gap-3">
      {has ? <WorkCover title={entry.item.title} coverAssetId={entry.coverAssetId} label={false} className="w-12 shrink-0" /> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Camera /> {has ? 'Change cover photo' : 'Cover photo'}
        </Button>
        {has ? (
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ proposalId: entry.id, imageBase64: null })}>
            Remove photo
          </Button>
        ) : null}
      </div>
      <CoverDialog target={{ kind: 'proposal', proposalId: entry.id }} open={open} onOpenChange={setOpen} />
    </div>
  )
}
