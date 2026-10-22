import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { trpc } from '@/lib/trpc'
import { countsLine } from './backup-view'

export function LastRestoreCard() {
  const last = useQuery(trpc.backups.lastRestore.queryOptions())
  const outcome = last.data
  if (!outcome) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last restore</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        {outcome.ok ? (
          <>
            <p>
              Restored {outcome.summary.backupName} on {new Date(outcome.summary.finishedAt).toLocaleString()}.
            </p>
            <p className="text-muted-foreground">{countsLine(outcome.summary.counts)}</p>
            {outcome.summary.migrationsApplied.length > 0 ? <p className="text-muted-foreground">Upgraded on the way: {outcome.summary.migrationsApplied.length} migration(s).</p> : null}
            {outcome.summary.unreadableSecrets > 0 ? (
              <div className="text-destructive">
                <p>
                  {outcome.summary.unreadableSecrets} source login{outcome.summary.unreadableSecrets === 1 ? '' : 's'} could not be read. Re-enter{' '}
                  {outcome.summary.unreadableSecrets === 1 ? 'it' : 'them'} in Admin → Sources.
                </p>
                {outcome.summary.unreadableSources && outcome.summary.unreadableSources.length > 0 ? (
                  <ul className="mt-1 grid gap-0.5">
                    {outcome.summary.unreadableSources.map((name, i) => (
                      <li key={`${name}-${i}`} dir="auto" className="break-words">
                        {name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {outcome.summary.workerPauseUnconfirmed === true ? (
              <p className="text-muted-foreground">The background worker did not confirm it paused in time; it may have kept working briefly during the restore.</p>
            ) : null}
            {outcome.summary.preRestoreBackup !== null ? <p className="text-muted-foreground">The state before the restore was saved as {outcome.summary.preRestoreBackup}.</p> : null}
          </>
        ) : (
          <p className="text-destructive" dir="auto">
            Restoring {outcome.backupName} failed ({new Date(outcome.at).toLocaleString()}): {outcome.error}. Nothing was changed.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
