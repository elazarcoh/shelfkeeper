import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { BackupList } from '@/features/backups/backup-list'
import { cloudLine } from '@/features/backups/backup-view'
import { LastRestoreCard } from '@/features/backups/last-restore-card'
import { SettingsCard } from '@/features/backups/settings-card'
import { UploadCard } from '@/features/backups/upload-card'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/admin/backups')({ component: BackupsPage })

const REFRESH_MS = 10_000

function BackupsPage() {
  const queryClient = useQueryClient()
  const status = useQuery({ ...trpc.system.status.queryOptions(), refetchInterval: REFRESH_MS })
  const backups = useQuery({ ...trpc.backups.list.queryOptions(), refetchInterval: REFRESH_MS })
  const runNow = useMutation(
    trpc.backups.runNow.mutationOptions({
      onSuccess: () => {
        toast.success('Backup started. It appears below once it is verified.')
        void queryClient.invalidateQueries({ queryKey: trpc.system.pathKey() })
      },
    }),
  )
  const last = status.data?.lastBackup ?? null
  const cloud = status.data === undefined ? null : cloudLine(status.data.cloud)
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm text-muted-foreground">
          {last === null ? 'No backup yet.' : `Last successful backup: ${new Date(last.createdAt).toLocaleString()}.`}
          {status.data?.backupRunning === true ? ' A backup is running now.' : ''}
        </p>
        <Button size="sm" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
          Back up now
        </Button>
      </div>
      {status.data?.lastFailure ? (
        <p className="wrap-anywhere text-sm text-destructive" dir="auto">
          The last backup failed ({new Date(status.data.lastFailure.at).toLocaleString()}): {status.data.lastFailure.error}
        </p>
      ) : null}
      {cloud === null ? null : (
        <p className={cn('wrap-anywhere text-sm', cloud.tone === 'error' ? 'text-destructive' : cloud.tone === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')} dir="auto">
          {cloud.text}
        </p>
      )}
      <BackupList backups={backups.data ?? []} />
      <LastRestoreCard />
      <UploadCard />
      <SettingsCard />
      <p className="text-xs text-muted-foreground">Backups contain the key that unlocks saved source logins. Keep downloaded copies private.</p>
    </div>
  )
}
