import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { backupKindLabel, formatBytes, workerLine } from '@/features/backups/backup-view'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/system')({ component: SystemPage })

function SystemPage() {
  const status = useQuery({ ...trpc.system.status.queryOptions(), refetchInterval: 30_000 })
  const s = status.data
  if (!s) return null
  return (
    // phones stack each label over its value: a value sits close under its label, and further from the next label (#9)
    <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 rounded-lg border p-4 text-sm sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-y-3 [&>dt:not(:first-child)]:max-sm:mt-3">
      <dt className="text-muted-foreground">App version</dt>
      <dd className="break-words">{s.version}</dd>
      <dt className="text-muted-foreground">Last backup</dt>
      <dd className="break-words">
        {s.lastBackup === null
          ? 'None yet'
          : // only verified backups are ever renamed into place (plan deviation 10): every listed file is verified
            `${new Date(s.lastBackup.createdAt).toLocaleString()} (${backupKindLabel[s.lastBackup.kind]}, ${formatBytes(s.lastBackup.sizeBytes)}, verified)`}
      </dd>
      <dt className="text-muted-foreground">Free space, data</dt>
      <dd className={s.lowDisk ? 'text-destructive' : undefined}>{formatBytes(s.freeBytes.data)}</dd>
      <dt className="text-muted-foreground">Free space, backups</dt>
      <dd>{formatBytes(s.freeBytes.backups)}</dd>
      <dt className="text-muted-foreground">Worker</dt>
      <dd className="break-words">{workerLine(s.worker)}</dd>
    </dl>
  )
}
