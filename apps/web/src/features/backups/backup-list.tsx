import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { backupKindLabel, downloadHref, formatBytes } from './backup-view'
import { RestoreDialog } from './restore-dialog'

type Backup = RouterOutputs['backups']['list'][number]

function DeleteBackupDialog({ name }: { name: string }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const remove = useMutation(
    trpc.backups.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Backup deleted')
        setOpen(false)
        void queryClient.invalidateQueries({ queryKey: trpc.backups.pathKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.system.pathKey() })
      },
    }),
  )
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={remove.isPending}>
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete this backup?</DialogTitle>
          <DialogDescription className="break-words">{name} is removed from the backup folder. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ name })}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BackupList({ backups }: { backups: Backup[] }) {
  if (backups.length === 0) return <EmptyState title="No backups yet" hint="Use “Back up now”, or wait for the nightly backup." />
  return (
    <ul className="divide-y rounded-lg border">
      {backups.map((b) => (
        <li key={b.name} className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span>{new Date(b.createdAt).toLocaleString()}</span>
              <Badge variant="secondary">{backupKindLabel[b.kind]}</Badge>
              {/* only verified backups are ever renamed into place (plan deviation 10): every listed file is verified */}
              <Badge variant="outline">Verified</Badge>
            </p>
            <p className="break-words text-xs text-muted-foreground">
              {b.name} · {formatBytes(b.sizeBytes)} · version {b.appVersion}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={downloadHref(b.name)} download>
                Download
              </a>
            </Button>
            <RestoreDialog
              source={{ kind: 'file', name: b.name }}
              label={`the backup from ${new Date(b.createdAt).toLocaleString()}`}
              trigger={
                <Button size="sm" variant="outline">
                  Restore
                </Button>
              }
            />
            <DeleteBackupDialog name={b.name} />
          </div>
        </li>
      ))}
    </ul>
  )
}
